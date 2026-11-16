#!/usr/bin/env node
"use strict";
// Manual GE MRI insight commands (PLAN-MRI-INSIGHTS.md §4 MRI-2).
//   node insight/mri/cli.js dry-run [--to-id N]
//       READ-ONLY. Classify every log.ge_mri_gesys row up to N (default:
//       the current max id), dedupe on the natural key, and print facts per
//       (system, metric), mri.error per (system, code) and the scan sums
//       against the independent SQL; coverage (counted / duplicate /
//       unstorable), natural-key conflicts, rule errors, codes not yet
//       reviewed. Writes nothing; needs no confirmation.
//   node insight/mri/cli.js backfill --rehearse [--batches N]
//       Asks for the database name. As insight_writer, ONE transaction,
//       rolled back: sync the mri.* catalog, extract (all batches, or N), a
//       second pass to prove idempotency, and verify on the uncommitted
//       facts. Writes nothing.
//   node insight/mri/cli.js backfill --apply [--from-id N] [--to-id N]
//       Asks for the database name, then APPLY. As insight_writer: per
//       batch, the conflict check, upsert facts, advance the ge_mri_extract
//       watermark and record touched days, in one transaction. Resumes from
//       the watermark. Refused until plan §6.4 C1-MRI and C2-MRI are done
//       and migration 009 is applied. Run verify afterwards.
//   node insight/mri/cli.js verify
//       READ-ONLY. The MRI-2 exit check over the watermark range.
//   node insight/mri/cli.js derive --rehearse
//       Asks for the database name. As insight_writer, ONE transaction,
//       rolled back: full rebuild of ge_mri_daily and ge_mri_codes, a
//       second identical pass, a touched-days pass (must equal the full
//       rebuild), verify-derive on the uncommitted rows. Writes nothing.
//   node insight/mri/cli.js derive --apply [--full]
//       Asks for the database name, then APPLY. As insight_writer: the days
//       the extract recorded as pending (or every system with --full), one
//       transaction per system, then the code labels. Run verify-derive after.
//   node insight/mri/cli.js verify-derive
//       READ-ONLY. The MRI-3 exit check (verify_derive.js).
//   node insight/mri/cli.js findings --rehearse [--replay] [--system S]
//       Asks for the database name. As insight_writer, ONE transaction,
//       rolled back (findings/run.js): findings as of today (pass 1), the
//       same again (idempotency), after a replay a default pass, incremental
//       consistency (replay as of today-28, then default runs a week apart),
//       verify-findings on the uncommitted rows; prints the findings.
//   node insight/mri/cli.js findings --apply [--replay] [--system S]
//       Asks for the database name, then APPLY. As insight_writer: the
//       mri_* catalog, one transaction per system, job_state
//       'ge_mri_findings' on fleet-wide runs. Refused until C1-MRI (plan
//       §6.4) and while derive is behind. Run verify-findings after.
//   node insight/mri/cli.js verify-findings
//       READ-ONLY. The MRI-4 exit check (findings/verify.js), each system at
//       its recorded as-of date.
// Nothing in the GE CT or CV run loads this file.
const crypto = require("crypto");
const readline = require("readline");
const { validate } = require("./rules");
const { stream } = require("./extract");
const { run_extract, read_job, unreviewed } = require("./load");
const { verify_mri_facts, compare, expected } = require("./verify");
const { run_derive } = require("./derive");
const { verify_mri_derive } = require("./verify_derive");
const { run_findings, JOB: FINDINGS_JOB } = require("./findings/run");
const { run_verify: run_verify_findings } = require("./findings/verify");

const utc_today = () => new Date().toISOString().slice(0, 10);

function args(argv) {
  const a = { cmd: argv[0], from_id: null, to_id: null, rehearse: false, apply: false, batches: null, full: false, replay: false, system: null };
  const int = (i) => {
    const v = argv[i + 1];
    if (v === undefined || !/^\d+$/.test(v)) throw new Error(`${argv[i]} needs a non-negative integer`);
    return Number(v);
  };
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === "--from-id") a.from_id = int(i++);
    else if (argv[i] === "--to-id") a.to_id = int(i++);
    else if (argv[i] === "--batches") a.batches = int(i++);
    else if (argv[i] === "--rehearse") a.rehearse = true;
    else if (argv[i] === "--apply") a.apply = true;
    else if (argv[i] === "--full") a.full = true;
    else if (argv[i] === "--replay") a.replay = true;
    else if (argv[i] === "--system") {
      const v = argv[i + 1];
      if (v === undefined || !/^[A-Z0-9_]+$/.test(v)) throw new Error("--system needs a system id");
      a.system = v;
      i++;
    }
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  if (!["dry-run", "backfill", "verify", "derive", "verify-derive", "findings", "verify-findings"].includes(a.cmd)) {
    throw new Error("usage: cli.js dry-run [--to-id N] | backfill --rehearse [--batches N] | backfill --apply [--from-id N] [--to-id N] | verify | derive --rehearse | derive --apply [--full] | verify-derive | findings --rehearse|--apply [--replay] [--system S] | verify-findings");
  }
  if ((a.replay || a.system) && a.cmd !== "findings") throw new Error("--replay and --system are only for findings");
  if (a.cmd === "findings" || a.cmd === "verify-findings") {
    if (a.from_id !== null || a.to_id !== null || a.batches !== null || a.full) throw new Error(`${a.cmd} takes only --rehearse/--apply, --replay, --system`);
    if (a.cmd === "verify-findings" && (a.rehearse || a.apply)) throw new Error("verify-findings takes no flags");
    if (a.cmd === "findings" && a.rehearse === a.apply) throw new Error("findings needs exactly one of --rehearse / --apply");
    return a;
  }
  if (a.full && !(a.cmd === "derive" && a.apply)) throw new Error("--full is only for derive --apply");
  if (a.cmd === "derive") {
    if (a.rehearse === a.apply) throw new Error("derive needs exactly one of --rehearse / --apply");
    if (a.from_id !== null || a.to_id !== null || a.batches !== null) throw new Error("derive takes only --full (with --apply)");
    return a;
  }
  if (a.cmd === "verify-derive") {
    if (a.from_id !== null || a.to_id !== null || a.batches !== null || a.rehearse || a.apply) throw new Error("verify-derive takes no flags");
    return a;
  }
  if (a.cmd === "backfill") {
    if (a.rehearse === a.apply) throw new Error("backfill needs exactly one of --rehearse / --apply");
    if (a.rehearse && (a.from_id !== null || a.to_id !== null)) throw new Error("backfill --rehearse takes only --batches");
    if (a.apply && a.batches !== null) throw new Error("--batches is only for --rehearse");
    return a;
  }
  if (a.from_id !== null || a.batches !== null || a.rehearse || a.apply) throw new Error(`${a.cmd} takes only --to-id`);
  if (a.cmd === "verify" && a.to_id !== null) throw new Error("verify takes no flags (it checks the watermark range)");
  return a;
}

async function assert_read_only(db) {
  if ((await db.one("SHOW default_transaction_read_only")).default_transaction_read_only !== "on") throw new Error("not a read-only session");
}

// READ-ONLY: the rules over the source vs the independent SQL.
async function dry_run(db, { to_id = null } = {}) {
  const errs = validate();
  if (errs.length) throw new Error(`invalid rules: ${errs.join("; ")}`);
  await assert_read_only(db);
  return db.tx(async (t) => {
    const to = to_id ?? Number((await t.one("SELECT coalesce(max(id), 0) AS m FROM log.ge_mri_gesys")).m);
    const per = new Map();
    const dims = new Map();
    const sums = new Map();
    const skipped = {};
    const codes = new Set();
    const rule_errors = [];
    const conflicts = [];
    const seen = new Map(); // dedupe across batches
    let rows = 0, records = 0, duplicates = 0, facts = 0;
    const bump = (m, k, n = 1) => m.set(k, (m.get(k) || 0) + n);
    await stream(t, { from_id: 0, to_id: to, seen, on_batch: async ({ rows: r, built }) => {
      rows += r.length;
      records += built.records.length;
      duplicates += built.duplicates;
      facts += built.facts.length;
      rule_errors.push(...built.errors);
      conflicts.push(...built.conflicts);
      for (const c of built.codes) codes.add(c);
      for (const [k, v] of Object.entries(built.skipped)) if (v) skipped[k] = (skipped[k] || 0) + v;
      for (const f of built.facts) {
        bump(per, `${f.system_id}|${f.metric_key}`);
        if (f.metric_key === "mri.error") bump(dims, `${f.system_id}|${f.dim}`);
        if (f.metric_key === "mri.scans_ok") bump(sums, `${f.system_id}|ok`, f.value_num);
        if (f.metric_key === "mri.scans_failed") bump(sums, `${f.system_id}|failed`, f.value_num);
      }
    } });
    const rows_of = (m) => [...m].map(([k, n]) => { const i = k.indexOf("|"); return { system_id: k.slice(0, i), key: k.slice(i + 1), n }; });
    const want = await expected(t, to);
    const by_metric = compare(rows_of(per), want.metrics);
    const by_code = compare(rows_of(dims), want.dims);
    const scan_sums = compare(rows_of(sums), want.scans);
    const by_key = {};
    for (const r of rows_of(per)) by_key[r.key] = (by_key[r.key] || 0) + r.n;
    const unstorable = Object.values(skipped).reduce((s, v) => s + v, 0);
    const coverage = {
      sql: { rows: want.cov.rows, unstorable: want.cov.unstorable, counted: want.cov.counted, duplicates: want.cov.rows - want.cov.unstorable - want.cov.counted },
      js: { rows, unstorable, counted: records, duplicates, skipped, mri_error: by_key["mri.error"] || 0 },
    };
    coverage.agree = rows === want.cov.rows && unstorable === want.cov.unstorable && records === want.cov.counted && (by_key["mri.error"] || 0) === records;
    return {
      to, rows, records, duplicates, facts, by_key,
      by_metric: { cells: by_metric.cells, diffs: by_metric.diffs },
      by_code: { cells: by_code.cells, diffs: by_code.diffs.slice(0, 20), n_diffs: by_code.diffs.length },
      scan_sums: { cells: scan_sums.cells, diffs: scan_sums.diffs },
      coverage,
      conflicts: { js: conflicts.slice(0, 20), n_js: conflicts.length, sql: want.conflicts },
      rule_errors: rule_errors.length, rule_error_samples: rule_errors.slice(0, 5),
      codes: codes.size, unreviewed_codes: unreviewed(codes),
      ok: !by_metric.diffs.length && !by_code.diffs.length && !scan_sums.diffs.length && !rule_errors.length && coverage.agree
        && !conflicts.length && !want.conflicts.length,
    };
  });
}

// READ-ONLY: the exit check over the watermark range.
async function verify(db) {
  await assert_read_only(db);
  const job = await read_job(db);
  if (!job) throw new Error("no ge_mri_extract watermark: run `backfill --apply` first");
  return db.tx((t) => verify_mri_facts(t, Number(job.watermark_id)));
}

function print(o) { console.log(JSON.stringify(o, null, 2)); }

// READ-ONLY: the MRI-4 exit check, each system at its recorded as-of date.
async function verify_findings(db, { log = () => {} } = {}) {
  await assert_read_only(db);
  return db.tx(async (t) => {
    const job = await t.oneOrNone("SELECT last_run_status, last_run_finished_at, last_run_stats FROM insight.job_state WHERE job_name = $1", [FINDINGS_JOB]);
    const stats = (job && job.last_run_stats) || {};
    const today = stats.today || utc_today();
    return { job: job && { status: job.last_run_status, finished_at: job.last_run_finished_at }, today,
      as_of_by_system: stats.as_of_by_system || {}, ...(await run_verify_findings(t, { today, as_of_by_system: stats.as_of_by_system || {}, log })) };
  });
}

// READ-ONLY: the MRI-3 exit check.
async function verify_derive(db) {
  await assert_read_only(db);
  return db.tx((t) => verify_mri_derive(t));
}

// Typed confirmation before any writer-role run (rehearse: the database
// name; apply: the database name, then APPLY).
async function confirm(db, { mode, what = "BACKFILL", input = process.stdin, out = (s) => process.stdout.write(s) }) {
  const t = await db.one("SELECT current_database() AS db, current_user AS usr");
  out(`target: database=${t.db} host=${process.env.PG_HOST} user=${t.usr} — MRI ${what} ${mode === "apply" ? "APPLY (writes)" : "REHEARSAL (one transaction, rolled back)"}\n`);
  const rl = readline.createInterface({ input, terminal: false });
  const it = rl[Symbol.asyncIterator]();
  const ask = async (q) => {
    out(q);
    const { value, done } = await it.next();
    if (done) throw new Error("no input: aborted");
    if (!input.isTTY) out(`${value}\n`);
    return value.trim();
  };
  try {
    if ((await ask("Type the database name to continue: ")) !== t.db) throw new Error("database name mismatch: aborted");
    if (mode === "apply" && (await ask("Type APPLY to write: ")) !== "APPLY") throw new Error("not confirmed: aborted");
  } finally {
    rl.close();
  }
}

async function main() {
  const a = args(process.argv.slice(2));
  const { connect } = require("../db");
  if (a.cmd === "dry-run" || a.cmd === "verify" || a.cmd === "verify-derive" || a.cmd === "verify-findings") {
    const db = connect("readonly", { statementTimeoutMs: 900000, applicationName: "insight_mri" });
    try {
      if (a.cmd === "verify-findings") {
        const r = await verify_findings(db, { log: (s) => console.log(s) });
        console.log(`verify-findings (read-only): ${r.ok ? "PASS" : "FAIL"}; as of ${r.today}; per-system as-of ${JSON.stringify(r.as_of_by_system)}`);
        if (!r.ok) process.exitCode = 1;
        return;
      }
      const r = a.cmd === "dry-run" ? await dry_run(db, a) : a.cmd === "verify" ? await verify(db) : await verify_derive(db);
      print(r);
      if (!r.ok) process.exitCode = 1;
    } finally { db.$pool.end(); }
    return;
  }
  const db = connect("writer", { statementTimeoutMs: 900000, applicationName: "insight_mri" });
  if (a.cmd === "findings") {
    try {
      const mode = a.rehearse ? "rehearse" : "apply";
      await confirm(db, { mode, what: "FINDINGS" });
      const r = await run_findings(db, { mode, replay: a.replay, systems: a.system ? [a.system] : null,
        today: utc_today(), run_id: crypto.randomUUID(), log: (s) => console.log(s) });
      const { rows, ...rest } = r;
      print(rest);
      if (rows) for (const x of rows) console.log(`  ${x.system_id} ${x.finding_key.padEnd(26)} ${x.severity.padEnd(6)} ${x.status.padEnd(8)} opened ${x.evidence.opened_day} last trip ${x.evidence.last_trip_day} ${x.status === "resolved" ? `resolved ${x.evidence.resolved_day}` : `data through ${x.data_through}`} trips ${x.evidence.trip_days}`);
      if (r.skipped || (r.rolled_back && !r.ok)) process.exitCode = 1;
    } finally { db.$pool.end(); }
    return;
  }
  if (a.cmd === "derive") {
    try {
      const mode = a.rehearse ? "rehearse" : "apply";
      await confirm(db, { mode, what: "DERIVE" });
      const { pgp } = require("../db");
      const r = await run_derive(db, pgp, { mode, full: a.full, run_id: crypto.randomUUID(), verify: verify_mri_derive, log: (s) => console.log(s) });
      print(r);
      const bad = r.skipped || (r.rolled_back && (!r.second_pass_identical || !r.touched_days_identical || !(r.verified && r.verified.ok)));
      if (bad) process.exitCode = 1;
    } finally { db.$pool.end(); }
    return;
  }
  try {
    const mode = a.rehearse ? "rehearse" : "apply";
    await confirm(db, { mode });
    const r = await run_extract(db, {
      mode, from_id: a.from_id, to_id: a.to_id, max_batches: a.batches, run_id: crypto.randomUUID(),
      verify: verify_mri_facts, log: (s) => console.log(s),
    });
    print(r);
    if (r.skipped || (r.verified && !r.verified.ok) || (r.rolled_back && !a.batches && r.second_pass_upserted !== 0)) process.exitCode = 1;
  } finally { db.$pool.end(); }
}

if (require.main === module) main().catch((e) => { console.error(`FAILED: ${e.message}`); process.exitCode = 2; });

module.exports = { args, dry_run, verify, verify_derive, verify_findings, confirm };
