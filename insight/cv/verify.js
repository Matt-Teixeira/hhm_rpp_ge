"use strict";
// The CV-2 exit check (PLAN-CV-INSIGHTS.md §4), on any connection or
// transaction (the rehearsal runs it on its uncommitted facts):
//   - facts per (system, metric) with source_id <= `to` vs the independent
//     count (reconcile_sql.js) over source ids 0..to;
//   - coverage: every source row is ignored (relay), counted or unstorable,
//     and the cv.error facts equal the counted rows;
//   - the cv.* catalog rows are exactly the registry (CV keys only: CT's
//     catalog rows are not looked at);
//   - codes not in the reviewed list (a note, not a failure);
//   - repeats of the device-side identity in the source (a note).
// Nothing in the GE CT run loads this file.
const { rules } = require("./rules");
const { RECONCILE_SQL, COVERAGE_SQL, REPEATS_SQL } = require("./reconcile_sql");
const { unreviewed } = require("./load");

function compare(facts, sql) {
  const fm = new Map(facts.map((r) => [`${r.system_id}|${r.key}`, Number(r.n)]));
  const sm = new Map(sql.map((r) => [`${r.system_id}|${r.key}`, Number(r.n)]));
  const keys = new Set([...fm.keys(), ...sm.keys()]);
  const diffs = [...keys].filter((k) => (fm.get(k) || 0) !== (sm.get(k) || 0)).map((k) => ({ k, facts: fm.get(k) || 0, sql: sm.get(k) || 0 }));
  return { cells: keys.size, diffs };
}

async function verify_cv_facts(t, to) {
  const facts = await t.any(`SELECT system_id, metric_key AS key, count(*)::int AS n FROM insight.ge_cv_facts
                             WHERE source_id <= $1 GROUP BY 1, 2`, [to]);
  const sql = await t.any(RECONCILE_SQL, [0, to, null]);
  const { cells, diffs } = compare(facts, sql);
  const total = facts.reduce((s, r) => s + r.n, 0);
  const cov = await t.one(COVERAGE_SQL, [0, to, null]);
  const errors_total = facts.filter((r) => r.key === "cv.error").reduce((s, r) => s + r.n, 0);
  const coverage = {
    rows: cov.rows, relay: cov.relay, counted: cov.counted, unstorable: cov.unstorable,
    accounted: cov.relay + cov.counted + cov.unstorable === cov.rows,
    cv_error_facts: errors_total, cv_error_equals_counted: errors_total === cov.counted,
    codes: cov.codes.length, unreviewed_codes: unreviewed(cov.codes.map(Number)),
  };
  const cat = await t.any("SELECT metric_key, rule_version FROM insight.metric_catalog WHERE metric_key LIKE 'cv.%' ORDER BY 1");
  const want = rules.map((r) => `${r.key}@${r.version}`).sort();
  const have = cat.map((c) => `${c.metric_key}@${c.rule_version}`).sort();
  const catalog = { n: cat.length, expected: rules.length, ok: JSON.stringify(want) === JSON.stringify(have) };
  const repeats = await t.any(REPEATS_SQL, [0, to, null]);
  const ok = !diffs.length && catalog.ok && coverage.accounted && coverage.cv_error_equals_counted;
  return { to, total, cells, diffs, coverage, catalog, source_repeats: repeats.length, ok };
}

module.exports = { verify_cv_facts, compare };
