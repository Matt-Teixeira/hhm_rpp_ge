"use strict";
// Shared helpers for insight/derive (PLAN-CT-INSIGHTS.md §13.4 step 3).

const { pgp } = require("../db");

const DAY_MS = 24 * 3600 * 1000;

// Facts of one system for the given metrics, in (time, epoch, rnc) order.
// host_local is selected as text: the device wall clock must not be
// re-interpreted in the process time zone (rules/ge_ct_derived.js).
const FACTS_SQL = `
  SELECT id, system_id, epoch, record_number_concurrent, metric_key, host_datetime,
         to_char(host_local, 'YYYY-MM-DD"T"HH24:MI:SS') AS host_local,
         value_num, value_text, exam_no, attrs, source_id, source_capture_datetime, rule_version
  FROM insight.ge_ct_facts
  WHERE system_id = $1 AND metric_key = ANY($2) AND ($3::timestamptz IS NULL OR host_datetime >= $3)
  ORDER BY host_datetime, epoch, record_number_concurrent`;

function load_facts(t, system_id, metrics, from = null) {
  return t.any(FACTS_SQL, [system_id, metrics, from]);
}

// (time, epoch, rnc) comparison, the order used everywhere in derive.
const ms = (f) => new Date(f.host_datetime).getTime();
function cmp(a, b) {
  return ms(a) - ms(b) || a.epoch - b.epoch || a.record_number_concurrent - b.record_number_concurrent;
}

// Multi-row INSERT in chunks; returns rows inserted.
async function insert_rows(t, rows, cs, chunk = 2000) {
  let n = 0;
  for (let i = 0; i < rows.length; i += chunk) {
    n += (await t.result(pgp.helpers.insert(rows.slice(i, i + chunk), cs))).rowCount;
  }
  return n;
}

// Scope: Map system_id -> { full: true } | { days: Set<'YYYY-MM-DD'> }.
function scope_full(systems) {
  return new Map(systems.map((s) => [s, { full: true }]));
}

function scope_touched(rows) {
  const m = new Map();
  for (const { system_id, day } of rows) {
    if (!m.has(system_id)) m.set(system_id, { days: new Set() });
    m.get(system_id).days.add(day);
  }
  return m;
}

// Add days to a system's scope (no-op for a full rebuild).
function add_days(scope, system_id, days) {
  const s = scope.get(system_id);
  if (!s || s.full) return;
  for (const d of days) s.days.add(d);
}

module.exports = { load_facts, cmp, insert_rows, scope_full, scope_touched, add_days, DAY_MS };
