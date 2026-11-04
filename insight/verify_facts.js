"use strict";
// The Phase 2 exit check (`cli.js verify`), on any connection or
// transaction (the stage rehearsal runs it on its uncommitted facts): facts
// per (system, metric) with source_id <= the watermark vs the independent
// count of DISTINCT natural keys over gesys ids 0..watermark, plus the
// metric catalog size. Derived metrics have no per-row count (verify-derive).
const { rules } = require("./rules/ge_ct");
const { derived_rules, DERIVED_KEYS } = require("./rules/ge_ct_derived");
const { RECONCILE_DISTINCT_SQL } = require("./reconcile_sql");

async function verify_facts(t, to) {
  const facts = await t.any(`SELECT system_id, metric_key AS key, count(*)::int AS n FROM insight.ge_ct_facts
                             WHERE source_id <= $1 AND metric_key <> ALL($2) GROUP BY 1, 2`, [to, DERIVED_KEYS]);
  const sql = await t.any(RECONCILE_DISTINCT_SQL, [0, to, null]);
  const fm = new Map(facts.map((r) => [`${r.system_id}|${r.key}`, r.n]));
  const sm = new Map(sql.map((r) => [`${r.system_id}|${r.key}`, Number(r.n)]));
  const keys = new Set([...fm.keys(), ...sm.keys()]);
  const diffs = [...keys].filter((k) => (fm.get(k) || 0) !== (sm.get(k) || 0)).map((k) => ({ k, facts: fm.get(k) || 0, sql: sm.get(k) || 0 }));
  const total = facts.reduce((s, r) => s + r.n, 0);
  const cat = await t.one("SELECT count(*)::int AS n, count(*) FILTER (WHERE metric_key = ANY($1))::int AS derived FROM insight.metric_catalog", [DERIVED_KEYS]);
  // derived catalog rows appear once derive has run; before that only the per-row registry
  const expected = rules.length + (cat.derived ? derived_rules.length : 0);
  return { to, total, cells: keys.size, diffs, catalog: { n: cat.n, derived: cat.derived, expected }, ok: !diffs.length && cat.n === expected };
}

module.exports = { verify_facts };
