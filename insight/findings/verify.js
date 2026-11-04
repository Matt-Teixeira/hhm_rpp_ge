"use strict";
// verify-findings (PLAN-CT-INSIGHTS.md §14.4). Read-only; takes any
// connection or transaction, so the rehearsal can run it on its own
// (uncommitted) rows before rolling back.
//
// Checks:
//   1. findings: every row of insight.findings (source ge_ct) equals the row
//      re-derived by the independent SQL (findings/verify_sql.js), field by
//      field; none missing, none extra.
//   2. catalog: insight.finding_catalog equals the registry.
//   3. invariants: rule_version = registry; an open finding's data_through is
//      its system's last data day; resolved_at > opened_at; no unknown keys.
const { FINDINGS_SQL } = require("./verify_sql");
const { finding_rules, catalog_rows } = require("./rules");

const iso = (t) => (t === null || t === undefined ? null : new Date(t).toISOString());
const num_eq = (a, b) => (a === null || a === undefined ? b === null || b === undefined : b !== null && b !== undefined && Math.abs(Number(a) - Number(b)) < 1e-6);
const keyOf = (r) => `${r.system_id}|${r.finding_key}|${iso(r.opened_at)}`;

// expected: rows of FINDINGS_SQL; actual: findings rows (DB or replay output)
function compare_findings(expected, actual) {
  const ex = new Map(expected.map((r) => [keyOf(r), r]));
  const ac = new Map(actual.map((r) => [keyOf(r), r]));
  const missing = [...ex.keys()].filter((k) => !ac.has(k));
  const extra = [...ac.keys()].filter((k) => !ex.has(k));
  const differ = [];
  for (const [k, e] of ex) {
    const a = ac.get(k);
    if (!a) continue;
    const ev = a.evidence || {};
    const checks = [
      ["status", e.status, a.status], ["severity", e.severity, a.severity],
      ["resolved_at", iso(e.resolved_at), iso(a.resolved_at)],
      ["window_start", iso(e.window_start), iso(a.window_start)], ["window_end", iso(e.window_end), iso(a.window_end)],
      ["data_through", e.data_through, String(a.data_through).slice(0, 10)],
      ["last_evaluated", iso(e.last_evaluated), iso(a.last_evaluated)],
      ["opened_day", e.opened_day, ev.opened_day],
      ["last_trip_day", e.last_trip_day ?? undefined, ev.last_trip_day ?? undefined],
      ["trip_days", e.trip_days ?? undefined, ev.trip_days ?? undefined],
    ];
    const bad = checks.filter(([, x, y]) => x !== y).map(([n, x, y]) => `${n} sql=${x} js=${y}`);
    if (!num_eq(e.observed, a.observed)) bad.push(`observed sql=${e.observed} js=${a.observed}`);
    if (!num_eq(e.baseline, a.baseline)) bad.push(`baseline sql=${e.baseline} js=${a.baseline}`);
    if (bad.length) differ.push(`${k}: ${bad.join("; ")}`);
  }
  return { expected: ex.size, actual: ac.size, missing, extra, differ, ok: !missing.length && !extra.length && !differ.length };
}

function invariants(rows, last_day_by_system) {
  const reg = new Map(finding_rules.map((r) => [r.key, r]));
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
    if (r.source !== "ge_ct") bad.push(`${k}: source ${r.source}`);
  }
  const open = new Map();
  for (const r of rows) if (r.status === "open") open.set(`${r.system_id}|${r.finding_key}`, (open.get(`${r.system_id}|${r.finding_key}`) || 0) + 1);
  for (const [k, n] of open) if (n > 1) bad.push(`${k}: ${n} open findings`);
  return bad;
}

const STORED_SQL = `
  SELECT system_id, finding_key, opened_at, source, status, severity, window_start, window_end, observed, baseline, evidence,
         rule_version, last_evaluated, resolved_at, to_char(data_through, 'YYYY-MM-DD') AS data_through_text
  FROM insight.findings WHERE source = 'ge_ct'`;
const LAST_DAY_SQL = `SELECT system_id, to_char(max(local_day), 'YYYY-MM-DD') AS d FROM insight.ge_ct_daily WHERE local_day <= $1::date GROUP BY 1`;

// today: the as-of date of the run that wrote the findings.
async function run_verify(t, { today, log = console.log, rows = null } = {}) {
  const results = [];
  const check = async (name, fn) => {
    const t0 = Date.now();
    const r = await fn();
    results.push({ name, ok: r.ok });
    log(`[${r.ok ? "PASS" : "FAIL"}] ${name} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    for (const l of r.lines) log(`       ${l}`);
  };
  const stored = rows || (await t.any(STORED_SQL)).map((r) => ({ ...r, data_through: r.data_through_text }));
  const lastDay = new Map((await t.any(LAST_DAY_SQL, [today])).map((r) => [r.system_id, r.d]));

  await check("findings vs independent SQL", async () => {
    const expected = await t.any(FINDINGS_SQL, [today]);
    const c = compare_findings(expected, stored);
    const lines = [`as of ${today}: SQL ${c.expected} findings, table ${c.actual}; missing ${c.missing.length}, extra ${c.extra.length}, differ ${c.differ.length}`];
    for (const k of c.missing.slice(0, 15)) lines.push(`  missing ${k}`);
    for (const k of c.extra.slice(0, 15)) lines.push(`  extra   ${k}`);
    for (const k of c.differ.slice(0, 15)) lines.push(`  differ  ${k}`);
    const per = new Map();
    for (const r of expected) {
      const v = per.get(r.finding_key) || { n: 0, open: 0, sev: {} };
      v.n++; if (r.status === "open") v.open++; v.sev[r.severity] = (v.sev[r.severity] || 0) + 1; per.set(r.finding_key, v);
    }
    for (const r of finding_rules) {
      const v = per.get(r.key) || { n: 0, open: 0, sev: {} };
      lines.push(`  ${r.key.padEnd(30)} ${String(v.n).padStart(3)} findings, ${String(v.open).padStart(2)} open  ${JSON.stringify(v.sev)}`);
    }
    return { ok: c.ok, lines };
  });

  await check("catalog = registry", async () => {
    const cat = await t.any("SELECT finding_key, label, description, category, default_severity, rule_version, customer_visible FROM insight.finding_catalog");
    const want = new Map(catalog_rows().map((r) => [r.finding_key, JSON.stringify(r)]));
    const have = new Map(cat.map((r) => [r.finding_key, JSON.stringify({ finding_key: r.finding_key, label: r.label, description: r.description,
      category: r.category, default_severity: r.default_severity, rule_version: r.rule_version, customer_visible: r.customer_visible })]));
    const diff = [...new Set([...want.keys(), ...have.keys()])].filter((k) => want.get(k) !== have.get(k));
    return { ok: !diff.length, lines: [`${have.size} catalog rows, registry ${want.size}; differ: ${diff.length ? diff.join(", ") : "none"}`] };
  });

  await check("invariants", async () => {
    const bad = invariants(stored.map((r) => ({ ...r, data_through_text: r.data_through_text || r.data_through })), lastDay);
    return { ok: !bad.length, lines: [`${stored.length} findings; rule versions, open = last data day, resolved after opened, one open per key: ${bad.length ? `${bad.length} problems` : "ok"}`, ...bad.slice(0, 15)] };
  });
  return { ok: results.every((r) => r.ok), results };
}

module.exports = { run_verify, compare_findings, invariants, STORED_SQL };
