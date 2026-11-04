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
//   node insight/cli.js verify
//       READ-ONLY. Facts per (system, metric) vs the independent count of
//       DISTINCT natural keys, over the watermark range. Derived metrics
//       (system.boot, tube.replacement) have no per-row count; they are
//       checked by verify-derive.
const { connect, pgp } = require("./db");
const { rules } = require("./rules/ge_ct");
const { validate_rules } = require("./rules/engine");
const { stream } = require("./extract");
const { RECONCILE_SQL, RECONCILE_DISTINCT_SQL } = require("./reconcile_sql");
const { run_extract } = require("./load");
const readline = require("readline");
const crypto = require("crypto");
const { ignore } = require("./rules/ge_ct_ignore");
const { derived_rules, DERIVED_KEYS } = require("./rules/ge_ct_derived");

const RECENT_MS = 30 * 24 * 3600 * 1000;
const COVERAGE_THRESHOLD = 500; // rows per template per 30 days (§8)
const ignored = (proc, msg) => ignore.find((i) => (!i.process || i.process === proc) && i.re.test(msg || ""));

function args(argv) {
  const a = { cmd: argv[0], system: null, from_id: null, to_id: null, rehearse: false, apply: false, batches: 2 };
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === "--system") a.system = argv[++i];
    else if (argv[i] === "--from-id") a.from_id = Number(argv[++i]);
    else if (argv[i] === "--to-id") a.to_id = Number(argv[++i]);
    else if (argv[i] === "--rehearse") a.rehearse = true;
    else if (argv[i] === "--apply") a.apply = true;
    else if (argv[i] === "--batches") a.batches = Number(argv[++i]);
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  if (!["dry-run", "backfill", "verify"].includes(a.cmd)) throw new Error("usage: cli.js dry-run | backfill --rehearse|--apply | verify");
  if (a.cmd === "backfill" && a.rehearse === a.apply) throw new Error("backfill needs exactly one of --rehearse / --apply");
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
  const mode = a.apply ? "APPLY (commits per batch)" : "REHEARSAL (one transaction, rolled back)";
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

async function verify() {
  const db = connect("readonly", { statementTimeoutMs: 900000, applicationName: "insight_verify" });
  try {
    const job = await db.oneOrNone("SELECT watermark_id, last_run_status, last_run_finished_at FROM insight.job_state WHERE job_name = 'ge_ct_extract'");
    if (!job) throw new Error("no watermark yet: run backfill --apply first");
    const to = Number(job.watermark_id);
    const facts = await db.any(`SELECT system_id, metric_key AS key, count(*)::int AS n FROM insight.ge_ct_facts
                                WHERE source_id <= $1 AND metric_key <> ALL($2) GROUP BY 1, 2`, [to, DERIVED_KEYS]);
    const sql = await db.any(RECONCILE_DISTINCT_SQL, [0, to, null]);
    const fm = new Map(facts.map((r) => [`${r.system_id}|${r.key}`, r.n]));
    const sm = new Map(sql.map((r) => [`${r.system_id}|${r.key}`, Number(r.n)]));
    const keys = new Set([...fm.keys(), ...sm.keys()]);
    const diffs = [...keys].filter((k) => (fm.get(k) || 0) !== (sm.get(k) || 0));
    const total = facts.reduce((s, r) => s + r.n, 0);
    console.log(`verify (read-only): watermark ${to} (${job.last_run_status} at ${job.last_run_finished_at && job.last_run_finished_at.toISOString()}); ${total} facts in insight.ge_ct_facts`);
    console.log(`facts vs independent DISTINCT-key SQL (${keys.size} system×metric cells): ${diffs.length ? `${diffs.length} differ` : "all equal"}`);
    for (const k of diffs.slice(0, 40)) console.log(`  ${k.padEnd(48)} facts=${fm.get(k) || 0} sql=${sm.get(k) || 0}`);
    const cat = await db.one("SELECT count(*)::int AS n, count(*) FILTER (WHERE metric_key = ANY($1))::int AS derived FROM insight.metric_catalog", [DERIVED_KEYS]);
    // derived catalog rows appear once derive has run; before that only the per-row registry
    const expected = rules.length + (cat.derived ? derived_rules.length : 0);
    console.log(`catalog rows: ${cat.n} (registry: ${rules.length} per-row + ${derived_rules.length} derived; ${cat.derived} derived present)`);
    if (diffs.length || cat.n !== expected) process.exitCode = 2;
  } finally {
    await db.$pool.end();
  }
}

(async () => {
  const a = args(process.argv.slice(2));
  if (a.cmd === "dry-run") await dry_run(a);
  if (a.cmd === "backfill") await backfill(a);
  if (a.cmd === "verify") await verify();
})()
  .catch((e) => { console.error(`ERROR: ${e.message}`); process.exitCode = 1; })
  .finally(() => pgp.end());
