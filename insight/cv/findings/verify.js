"use strict";
// GE CV verify-findings (PLAN-CV-INSIGHTS.md §10.7). Read-only; takes any
// connection or transaction, so the rehearsal can run it on its own
// (uncommitted) rows before rolling back.
//
// Checks:
//   1. findings: every row of insight.findings with source 'ge_cv' equals the
//      row re-derived by the independent SQL (./verify_sql.js), field by
//      field (CT's compare_findings); none missing, none extra.
//   2. catalog: the cv_* rows of insight.finding_catalog equal the CV
//      registry (CT rows are CT's check).
//   3. invariants: known key and rule_version; source ge_cv; an open
//      finding's data_through is its system's last data day; resolved_at >
//      opened_at; at most one open finding per (system, key).
//
// Nothing in the GE CT run loads this file.
const { compare_findings } = require("../../findings/verify");
const { FINDINGS_SQL } = require("./verify_sql");
const { cv_finding_rules, cv_catalog_rows, KEY_PREFIX } = require("./rules");

const SOURCE = "ge_cv";
const iso = (t) => (t === null || t === undefined ? null : new Date(t).toISOString());
const keyOf = (r) => `${r.system_id}|${r.finding_key}|${iso(r.opened_at)}`;

function invariants(rows, last_day_by_system) {
  const reg = new Map(cv_finding_rules.map((r) => [r.key, r]));
  const bad = [];
  for (const r of rows) {
    const k = keyOf(r);
    const rule = reg.get(r.finding_key);
    if (!rule) { bad.push(`${k}: unknown finding_key`); continue; }
    if (r.rule_version !== rule.version) bad.push(`${k}: rule_version ${r.rule_version} != registry ${rule.version}`);
    if ((r.evidence || {}).rule_version !== rule.version) bad.push(`${k}: evidence.rule_version differs`);
    if (r.status === "open" && last_day_by_system && r.data_through_text !== last_day_by_system.get(r.system_id)) {
      bad.push(`${k}: open but data_through ${r.data_through_text} != last data day ${last_day_by_system.get(r.system_id)}`);
    }
    if (r.resolved_at && !(new Date(r.resolved_at) > new Date(r.opened_at))) bad.push(`${k}: resolved_at not after opened_at`);
    if (r.source !== SOURCE) bad.push(`${k}: source ${r.source}`);
  }
  const open = new Map();
  for (const r of rows) if (r.status === "open") open.set(`${r.system_id}|${r.finding_key}`, (open.get(`${r.system_id}|${r.finding_key}`) || 0) + 1);
  for (const [k, n] of open) if (n > 1) bad.push(`${k}: ${n} open findings`);
  return bad;
}

const STORED_SQL = `
  SELECT system_id, finding_key, opened_at, source, status, severity, window_start, window_end, observed, baseline, evidence,
         rule_version, last_evaluated, resolved_at, to_char(data_through, 'YYYY-MM-DD') AS data_through_text
  FROM insight.findings WHERE source = 'ge_cv'`;
// CV findings keys that are not ge_cv (a CV key written by something else)
const FOREIGN_SQL = `SELECT system_id, finding_key, source FROM insight.findings WHERE finding_key LIKE 'cv\\_%' AND source <> 'ge_cv'`;
// Inventory (review CV4-FINDINGS P2): every device day with CV facts has
// daily rows and vice versa. Findings read data days from the facts (JS)
// and from ge_cv_daily (the SQL, the system list), so a facts-only system
// or day (derive skipped, lost or behind) must fail, not pass empty.
const INVENTORY_SQL = `
  SELECT coalesce(f.system_id, y.system_id) AS system_id, to_char(coalesce(f.d, y.d), 'YYYY-MM-DD') AS day,
         CASE WHEN y.d IS NULL THEN 'facts_only' ELSE 'daily_only' END AS kind
  FROM (SELECT system_id, host_local::date AS d FROM insight.ge_cv_facts GROUP BY 1, 2) f
  FULL JOIN (SELECT DISTINCT system_id, local_day AS d FROM insight.ge_cv_daily) y USING (system_id, d)
  WHERE f.d IS NULL OR y.d IS NULL
  ORDER BY 1, 2`;
const inventory_lines = (rows) => {
  const per = new Map();
  for (const r of rows) { const k = `${r.system_id} ${r.kind}`; const v = per.get(k) || { n: 0, first: r.day, last: r.day }; v.n++; v.last = r.day; per.set(k, v); }
  return [...per].map(([k, v]) => `${k}: ${v.n} days (${v.first}..${v.last})`);
};
const LAST_DAY_SQL = `SELECT system_id, to_char(max(local_day), 'YYYY-MM-DD') AS d FROM insight.ge_cv_daily WHERE local_day <= $1::date GROUP BY 1`;
const CATALOG_SQL = `SELECT finding_key, label, description, category, default_severity, rule_version, customer_visible
  FROM insight.finding_catalog WHERE finding_key LIKE 'cv\\_%'`;

// today: the as-of date of the run that wrote the findings; as_of_by_system:
// the date each system was last evaluated at (job_state), which wins.
async function run_verify(t, { today, as_of_by_system = {}, log = console.log } = {}) {
  const asOf = (s) => as_of_by_system[s] || today;
  const dates = [...new Set([today, ...Object.values(as_of_by_system)])].sort();
  const results = [];
  const check = async (name, fn) => {
    const t0 = Date.now();
    const r = await fn();
    results.push({ name, ok: r.ok, lines: r.lines });
    log(`[${r.ok ? "PASS" : "FAIL"}] ${name} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    for (const l of r.lines) log(`       ${l}`);
  };
  const stored = (await t.any(STORED_SQL)).map((r) => ({ ...r, data_through: r.data_through_text }));
  const lastDay = new Map();
  for (const d of dates) for (const r of await t.any(LAST_DAY_SQL, [d])) if (asOf(r.system_id) === d) lastDay.set(r.system_id, r.d);

  await check("inventory: CV fact days = ge_cv_daily days", async () => {
    const bad = await t.any(INVENTORY_SQL);
    return { ok: !bad.length, lines: bad.length ? inventory_lines(bad) : ["every system and device day with facts has daily rows, and none without"] };
  });

  await check("findings vs independent SQL", async () => {
    const expected = [];
    for (const d of dates) expected.push(...(await t.any(FINDINGS_SQL, [d])).filter((r) => asOf(r.system_id) === d));
    const c = compare_findings(expected, stored);
    const lines = [`as of ${dates.join(", ")}: SQL ${c.expected} findings, table ${c.actual}; missing ${c.missing.length}, extra ${c.extra.length}, differ ${c.differ.length}`];
    for (const k of c.missing.slice(0, 15)) lines.push(`  missing ${k}`);
    for (const k of c.extra.slice(0, 15)) lines.push(`  extra   ${k}`);
    for (const k of c.differ.slice(0, 15)) lines.push(`  differ  ${k}`);
    for (const r of cv_finding_rules) {
      const x = stored.filter((s) => s.finding_key === r.key);
      const sev = {};
      for (const s of x) sev[s.severity] = (sev[s.severity] || 0) + 1;
      lines.push(`  ${r.key.padEnd(26)} ${String(x.length).padStart(3)} findings, ${String(x.filter((s) => s.status === "open").length).padStart(2)} open  ${JSON.stringify(sev)}`);
    }
    return { ok: c.ok, lines };
  });

  await check("catalog (cv_*) = CV registry", async () => {
    const cat = await t.any(CATALOG_SQL);
    const want = new Map(cv_catalog_rows().map((r) => [r.finding_key, JSON.stringify(r)]));
    const have = new Map(cat.map((r) => [r.finding_key, JSON.stringify({ finding_key: r.finding_key, label: r.label, description: r.description,
      category: r.category, default_severity: r.default_severity, rule_version: r.rule_version, customer_visible: r.customer_visible })]));
    const diff = [...new Set([...want.keys(), ...have.keys()])].filter((k) => want.get(k) !== have.get(k));
    return { ok: !diff.length, lines: [`${have.size} ${KEY_PREFIX}* catalog rows, registry ${want.size}; differ: ${diff.length ? diff.join(", ") : "none"}`] };
  });

  await check("invariants", async () => {
    const bad = invariants(stored, lastDay);
    for (const r of await t.any(FOREIGN_SQL)) bad.push(`${r.system_id}|${r.finding_key}: CV key with source ${r.source}`);
    return { ok: !bad.length, lines: [`${stored.length} findings; known keys and versions, source ${SOURCE}, open = last data day, resolved after opened, one open per key: ${bad.length ? `${bad.length} problems` : "ok"}`, ...bad.slice(0, 15)] };
  });
  return { ok: results.every((r) => r.ok), results, stored: stored.length };
}

module.exports = { run_verify, invariants, inventory_lines, STORED_SQL, INVENTORY_SQL, SOURCE };
