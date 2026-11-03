#!/usr/bin/env node
"use strict";
// Manual insight commands (PLAN-CT-INSIGHTS.md §6). Read-only modes:
//   node insight/cli.js dry-run [--system SME..] [--from-id N] [--to-id N]
//       Run the rules over log.ge_ct_gesys (read-only), print fact counts,
//       per-(system, metric) reconciliation against independent SQL counts,
//       rule errors, skipped rows, and the top unmatched templates (coverage).
const { connect, pgp } = require("./db");
const { rules } = require("./rules/ge_ct");
const { validate_rules } = require("./rules/engine");
const { stream } = require("./extract");
const { RECONCILE_SQL } = require("./reconcile_sql");

function args(argv) {
  const a = { cmd: argv[0], system: null, from_id: 0, to_id: null };
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === "--system") a.system = argv[++i];
    else if (argv[i] === "--from-id") a.from_id = Number(argv[++i]);
    else if (argv[i] === "--to-id") a.to_id = Number(argv[++i]);
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  if (a.cmd !== "dry-run") throw new Error("usage: cli.js dry-run [--system SME] [--from-id N] [--to-id N]");
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

    console.log("\ntop unmatched templates (coverage report):");
    const top = [...unmatched.entries()].sort((x, y) => y[1].n - x[1].n).slice(0, 30);
    for (const [k, u] of top) {
      const [proc, tmpl] = k.split("|");
      console.log(`  ${String(u.n).padStart(7)} ${String(u.systems.size).padStart(2)}sys ${proc.padEnd(15).slice(0, 15)} ${tmpl}`);
    }
  } finally {
    await db.$pool.end();
  }
}

(async () => {
  const a = args(process.argv.slice(2));
  if (a.cmd === "dry-run") await dry_run(a);
})()
  .catch((e) => { console.error(`ERROR: ${e.message}`); process.exitCode = 1; })
  .finally(() => pgp.end());
