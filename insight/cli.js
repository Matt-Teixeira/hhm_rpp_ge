#!/usr/bin/env node
"use strict";
// Manual insight commands (PLAN-CT-INSIGHTS.md §6).
//   node insight/cli.js dry-run [--system SME..] [--from-id N] [--to-id N]
//       READ-ONLY. Run the rules over log.ge_ct_gesys, print fact counts,
//       reconciliation per (system, metric) against independent SQL, rule
//       errors, skipped rows, and the 30-day coverage criterion.
//   node insight/cli.js backfill --rehearse [--batches N] [--from-id N]
//       As insight_writer, in ONE transaction that is rolled back: sync the
//       catalog, upsert N batches (default 2), report. Writes nothing.
//   node insight/cli.js backfill --apply [--from-id N] [--to-id N]
//       As insight_writer: per batch, upsert facts + advance the watermark
//       in one transaction. Resumes from the watermark. Run off-peak.
//   node insight/cli.js derive --rehearse [--system SME.. | --systems A,B]
//       As insight_writer, ONE transaction, rolled back: full rebuild of the
//       derived tables (derived facts, daily, exams, tube segments,
//       capabilities, clock), a second pass to prove idempotency, and
//       verify-derive on the uncommitted data. Writes nothing.
//   node insight/cli.js derive --apply [--system SME.. | --systems A,B]
//       As insight_writer: one transaction per system, then clock and
//       insight.job_state 'ge_ct_derive'. Run verify-derive afterwards.
//   node insight/cli.js verify-derive
//       READ-ONLY. The Phase 3 exit checks (§13.3) against independent SQL.
//   node insight/cli.js findings --rehearse [--replay] [--system S | --systems A,B] [--report FILE]
//       As insight_writer, ONE transaction, rolled back: findings as of
//       today (pass 1), the same again (idempotency), after --replay a
//       default pass, the incremental-consistency check (replay as of
//       today-28, then default runs a week apart), verify-findings on the
//       uncommitted rows. --report writes the replayed list per rule with
//       its evidence (and FILE.json). Writes nothing to the database.
//   node insight/cli.js findings --apply [--replay] [--system S | --systems A,B]
//       As insight_writer: catalog, one transaction per system, then
//       insight.job_state 'ge_ct_findings'. --replay rebuilds the history;
//       without it only systems with data in the last 7 days are evaluated
//       and resolved findings are never rewritten. Run verify-findings after.
//   node insight/cli.js verify-findings
//       READ-ONLY. Every finding vs the independent SQL, as of the last
//       findings run's date (§14.4).
//   node insight/cli.js stage --rehearse
//       As insight_writer, ONE transaction, rolled back (§15.2 item 4): the
//       Phase 5 stage (insight/stage.js) as the ge_ct run would do it, on the
//       current pending range: a catch-up run up to the last ge_ct run, a
//       typical run (the last ge_ct run's rows), a run with the daily
//       all-systems findings pass; per-step times; then verify,
//       verify-derive and verify-findings on the uncommitted data, derive
//       touched = full rebuild, findings default = replay. Writes nothing.
//       (There is no `stage --apply`: the stage writes only from the ge_ct
//       run, with INSIGHT_ENABLED=true.)
//   node insight/cli.js verify
//       READ-ONLY. Facts per (system, metric) vs the independent count of
//       DISTINCT natural keys, over the watermark range. Derived metrics
//       (system.boot, tube.replacement) have no per-row count; they are
//       checked by verify-derive.
const { connect, pgp } = require("./db");
const { rules } = require("./rules/ge_ct");
const { validate_rules } = require("./rules/engine");
const { stream } = require("./extract");
const { RECONCILE_SQL } = require("./reconcile_sql");
const { verify_facts } = require("./verify_facts");
const { run_extract } = require("./load");
const readline = require("readline");
const crypto = require("crypto");
const { ignore } = require("./rules/ge_ct_ignore");
const { derived_rules, DERIVED_KEYS } = require("./rules/ge_ct_derived");
const { run_derive, COUNTS_SQL } = require("./derive/run");
const { run_verify } = require("./derive/verify");
const { run_findings, COUNTS_SQL: FINDINGS_COUNTS_SQL } = require("./findings/run");
const { run_verify: run_verify_findings } = require("./findings/verify");
const { format_report } = require("./findings/report");
const { rehearse_stage } = require("./stage");
const fs = require("fs");

const RECENT_MS = 30 * 24 * 3600 * 1000;
const COVERAGE_THRESHOLD = 500; // rows per template per 30 days (§8)
const ignored = (proc, msg) => ignore.find((i) => (!i.process || i.process === proc) && i.re.test(msg || ""));

function args(argv) {
  const a = { cmd: argv[0], system: null, from_id: null, to_id: null, rehearse: false, apply: false, batches: 2, replay: false, report: null };
  // A flag that takes a value must get one: a missing value must never widen
  // the scope (e.g. `derive --apply --system` becoming fleet-wide; review
  // PHASE3-RUN-VERIFY F1).
  const value = (i) => {
    const v = argv[i + 1];
    if (v === undefined || v === "" || v.startsWith("--")) throw new Error(`${argv[i]} needs a value`);
    return v;
  };
  const int = (i) => {
    const v = value(i);
    if (!/^\d+$/.test(v)) throw new Error(`${argv[i]} needs a non-negative integer, got "${v}"`);
    return Number(v);
  };
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === "--system") a.system = value(i++);
    else if (argv[i] === "--systems") {
      a.systems = value(i++).split(",").map((s) => s.trim()).filter(Boolean);
      if (!a.systems.length) throw new Error("--systems needs at least one system id");
    } else if (argv[i] === "--from-id") a.from_id = int(i++);
    else if (argv[i] === "--to-id") a.to_id = int(i++);
    else if (argv[i] === "--rehearse") a.rehearse = true;
    else if (argv[i] === "--apply") a.apply = true;
    else if (argv[i] === "--batches") a.batches = int(i++);
    else if (argv[i] === "--replay") a.replay = true;
    else if (argv[i] === "--report") a.report = value(i++);
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  if (a.system && a.systems) throw new Error("use either --system or --systems, not both");
  if (!["dry-run", "backfill", "verify", "derive", "verify-derive", "findings", "verify-findings", "stage"].includes(a.cmd)) {
    throw new Error("usage: cli.js dry-run | backfill --rehearse|--apply | verify | derive --rehearse|--apply [--system S | --systems S1,S2] | verify-derive | findings --rehearse|--apply [--replay] [--system S | --systems S1,S2] [--report FILE] | verify-findings | stage --rehearse");
  }
  if (a.cmd === "stage") {
    if (a.apply) throw new Error("stage has no --apply: the stage writes only from the ge_ct run (INSIGHT_ENABLED=true)");
    if (!a.rehearse) throw new Error("stage needs --rehearse");
    if (a.system || a.systems || a.from_id !== null || a.to_id !== null || a.replay || a.report) throw new Error("stage --rehearse takes no other flags");
  }
  if (["backfill", "derive", "findings"].includes(a.cmd) && a.rehearse === a.apply) throw new Error(`${a.cmd} needs exactly one of --rehearse / --apply`);
  if ((a.cmd === "derive" || a.cmd === "findings") && a.system) a.systems = [a.system];
  if (a.replay && a.cmd !== "findings") throw new Error("--replay is only for findings");
  if (a.report && !(a.cmd === "findings" && a.rehearse)) throw new Error("--report is only for findings --rehearse");
  // a default-mode run skips stale systems, so its rows are not the full list (review PHASE4-RUN-VERIFY F3)
  if (a.report && !a.replay) throw new Error("--report needs --replay (a default run skips systems without recent data)");
  if (a.cmd === "backfill" && a.system) throw new Error("backfill does not take --system (the watermark is fleet-wide)");
  if (a.cmd === "dry-run" && a.from_id === null) a.from_id = 0;
  return a;
}

const template = (msg) => (msg || "").replace(/[\x00-\x1f]+/g, " ").replace(/[0-9]+(\.[0-9]+)?/g, "#").replace(/\s+/g, " ").trim().slice(0, 110);

async function dry_run(a) {
  const errs = validate_rules(rules);
  if (errs.length) throw new Error(`invalid rules: ${errs.join("; ")}`);
  const db = connect("readonly", { statementTimeoutMs: 900000, applicationName: "insight_dryrun" });
  try {
    if ((await db.one("SHOW default_transaction_read_only")).default_transaction_read_only !== "on") throw new Error("not read-only");
    // Freeze the upper bound so the reconciliation compares the same rows.
    const to_id = a.to_id ?? Number((await db.one("SELECT max(id) AS m FROM log.ge_ct_gesys")).m);
    const t0 = Date.now();
    let rows = 0, facts = 0, batches = 0;
    const per = new Map();      // `${system}|${key}` -> n
    const perKey = new Map();   // key -> {n, systems:Set}
    const unmatched = new Map(); // `${proc}|${tmpl}` -> {n, systems:Set}
    const recent = new Map();    // same, host_datetime within 30 days, not ignored
    const recentIgnored = new Map(); // ignore entry -> rows in 30 days
    const since = Date.now() - RECENT_MS;
    const skipped = {};
    const ruleErrors = new Map();
    await stream(db, {
      from_id: a.from_id, to_id, system: a.system, rules,
      on_batch: ({ rows: rs, built }) => {
        batches++; rows += rs.length; facts += built.facts.length;
        for (const [k, v] of Object.entries(built.skipped)) skipped[k] = (skipped[k] || 0) + v;
        for (const e of built.errors) ruleErrors.set(e.key, (ruleErrors.get(e.key) || 0) + 1);
        const matchedIds = new Set();
        for (const f of built.facts) {
          matchedIds.add(f.source_id);
          const k = `${f.system_id}|${f.metric_key}`;
          per.set(k, (per.get(k) || 0) + 1);
          const pk = perKey.get(f.metric_key) || { n: 0, systems: new Set() };
          pk.n++; pk.systems.add(f.system_id); perKey.set(f.metric_key, pk);
        }
        for (const r of rs) {
          if (matchedIds.has(r.id)) continue;
          const proc = (r.type || "").split("\t")[1] || "";
          const k = `${proc.trim()}|${template(r.message)}`;
          const u = unmatched.get(k) || { n: 0, systems: new Set() };
          u.n++; u.systems.add(r.system_id); unmatched.set(k, u);
          if (r.host_datetime && new Date(r.host_datetime).getTime() >= since) {
            const ig = ignored(proc.trim(), r.message);
            if (ig) { recentIgnored.set(ig, (recentIgnored.get(ig) || 0) + 1); continue; }
            const v = recent.get(k) || { n: 0, systems: new Set(), example: r.message };
            v.n++; v.systems.add(r.system_id); recent.set(k, v);
          }
        }
        if (batches % 10 === 0) process.stderr.write(`  ... ${rows} rows, ${facts} facts\n`);
      },
    });
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`DRY RUN (read-only): ${rows} rows in ${batches} batches, ${secs}s; ${facts} facts; ids ${a.from_id}..${to_id}${a.system ? ` system ${a.system}` : ""}`);
    console.log(`skipped facts: ${JSON.stringify(skipped)}; rule errors: ${ruleErrors.size ? JSON.stringify([...ruleErrors]) : "none"}`);
    const matchedRows = rows - [...unmatched.values()].reduce((s, u) => s + u.n, 0);
    console.log(`coverage: ${matchedRows} of ${rows} rows (${(100 * matchedRows / rows).toFixed(1)}%) produce at least one fact`);
    console.log("\nfacts per metric:");
    for (const r of rules) {
      const v = perKey.get(r.key) || { n: 0, systems: new Set() };
      console.log(`  ${r.key.padEnd(36)} ${String(v.n).padStart(9)}  ${String(v.systems.size).padStart(2)} systems`);
    }

    // Reconciliation: independent SQL counts per (system, key) over the same id range.
    const sql = await db.any(RECONCILE_SQL, [a.from_id, to_id, a.system]);
    const sqlMap = new Map(sql.map((r) => [`${r.system_id}|${r.key}`, Number(r.n)]));
    const keys = new Set([...per.keys(), ...sqlMap.keys()]);
    const diffs = [...keys].map((k) => ({ k, js: per.get(k) || 0, sql: sqlMap.get(k) || 0 })).filter((d) => d.js !== d.sql);
    console.log(`\nreconciliation vs independent SQL (${keys.size} system×metric cells): ${diffs.length ? `${diffs.length} differ` : "all equal"}`);
    for (const d of diffs.slice(0, 40)) console.log(`  ${d.k.padEnd(48)} js=${d.js} sql=${d.sql} (${d.js - d.sql > 0 ? "+" : ""}${d.js - d.sql})`);

    const uncovered = [...recent.entries()].filter(([, v]) => v.n > COVERAGE_THRESHOLD).sort((x, y) => y[1].n - x[1].n);
    console.log(`\ncoverage criterion (last 30 days, > ${COVERAGE_THRESHOLD} rows, no rule and no ignore entry): ${uncovered.length ? `${uncovered.length} template(s) uncovered` : "MET"}`);
    for (const [k, v] of uncovered) {
      const [proc, tmpl] = k.split("|");
      console.log(`  ${String(v.n).padStart(7)} ${String(v.systems.size).padStart(2)}sys ${proc.padEnd(15).slice(0, 15)} ${tmpl}`);
    }
    if (recentIgnored.size) {
      console.log("ignore/watch entries matched in the last 30 days:");
      for (const [ig, n] of [...recentIgnored.entries()].sort((x, y) => y[1] - x[1])) console.log(`  ${String(n).padStart(7)} [${ig.status}] ${ig.re} — ${ig.reason}`);
    }

    console.log("\ntop unmatched templates, all history (coverage report):");
    const top = [...unmatched.entries()].sort((x, y) => y[1].n - x[1].n).slice(0, 30);
    for (const [k, u] of top) {
      const [proc, tmpl] = k.split("|");
      console.log(`  ${String(u.n).padStart(7)} ${String(u.systems.size).padStart(2)}sys ${proc.padEnd(15).slice(0, 15)} ${tmpl}`);
    }
  } finally {
    await db.$pool.end();
  }
}

async function confirm(db, a) {
  const t = await db.one("SELECT current_database() AS db, current_user AS usr");
  const mode = a.apply ? (a.cmd === "backfill" ? "APPLY (commits per batch)" : "APPLY (commits per system)") : "REHEARSAL (one transaction, rolled back)";
  console.log(`target: database=${t.db} host=${process.env.PG_HOST} user=${t.usr} — ${mode}`);
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  const it = rl[Symbol.asyncIterator]();
  const ask = async (q) => {
    process.stdout.write(q);
    const { value, done } = await it.next();
    if (done) throw new Error("no input: aborted");
    if (!process.stdin.isTTY) console.log(value);
    return value.trim();
  };
  try {
    if ((await ask("Type the database name to continue: ")) !== t.db) throw new Error("database name mismatch: aborted");
    if (a.apply && (await ask("This writes facts to insight. Type APPLY to continue: ")) !== "APPLY") throw new Error("not confirmed: aborted");
  } finally {
    rl.close();
  }
}

async function backfill(a) {
  const errs = validate_rules(rules);
  if (errs.length) throw new Error(`invalid rules: ${errs.join("; ")}`);
  const db = connect("writer", { statementTimeoutMs: 300000, applicationName: "insight_backfill" });
  try {
    await confirm(db, a);
    const t0 = Date.now();
    const out = await run_extract(db, {
      rules, mode: a.apply ? "apply" : "rehearse", from_id: a.from_id, to_id: a.to_id,
      max_batches: a.apply ? null : a.batches, run_id: crypto.randomUUID(), log: (m) => console.log(m),
    });
    console.log(`${a.apply ? "APPLIED" : "REHEARSAL ROLLED BACK"} in ${((Date.now() - t0) / 1000).toFixed(1)}s: ${JSON.stringify(out.skipped ? out : out.stats)}`);
  } finally {
    await db.$pool.end();
  }
}

async function derive(a) {
  const db = connect("writer", { statementTimeoutMs: 600000, applicationName: "insight_derive" });
  try {
    await confirm(db, a);
    const t0 = Date.now();
    const out = await run_derive(db, { mode: a.apply ? "apply" : "rehearse", systems: a.systems || null, now: new Date(),
      run_id: crypto.randomUUID(), log: (m) => console.log(m) });
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    if (out.skipped) { console.log(`SKIPPED: ${out.skipped}`); process.exitCode = 3; return; }
    if (a.rehearse) {
      console.log(`REHEARSAL ROLLED BACK in ${secs}s. pass 1: ${JSON.stringify(out.pass1)}`);
      console.log(`idempotency: derived-fact changes in pass 2 = ${out.idem.derived_changes}; tables changed = ${out.idem.tables_changed.length ? out.idem.tables_changed.join(", ") : "none"}`);
      console.log(`touched-days pass vs full rebuild: ${out.idem.touched.tables_changed.length ? `DIFFERS in ${out.idem.touched.tables_changed.join(", ")}` : "identical"} (${out.idem.touched.systems} systems, ${out.idem.touched.days} days)`);
      console.log(`verify-derive inside the rehearsal: ${out.verify_ok ? "PASS" : "FAIL"}`);
      const fresh = await db.one(COUNTS_SQL);
      console.log(`after ROLLBACK, fresh read: ${JSON.stringify(fresh)}`);
      if (!out.verify_ok || out.idem.derived_changes || out.idem.tables_changed.length || out.idem.touched.tables_changed.length) process.exitCode = 2;
    } else {
      console.log(`APPLIED in ${secs}s: ${JSON.stringify(out.stats)}; watermark ${out.watermark}; table rows now ${JSON.stringify(out.after)}`);
      console.log("next: node insight/cli.js verify-derive");
    }
  } finally {
    await db.$pool.end();
  }
}

const utc_today = () => new Date().toISOString().slice(0, 10);

async function findings(a) {
  const db = connect("writer", { statementTimeoutMs: 600000, applicationName: "insight_findings" });
  try {
    await confirm(db, a);
    const t0 = Date.now();
    const today = utc_today();
    const out = await run_findings(db, { mode: a.apply ? "apply" : "rehearse", replay: a.replay, systems: a.systems || null, today,
      run_id: crypto.randomUUID(), log: (m) => console.log(m) });
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    if (out.skipped) { console.log(`SKIPPED: ${out.skipped}`); process.exitCode = 3; return; }
    if (a.rehearse) {
      console.log(`REHEARSAL ROLLED BACK in ${secs}s. pass 1: ${JSON.stringify(out.pass1)}`);
      console.log(`checks: ${JSON.stringify(out.checks)}; verify-findings inside the rehearsal: ${out.verify_ok ? "PASS" : "FAIL"}; overall ${out.ok ? "OK" : "NOT OK"}`);
      console.log(`after ROLLBACK, fresh read: ${JSON.stringify(await db.one(FINDINGS_COUNTS_SQL))}`);
      if (a.report) {
        const scope = a.systems ? `PARTIAL: only ${a.systems.join(", ")}` : `all ${out.pass1.systems} systems`;
        fs.writeFileSync(a.report, format_report(out.rows, { today, scope }) + "\n");
        fs.writeFileSync(`${a.report}.json`, JSON.stringify(out.rows, null, 1));
        console.log(`report: ${a.report} (+ .json)`);
      }
      if (!out.ok) process.exitCode = 2;
    } else {
      console.log(`APPLIED in ${secs}s: ${JSON.stringify(out.stats)}; table now ${JSON.stringify(out.after)}`);
      console.log("next: node insight/cli.js verify-findings");
    }
  } finally {
    await db.$pool.end();
  }
}

async function stage(a) {
  const errs = validate_rules(rules);
  if (errs.length) throw new Error(`invalid rules: ${errs.join("; ")}`);
  const db = connect("writer", { statementTimeoutMs: 600000, applicationName: "insight_stage_rehearsal" });
  try {
    await confirm(db, a);
    const t0 = Date.now();
    const out = await rehearse_stage(db, { rules, log: (m) => console.log(m) });
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    if (out.skipped) { console.log(`SKIPPED: ${out.skipped}`); process.exitCode = 3; return; }
    console.log(`\nREHEARSAL ROLLED BACK in ${secs}s.`);
    console.log("per-step ms:");
    for (const r of out.runs) {
      const ms = Object.entries(r.steps).map(([k, s]) => `${k} ${s.ms}`).join(", ");
      const ex = r.steps.extract || {};
      console.log(`  ${r.label}: total ${r.ms} ms (${ms}); rows ${ex.rows ?? "-"}, late re-read ${ex.late ? ex.late.rows : "-"} rows; derive ${r.steps.derive ? `${r.steps.derive.systems} systems / ${r.steps.derive.days} days` : "-"}; findings ${r.steps.findings ? `${r.steps.findings.mode}, ${r.steps.findings.systems} systems` : "-"}`);
    }
    console.log(`checks: ${JSON.stringify(out.checks)}`);
    console.log(`overall: ${out.ok ? "OK" : "NOT OK"}`);
    const fresh = await db.one(`SELECT (SELECT json_object_agg(job_name, watermark_id) FROM insight.job_state
                                        WHERE job_name IN ('ge_ct_extract', 'ge_ct_derive', 'ge_ct_findings')) AS watermarks,
                                       (SELECT count(*) FROM insight.ge_ct_facts)::int AS facts, (SELECT count(*) FROM insight.findings)::int AS findings`);
    console.log(`after ROLLBACK, fresh read: ${JSON.stringify(fresh)}`);
    if (!out.ok) process.exitCode = 2;
  } finally {
    await db.$pool.end();
  }
}

async function verify_findings() {
  const db = connect("readonly", { statementTimeoutMs: 900000, applicationName: "insight_verify_findings" });
  try {
    if ((await db.one("SHOW default_transaction_read_only")).default_transaction_read_only !== "on") throw new Error("not read-only");
    const job = await db.oneOrNone("SELECT watermark_id, last_run_status, last_run_finished_at, last_run_stats FROM insight.job_state WHERE job_name = 'ge_ct_findings'");
    const stats = (job && job.last_run_stats) || {};
    const today = stats.today || utc_today();
    const as_of_by_system = stats.as_of_by_system || {};
    const dates = [...new Set(Object.values(as_of_by_system))].sort();
    console.log(`verify-findings (read-only): findings job ${job ? `${job.last_run_status || "no fleet run"} at ${job.last_run_finished_at ? job.last_run_finished_at.toISOString() : "-"}, watermark ${job.watermark_id}` : "has not run"}; as of ${today}; per-system as-of dates: ${dates.length ? dates.join(", ") : "none recorded"}`);
    const v = await run_verify_findings(db, { today, as_of_by_system, log: (m) => console.log(m) });
    console.log(v.ok ? "ALL CHECKS PASS" : `FAILED: ${v.results.filter((r) => !r.ok).map((r) => r.name).join(", ")}`);
    if (!v.ok) process.exitCode = 2;
  } finally {
    await db.$pool.end();
  }
}

async function verify_derive() {
  const db = connect("readonly", { statementTimeoutMs: 900000, applicationName: "insight_verify_derive" });
  try {
    if ((await db.one("SHOW default_transaction_read_only")).default_transaction_read_only !== "on") throw new Error("not read-only");
    const job = await db.oneOrNone("SELECT watermark_id, last_run_status, last_run_finished_at FROM insight.job_state WHERE job_name = 'ge_ct_derive'");
    console.log(`verify-derive (read-only): derive job ${job ? `${job.last_run_status} at ${job.last_run_finished_at && job.last_run_finished_at.toISOString()}, watermark ${job.watermark_id}` : "has not run"}`);
    const v = await run_verify(db);
    console.log(v.ok ? "ALL CHECKS PASS" : `FAILED: ${v.results.filter((r) => !r.ok).map((r) => r.name).join(", ")}`);
    if (!v.ok) process.exitCode = 2;
  } finally {
    await db.$pool.end();
  }
}

async function verify() {
  const db = connect("readonly", { statementTimeoutMs: 900000, applicationName: "insight_verify" });
  try {
    const job = await db.oneOrNone("SELECT watermark_id, last_run_status, last_run_finished_at FROM insight.job_state WHERE job_name = 'ge_ct_extract'");
    if (!job) throw new Error("no watermark yet: run backfill --apply first");
    const to = Number(job.watermark_id);
    const v = await verify_facts(db, to);
    console.log(`verify (read-only): watermark ${to} (${job.last_run_status} at ${job.last_run_finished_at && job.last_run_finished_at.toISOString()}); ${v.total} facts in insight.ge_ct_facts`);
    console.log(`facts vs independent DISTINCT-key SQL (${v.cells} system×metric cells): ${v.diffs.length ? `${v.diffs.length} differ` : "all equal"}`);
    for (const d of v.diffs.slice(0, 40)) console.log(`  ${d.k.padEnd(48)} facts=${d.facts} sql=${d.sql}`);
    console.log(`catalog rows: ${v.catalog.n} (registry: ${rules.length} per-row + ${derived_rules.length} derived; ${v.catalog.derived} derived present)`);
    if (!v.ok) process.exitCode = 2;
  } finally {
    await db.$pool.end();
  }
}

if (require.main !== module) {
  module.exports = { args }; // tests: argument parsing only, no DB
  return;
}

(async () => {
  const a = args(process.argv.slice(2));
  if (a.cmd === "dry-run") await dry_run(a);
  if (a.cmd === "backfill") await backfill(a);
  if (a.cmd === "verify") await verify();
  if (a.cmd === "derive") await derive(a);
  if (a.cmd === "verify-derive") await verify_derive();
  if (a.cmd === "findings") await findings(a);
  if (a.cmd === "verify-findings") await verify_findings();
  if (a.cmd === "stage") await stage(a);
})()
  .catch((e) => { console.error(`ERROR: ${e.message}`); process.exitCode = 1; })
  .finally(() => pgp.end());
