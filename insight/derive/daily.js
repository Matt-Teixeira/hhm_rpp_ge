"use strict";
// Stage 2: insight.ge_ct_daily, per (system, device-clock day, metric, dim)
// (§13.2 item 3). Set-based SQL over facts, derived facts included.
//
//   full system : delete the system's rows, re-aggregate all its facts
//   touched days: delete and re-aggregate only those (system, day) pairs
//
// Aggregates: n, sum / min / max of value_num, last = value_num of the
// latest fact in (host_datetime, epoch, rnc) order, last_at = its time.
// The sum is taken over numeric (exact, independent of row order) and cast
// back, so an independent re-aggregation reconciles exactly.
const { pgp } = require("../db");
const { rules } = require("../rules/ge_ct");

// dim per metric (§13.2 item 3); anything not listed is ''.
const DIM_SOURCE = {
  "error.ermes": "ermes",                       // ermes code
  "prep.tube_temp": "value_text",               // step
  "service.calibration": "value_text",          // step
  "process.restart": "value_text",              // process
  "xfer.dicom_send_start": "value_text",        // destination
  "xfer.dicom_sent": "value_text",              // destination
  "ipc.event_router_send_failed": "status",     // failure status
  "ipc.sigpipe": "status",                      // (no status in the message: always '')
};
const DIM_EXPR = {
  ermes: "coalesce((f.value_num::bigint)::text, '')",
  value_text: "coalesce(f.value_text, '')",
  status: "coalesce(f.attrs ->> 'status', '')",
};

function dim_sql() {
  const whens = Object.entries(DIM_SOURCE).map(([k, src]) => pgp.as.format("WHEN $1 THEN ", [k]) + DIM_EXPR[src]);
  return `CASE f.metric_key ${whens.join(" ")} ELSE '' END`;
}

// Pure (for tests): dim of a fact as the SQL computes it.
function dim_of(f) {
  const src = DIM_SOURCE[f.metric_key];
  if (!src) return "";
  if (src === "ermes") return f.value_num === null || f.value_num === undefined ? "" : String(Math.trunc(f.value_num));
  if (src === "value_text") return f.value_text || "";
  return (f.attrs && f.attrs.status) || "";
}

const AGG_SELECT = (where) => `
  SELECT f.system_id, f.host_local::date AS local_day, f.metric_key, ${dim_sql()} AS dim,
         count(*) AS n,
         sum(f.value_num::numeric)::double precision AS value_sum,
         min(f.value_num) AS value_min,
         max(f.value_num) AS value_max,
         (array_agg(f.value_num ORDER BY f.host_datetime DESC, f.epoch DESC, f.record_number_concurrent DESC))[1] AS value_last,
         max(f.host_datetime) AS last_at
  FROM insight.ge_ct_facts f
  WHERE ${where}
  GROUP BY 1, 2, 3, 4`;

const INSERT_PREFIX = `INSERT INTO insight.ge_ct_daily (system_id, local_day, metric_key, dim, n, value_sum, value_min, value_max, value_last, last_at)`;

// host_datetime bounds around the touched device days, so the scan uses the
// (system_id, metric_key, host_datetime) index and partition pruning.
// Invariant this relies on (review PHASE3-DERIVE-STAGES F1): the parser
// builds host_datetime from the same device date/time as host_local plus a
// time zone, so host_datetime - host_local is a zone offset, within
// +/- MAX_OFFSET_H. The bounds (2 days before, 3 after) cover that with
// room. The invariant is enforced, not assumed:
//   - touched_from_source_range promotes a system to a full rebuild (no
//     time bound) if any newly extracted fact breaks it;
//   - cli.js verify-derive checks it over all facts.
const MAX_OFFSET_H = 14;
const OFFSET_BREAKS_SQL = `abs(extract(epoch FROM f.host_datetime - (f.host_local AT TIME ZONE 'UTC'))) > ${MAX_OFFSET_H} * 3600`;
function day_bounds(days) {
  const sorted = [...days].sort();
  const lo = new Date(Date.parse(`${sorted[0]}T00:00:00Z`) - 2 * 86400000).toISOString();
  const hi = new Date(Date.parse(`${sorted[sorted.length - 1]}T00:00:00Z`) + 3 * 86400000).toISOString();
  return { lo, hi, days: sorted };
}

async function rebuild_daily(t, system_id, sysScope) {
  if (sysScope.full) {
    const del = await t.result("DELETE FROM insight.ge_ct_daily WHERE system_id = $1", [system_id]);
    const ins = await t.result(`${INSERT_PREFIX} ${AGG_SELECT("f.system_id = $1")}`, [system_id]);
    return { deleted: del.rowCount, inserted: ins.rowCount };
  }
  if (!sysScope.days.size) return { deleted: 0, inserted: 0 };
  const { lo, hi, days } = day_bounds(sysScope.days);
  const del = await t.result("DELETE FROM insight.ge_ct_daily WHERE system_id = $1 AND local_day = ANY($2::date[])", [system_id, days]);
  const ins = await t.result(`${INSERT_PREFIX} ${AGG_SELECT(
    "f.system_id = $1 AND f.host_datetime >= $2 AND f.host_datetime < $3 AND f.host_local::date = ANY($4::date[])")}`,
  [system_id, lo, hi, days]);
  return { deleted: del.rowCount, inserted: ins.rowCount, days: days.length };
}

// Every per-row metric whose name says it has a breakdown must be listed.
function unlisted_dim_metrics() {
  return rules.map((r) => r.key).filter((k) => /^(xfer|ipc)\./.test(k) && !(k in DIM_SOURCE));
}

module.exports = { rebuild_daily, dim_sql, dim_of, day_bounds, AGG_SELECT, DIM_SOURCE, unlisted_dim_metrics, MAX_OFFSET_H, OFFSET_BREAKS_SQL };
