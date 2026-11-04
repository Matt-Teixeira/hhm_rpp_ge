"use strict";
// Work the Phase 5 stage still owes (PLAN-CT-INSIGHTS.md §15.2 items 2-3),
// kept in insight.job_state so a failed or skipped step is redone by the next
// run (each step catches up from its own state):
//
//   ge_ct_derive.last_run_stats.pending            { system: ["YYYY-MM-DD", ...] | "full" }
//     Written by extract in the SAME transaction as the facts its upserts
//     actually inserted (RETURNING), so the touched days come from the
//     inserted keys, not from a source-id range (a late-committed row has a
//     source id below the watermark). Cleared per system by derive, in that
//     system's transaction.
//   ge_ct_findings.last_run_stats.pending_systems  { system: true }
//     Set by derive in each system's transaction; cleared per system by
//     findings, in that system's transaction.
//   ge_ct_findings.last_run_stats.fleet_today      "YYYY-MM-DD"
//     The as-of date of the last all-systems findings run (the daily pass,
//     §15.3 Q3).
//
// Every writer of these rows runs under the shared advisory lock, so the
// read-merge-write below never races; FOR UPDATE is a second guard.
const { offset_breaks_sql } = require("./derive/daily");

const DERIVE_JOB = "ge_ct_derive";
const FINDINGS_JOB = "ge_ct_findings";
// A system with more pending days than this is rebuilt in full (same result,
// proved by the Phase 3 rehearsal; keeps the job_state row small after a
// manual re-extract of history).
const PENDING_FULL_DAYS = 31;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

// Appended to the facts upsert (load.js): the touched (system, device day)
// of every fact the statement inserted or replaced, and whether any of them
// breaks the host_datetime / host_local invariant the touched daily scan
// relies on (derive/daily.js; such a system gets a full rebuild).
const touched_cte = (insert_sql) => `
  WITH up AS (${insert_sql}
    RETURNING system_id, host_datetime, host_local)
  SELECT up.system_id, to_char(up.host_local, 'YYYY-MM-DD') AS day, bool_or(${offset_breaks_sql("up")}) AS offset_breaks,
         count(*)::int AS n
  FROM up GROUP BY 1, 2 ORDER BY 1, 2`;

// ---------------------------------------------------------------- pure

// pending + rows {system_id, day, offset_breaks} -> new pending (input not modified).
function merge_pending(pending, rows) {
  const out = {};
  for (const [s, v] of Object.entries(pending || {})) out[s] = Array.isArray(v) ? [...v] : "full";
  for (const r of rows) {
    if (out[r.system_id] === "full") continue;
    if (r.offset_breaks || !DAY_RE.test(r.day || "")) { out[r.system_id] = "full"; continue; }
    const days = new Set(out[r.system_id] || []);
    days.add(r.day);
    out[r.system_id] = days.size > PENDING_FULL_DAYS ? "full" : [...days].sort();
  }
  return out;
}

// pending -> derive scope Map (derive/common.js). Anything malformed is
// rebuilt in full rather than trusted.
function scope_from_pending(pending) {
  const scope = new Map();
  for (const s of Object.keys(pending || {}).sort()) {
    const v = pending[s];
    scope.set(s, Array.isArray(v) && v.every((d) => DAY_RE.test(d)) ? { days: new Set(v) } : { full: true });
  }
  return scope;
}

function pending_summary(pending) {
  const v = Object.values(pending || {});
  return { systems: v.length, days: v.reduce((n, x) => n + (Array.isArray(x) ? x.length : 0), 0), full: v.filter((x) => !Array.isArray(x)).length };
}

// The as-of date of the last all-systems findings run. Rows written before
// Phase 5 have no fleet_today: a fleet run is one with systems_selected "all".
function fleet_today_of(stats) {
  if (!stats) return null;
  if (stats.fleet_today) return stats.fleet_today;
  return stats.systems_selected === "all" && stats.today ? stats.today : null;
}

// §15.3 Q3: the first run whose UTC date differs from the last fleet run's.
const daily_pass_due = (fleet_today, today) => fleet_today !== today;

// ----------------------------------------------------------------- DB

async function read_derive_pending(t) {
  const r = await t.oneOrNone("SELECT last_run_stats -> 'pending' AS p FROM insight.job_state WHERE job_name = $1", [DERIVE_JOB]);
  return (r && r.p) || {};
}

// rows: the touched_cte result rows of one transaction's upserts.
async function record_derive_pending(t, rows) {
  if (!rows.length) return null;
  const cur = await t.oneOrNone("SELECT last_run_stats -> 'pending' AS p FROM insight.job_state WHERE job_name = $1 FOR UPDATE", [DERIVE_JOB]);
  const merged = merge_pending(cur && cur.p, rows);
  await t.none(
    `INSERT INTO insight.job_state (job_name, watermark_id, last_run_stats, updated_at)
     VALUES ($1, 0, jsonb_build_object('pending', $2::jsonb), now())
     ON CONFLICT (job_name) DO UPDATE SET
       last_run_stats = jsonb_set(coalesce(job_state.last_run_stats, '{}'::jsonb), '{pending}', $2::jsonb), updated_at = now()`,
    [DERIVE_JOB, JSON.stringify(merged)]);
  return merged;
}

function clear_derive_pending(t, system_id) {
  return t.none(
    `UPDATE insight.job_state SET last_run_stats = jsonb_set(last_run_stats, '{pending}', (last_run_stats -> 'pending') - $2::text)
     WHERE job_name = $1 AND (last_run_stats -> 'pending') ? $2::text`, [DERIVE_JOB, system_id]);
}

function mark_findings_pending(t, system_id) {
  return t.none(
    `INSERT INTO insight.job_state (job_name, watermark_id, last_run_stats, updated_at)
     VALUES ($1, 0, jsonb_build_object('pending_systems', jsonb_build_object($2::text, true)), now())
     ON CONFLICT (job_name) DO UPDATE SET
       last_run_stats = jsonb_set(coalesce(job_state.last_run_stats, '{}'::jsonb), '{pending_systems}',
                                  coalesce(job_state.last_run_stats -> 'pending_systems', '{}'::jsonb) || jsonb_build_object($2::text, true))`,
    [FINDINGS_JOB, system_id]);
}

function clear_findings_pending(t, system_id) {
  return t.none(
    `UPDATE insight.job_state SET last_run_stats = jsonb_set(last_run_stats, '{pending_systems}', (last_run_stats -> 'pending_systems') - $2::text)
     WHERE job_name = $1 AND (last_run_stats -> 'pending_systems') ? $2::text`, [FINDINGS_JOB, system_id]);
}

module.exports = {
  touched_cte, merge_pending, scope_from_pending, pending_summary, fleet_today_of, daily_pass_due,
  read_derive_pending, record_derive_pending, clear_derive_pending, mark_findings_pending, clear_findings_pending,
  PENDING_FULL_DAYS, DERIVE_JOB, FINDINGS_JOB,
};
