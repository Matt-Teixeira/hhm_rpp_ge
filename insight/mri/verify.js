"use strict";
// The MRI-2 exit check (PLAN-MRI-INSIGHTS.md §4, §6.6), on any connection or
// transaction (the rehearsal runs it on its uncommitted facts):
//   - facts per (system, metric) with source_id <= `to` vs the independent
//     count (reconcile_sql.js) over source ids 0..to;
//   - mri.error per (system, code), and the exam-summary scan sums per system;
//   - coverage: every source row is unstorable, a counted record or a
//     duplicate copy, and the mri.error facts equal the counted records;
//   - no natural-key conflict (one key, two different records): a FAIL;
//   - the mri.* catalog rows are exactly the registry (MRI keys only: CT's
//     and CV's catalog rows are not looked at);
//   - codes not in the reviewed list (a note, not a failure).
// Nothing in the GE CT or CV run loads this file.
const { rules } = require("./rules");
const { RECONCILE_SQL, ERROR_DIMS_SQL, SCAN_SUMS_SQL, COVERAGE_SQL, CONFLICTS_SQL } = require("./reconcile_sql");
const { unreviewed } = require("./load");

// a, b: [{ system_id, key, n }] -> { cells, diffs }
function compare(a, b) {
  const am = new Map(a.map((r) => [`${r.system_id}|${r.key}`, Number(r.n)]));
  const bm = new Map(b.map((r) => [`${r.system_id}|${r.key}`, Number(r.n)]));
  const keys = new Set([...am.keys(), ...bm.keys()]);
  const diffs = [...keys].filter((k) => (am.get(k) || 0) !== (bm.get(k) || 0)).map((k) => ({ k, facts: am.get(k) || 0, sql: bm.get(k) || 0 }));
  return { cells: keys.size, diffs };
}

// The SQL side of every check over source ids 0..to (also used by the dry run).
async function expected(t, to) {
  const metrics = await t.any(RECONCILE_SQL, [0, to, null]);
  const dims = await t.any(ERROR_DIMS_SQL, [0, to, null]);
  const scans = await t.any(SCAN_SUMS_SQL, [0, to, null]);
  const cov = await t.one(COVERAGE_SQL, [0, to, null]);
  const conflicts = await t.any(CONFLICTS_SQL, [0, to, null]);
  return {
    metrics,
    dims: dims.map((r) => ({ system_id: r.system_id, key: r.dim, n: r.n })),
    scans: scans.flatMap((r) => [{ system_id: r.system_id, key: "ok", n: Number(r.ok) }, { system_id: r.system_id, key: "failed", n: Number(r.failed) }]),
    cov, conflicts,
  };
}

async function verify_mri_facts(t, to) {
  const facts = await t.any(`SELECT system_id, metric_key AS key, count(*)::int AS n FROM insight.ge_mri_facts
                             WHERE source_id <= $1 GROUP BY 1, 2`, [to]);
  const dims = await t.any(`SELECT system_id, dim AS key, count(*)::int AS n FROM insight.ge_mri_facts
                            WHERE source_id <= $1 AND metric_key = 'mri.error' GROUP BY 1, 2`, [to]);
  const scans = await t.any(`SELECT system_id, CASE metric_key WHEN 'mri.scans_ok' THEN 'ok' ELSE 'failed' END AS key, sum(value_num)::bigint AS n
                             FROM insight.ge_mri_facts WHERE source_id <= $1 AND metric_key IN ('mri.scans_ok', 'mri.scans_failed') GROUP BY 1, 2`, [to]);
  const want = await expected(t, to);
  const by_metric = compare(facts, want.metrics);
  const by_code = compare(dims, want.dims);
  const scan_sums = compare(scans.map((r) => ({ ...r, n: Number(r.n) })), want.scans);
  const total = facts.reduce((s, r) => s + r.n, 0);
  const errors_total = facts.filter((r) => r.key === "mri.error").reduce((s, r) => s + r.n, 0);
  const cov = want.cov;
  const coverage = {
    rows: cov.rows, unstorable: cov.unstorable, counted: cov.counted, duplicates: cov.rows - cov.unstorable - cov.counted,
    mri_error_facts: errors_total, mri_error_equals_counted: errors_total === cov.counted,
    codes: cov.codes.length, unreviewed_codes: unreviewed(cov.codes.map(Number)),
  };
  const cat = await t.any("SELECT metric_key, rule_version FROM insight.metric_catalog WHERE metric_key LIKE 'mri.%' ORDER BY 1");
  const want_cat = rules.map((r) => `${r.key}@${r.version}`).sort();
  const have_cat = cat.map((c) => `${c.metric_key}@${c.rule_version}`).sort();
  const catalog = { n: cat.length, expected: rules.length, ok: JSON.stringify(want_cat) === JSON.stringify(have_cat) };
  const ok = !by_metric.diffs.length && !by_code.diffs.length && !scan_sums.diffs.length && coverage.mri_error_equals_counted
    && !want.conflicts.length && catalog.ok;
  return {
    to, total,
    by_metric: { cells: by_metric.cells, diffs: by_metric.diffs },
    by_code: { cells: by_code.cells, diffs: by_code.diffs.slice(0, 20), n_diffs: by_code.diffs.length },
    scan_sums: { cells: scan_sums.cells, diffs: scan_sums.diffs },
    coverage, conflicts: want.conflicts, catalog, ok,
  };
}

module.exports = { verify_mri_facts, compare, expected };
