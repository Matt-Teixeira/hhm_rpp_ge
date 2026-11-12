#!/usr/bin/env node
"use strict";
// Manual GE CV insight commands (PLAN-CV-INSIGHTS.md §4 CV-2).
//   node insight/cv/cli.js dry-run [--to-id N]
//       READ-ONLY. Classify every log.ge_cv_syserror row up to N (default:
//       the current max id), print facts per (system, metric) against the
//       independent SQL, coverage (relay / counted / unstorable), rule
//       errors, codes not yet reviewed, and source repeats.
//   node insight/cv/cli.js backfill --rehearse [--batches N]
//       As insight_writer, ONE transaction, rolled back: sync the cv.*
//       catalog, extract (all batches, or N), a second pass to prove
//       idempotency, and verify on the uncommitted facts. Writes nothing.
//   node insight/cv/cli.js backfill --apply [--from-id N] [--to-id N]
//       As insight_writer: per batch, upsert facts + advance the
//       ge_cv_extract watermark + record touched days, in one transaction.
//       Resumes from the watermark. Refused until plan §7.4 C1 and C2 are
//       done. Run verify afterwards.
//   node insight/cv/cli.js verify
//       READ-ONLY. The CV-2 exit check over the watermark range.
//   node insight/cv/cli.js derive --rehearse
//       As insight_writer, ONE transaction, rolled back: full rebuild of
//       ge_cv_daily and ge_cv_codes, a second identical pass, a touched-days
//       pass (must equal the full rebuild), verify-derive on the
//       uncommitted rows. Writes nothing.
//   node insight/cv/cli.js derive --apply [--full]
//       As insight_writer: the days the extract recorded as pending (or
//       every system with --full), one transaction per system, then the
//       code labels. Run verify-derive afterwards.
//   node insight/cv/cli.js verify-derive
//       READ-ONLY. The CV-3 exit check (verify_derive.js).
//   node insight/cv/cli.js findings --rehearse [--replay] [--system S]
//       As insight_writer, ONE transaction, rolled back (findings/run.js):
//       findings as of today (pass 1), the same again (idempotency), after
//       --replay a default pass, incremental consistency (replay as of
//       today-28, then default runs a week apart), verify-findings on the
//       uncommitted rows; prints the findings. Writes nothing.
//   node insight/cv/cli.js findings --apply [--replay] [--system S]
//       As insight_writer: the cv_* catalog, then one transaction per
//       system; job_state 'ge_cv_findings' on fleet-wide runs. --replay
//       rebuilds the history. Refused until migration 008 (plan §10.5 C3)
//       and C1 are done, and while derive has pending days. Run
//       verify-findings after.
//   node insight/cv/cli.js verify-findings
//       READ-ONLY. The CV-4 exit check (findings/verify.js) at each system's
//       recorded as-of date.
//   node insight/cv/cli.js stage --rehearse
//       As insight_writer, ONE transaction, rolled back (stage.js, plan
//       §12.2 item 6): the CV-5 stage as GE_CV would run it on the pending
//       range (catch-up, the last run's rows, a run with no rows), then
//       verify, verify-derive, verify-findings on the uncommitted data,
//       derive touched = full rebuild, findings default = replay, CT rows
//       unchanged; the watermarks are read again after the rollback. Asks
//       for the database name first (§12.3 Q6). Writes nothing.
// Nothing in the GE CT run loads this file.
const crypto = require("crypto");
const readline = require("readline");
const { validate } = require("./rules");
const { stream } = require("./extract");
const { RECONCILE_SQL, COVERAGE_SQL, REPEATS_SQL } = require("./reconcile_sql");
const { run_extract, read_job, unreviewed } = require("./load");
const { verify_cv_facts, compare } = require("./verify");
const { run_derive } = require("./derive");
const { verify_cv_derive } = require("./verify_derive");
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
      const v = argv[++i];
      if (v === undefined || !/^[A-Z0-9_]+$/.test(v)) throw new Error("--system needs a system id");
      a.system = v;
    }
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  if (!["dry-run", "backfill", "verify", "derive", "verify-derive", "findings", "verify-findings", "stage"].includes(a.cmd)) {
    throw new Error("usage: cli.js dry-run [--to-id N] | backfill --rehearse [--batches N] | backfill --apply [--from-id N] [--to-id N] | verify | derive --rehearse | derive --apply [--full] | verify-derive | findings --rehearse|--apply [--replay] [--system S] | verify-findings | stage --rehearse");
  }
  if (a.cmd === "stage") {
    // the live stage runs only from index.js (GE_CV); the CLI only rehearses it
    if (!a.rehearse || a.apply || a.from_id !== null || a.to_id !== null || a.batches !== null || a.full || a.replay || a.system) throw new Error("stage takes only --rehearse");
    return a;
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
  if (a.cmd === "verify-derive" && (a.from_id !== null || a.to_id !== null || a.batches !== null || a.rehearse || a.apply)) throw new Error("verify-derive takes no flags");
  if (a.cmd === "backfill" && a.rehearse === a.apply) throw new Error("backfill needs exactly one of --rehearse / --apply");
  if (a.cmd === "backfill" && a.rehearse && (a.from_id !== null || a.to_id !== null)) throw new Error("backfill --rehearse takes only --batches");
  if (a.cmd === "backfill" && a.apply && a.batches !== null) throw new Error("--batches is only for --rehearse");
  if (a.cmd !== "backfill" && (a.from_id !== null || a.batches !== null || a.rehearse || a.apply)) throw new Error(`${a.cmd} takes only --to-id`);
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
  const to = to_id ?? Number((await db.one("SELECT coalesce(max(id), 0) AS m FROM log.ge_cv_syserror")).m);
  const per = new Map();
  const ignored = {};
  const skipped = {};
  const codes = new Set();
  const rule_errors = [];
  let rows = 0, facts = 0;
  await stream(db, { from_id: 0, to_id: to, on_batch: async ({ rows: r, built }) => {
    rows += r.length;
    facts += built.facts.length;
    rule_errors.push(...built.errors);
    for (const c of built.codes) codes.add(c);
    for (const [k, v] of Object.entries(built.ignored)) ignored[k] = (ignored[k] || 0) + v;
    for (const [k, v] of Object.entries(built.skipped)) if (v) skipped[k] = (skipped[k] || 0) + v;
    for (const f of built.facts) { const k = `${f.system_id}|${f.metric_key}`; per.set(k, (per.get(k) || 0) + 1); }
  } });
  const facts_rows = [...per].map(([k, n]) => { const [system_id, key] = k.split("|"); return { system_id, key, n }; });
  const sql = await db.any(RECONCILE_SQL, [0, to, null]);
  const { cells, diffs } = compare(facts_rows, sql);
  const cov = await db.one(COVERAGE_SQL, [0, to, null]);
  const repeats = await db.any(REPEATS_SQL, [0, to, null]);
  const by_metric = {};
  for (const r of facts_rows) by_metric[r.key] = (by_metric[r.key] || 0) + r.n;
  const coverage = {
    rows: cov.rows, relay: cov.relay, counted: cov.counted, unstorable: cov.unstorable,
    js: { rows, ignored, skipped, cv_error: by_metric["cv.error"] || 0 },
    agree: rows === cov.rows && (ignored.rta_relay || 0) === cov.relay && (by_metric["cv.error"] || 0) === cov.counted,
  };
  return {
    to, rows, facts, cells, diffs, by_metric, coverage, rule_errors: rule_errors.length, rule_error_samples: rule_errors.slice(0, 5),
    codes: codes.size, unreviewed_codes: unreviewed(codes), source_repeats: repeats.length,
    ok: !diffs.length && !rule_errors.length && coverage.agree,
  };
}

// READ-ONLY: the CV-3 exit check.
async function verify_derive(db) {
  await assert_read_only(db);
  return db.tx((t) => verify_cv_derive(t));
}

// READ-ONLY: the CV-4 exit check, each system at its recorded as-of date.
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

// READ-ONLY: the exit check over the watermark range.
async function verify(db) {
  await assert_read_only(db);
  const job = await read_job(db);
  if (!job) throw new Error("no ge_cv_extract watermark: run `backfill --apply` first");
  return db.tx((t) => verify_cv_facts(t, Number(job.watermark_id)));
}

function print(o) { console.log(JSON.stringify(o, null, 2)); }

// The database name, typed, before the stage rehearsal (as CT's cli.js).
async function confirm(db) {
  const t = await db.one("SELECT current_database() AS db, current_user AS usr");
  console.log(`target: database=${t.db} host=${process.env.PG_HOST} user=${t.usr} — STAGE REHEARSAL (one transaction, rolled back)`);
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  const it = rl[Symbol.asyncIterator]();
  try {
    process.stdout.write("Type the database name to continue: ");
    const { value, done } = await it.next();
    if (done) throw new Error("no input: aborted");
    if (!process.stdin.isTTY) console.log(value);
    if (value.trim() !== t.db) throw new Error("database name mismatch: aborted");
  } finally {
    rl.close();
  }
}

async function main() {
  const a = args(process.argv.slice(2));
  const { connect } = require("../db");
  if (a.cmd === "dry-run" || a.cmd === "verify" || a.cmd === "verify-derive" || a.cmd === "verify-findings") {
    const db = connect("readonly", { statementTimeoutMs: 900000, applicationName: "insight_cv" });
    try {
      const r = a.cmd === "dry-run" ? await dry_run(db, a) : a.cmd === "verify" ? await verify(db)
        : a.cmd === "verify-derive" ? await verify_derive(db) : await verify_findings(db, { log: (s) => console.log(s) });
      if (a.cmd === "verify-findings") console.log(`verify-findings (read-only): ${r.ok ? "PASS" : "FAIL"}; as of ${r.today}; per-system as-of ${JSON.stringify(r.as_of_by_system)}`);
      else print(r);
      if (!r.ok) process.exitCode = 1;
    } finally { db.$pool.end(); }
    return;
  }
  const db = connect("writer", { statementTimeoutMs: 900000, applicationName: "insight_cv" });
  if (a.cmd === "stage") {
    try {
      await confirm(db);
      const { rehearse_stage } = require("./stage");
      const t0 = Date.now();
      const r = await rehearse_stage(db, { log: (s) => console.log(s) });
      if (r.skipped) { console.log(`skipped: ${r.skipped}`); process.exitCode = 1; return; }
      const { runs, ...rest } = r;
      print({ ok: r.ok, rolled_back: r.rolled_back, watermarks_unchanged_after_rollback: r.watermarks_unchanged_after_rollback, checks: rest.checks,
        runs: runs.map((x) => ({ label: x.label, ok: x.ok, ms: x.ms, warnings: x.warnings })), total_ms: Date.now() - t0 });
      console.log(`stage rehearsal: ${r.ok ? "overall: OK" : "overall: FAILED"} (rolled back)`);
      if (!r.ok) process.exitCode = 1;
    } finally { db.$pool.end(); }
    return;
  }
  if (a.cmd === "findings") {
    try {
      const r = await run_findings(db, { mode: a.apply ? "apply" : "rehearse", replay: a.replay, systems: a.system ? [a.system] : null,
        today: utc_today(), run_id: crypto.randomUUID(), log: (s) => console.log(s) });
      const { rows, ...rest } = r;
      print(rest);
      if (rows) for (const x of rows) console.log(`  ${x.system_id} ${x.finding_key.padEnd(24)} ${x.severity.padEnd(6)} ${x.status.padEnd(8)} opened ${x.evidence.opened_day} last trip ${x.evidence.last_trip_day} ${x.status === "resolved" ? `resolved ${x.evidence.resolved_day}` : `data through ${x.data_through}`} trips ${x.evidence.trip_days}`);
      if (r.skipped || (r.rolled_back && !r.ok)) process.exitCode = 1;
    } finally { db.$pool.end(); }
    return;
  }
  if (a.cmd === "derive") {
    try {
      const { pgp } = require("../db");
      const r = await run_derive(db, pgp, { mode: a.rehearse ? "rehearse" : "apply", full: a.full, run_id: crypto.randomUUID(), verify: verify_cv_derive, log: (s) => console.log(s) });
      print(r);
      const bad = r.skipped || (r.rolled_back && (!r.second_pass_identical || !r.touched_days_identical || !(r.verified && r.verified.ok)));
      if (bad) process.exitCode = 1;
    } finally { db.$pool.end(); }
    return;
  }
  try {
    const run_id = crypto.randomUUID();
    const r = await run_extract(db, {
      mode: a.rehearse ? "rehearse" : "apply", from_id: a.from_id, to_id: a.to_id, max_batches: a.batches, run_id,
      verify: verify_cv_facts, log: (s) => console.log(s),
    });
    print(r);
    if (r.skipped || (r.verified && !r.verified.ok) || (r.rolled_back && !a.batches && r.second_pass_upserted !== 0)) process.exitCode = 1;
  } finally { db.$pool.end(); }
}

if (require.main === module) main().catch((e) => { console.error(`FAILED: ${e.message}`); process.exitCode = 2; });

module.exports = { args, dry_run, verify, verify_derive, verify_findings };
