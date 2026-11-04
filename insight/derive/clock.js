"use strict";
// Stage 6: insight.system_clock (§13.2 item 2): estimate and flag, never
// used to correct timestamps. Fleet-wide, once per run.
//
// lag = capture_datetime - newest host_datetime in that capture, over the
// trailing WINDOW_DAYS. A device whose clock runs ahead shows negative lags
// (its records look newer than the moment they were fetched).
//   ahead   : p10 lag < 0; est_offset_min = -p10 (a lower bound)
//   lagging : p10 lag > LAGGING_MIN (slow clock or slow uploads; ambiguous)
//   jumps   : p10 fine but min lag < -JUMP_MIN (one-off clock jumps, e.g. DST)
//   ok      : otherwise
// Systems with fewer than MIN_CAPTURES captures get no row (an existing row
// is left as it was, with its own window).
const { pgp } = require("../db");

const WINDOW_DAYS = 30;
const MIN_CAPTURES = 5;
const LAGGING_MIN = 45;
const JUMP_MIN = 5;

const LAG_SQL = `
  WITH cap AS (
    SELECT system_id, capture_datetime, max(host_datetime) AS newest
    FROM log.ge_ct_gesys
    WHERE capture_datetime >= $1 AND capture_datetime < $2 AND host_datetime IS NOT NULL
    GROUP BY system_id, capture_datetime
  ), lag AS (
    SELECT system_id, extract(epoch FROM capture_datetime - newest) / 60.0 AS lag_min FROM cap
  )
  SELECT system_id, count(*)::int AS captures,
         min(lag_min)::double precision AS min_lag,
         percentile_cont(0.10) WITHIN GROUP (ORDER BY lag_min)::double precision AS p10_lag,
         percentile_cont(0.50) WITHIN GROUP (ORDER BY lag_min)::double precision AS median_lag
  FROM lag GROUP BY system_id ORDER BY system_id`;

const round1 = (x) => Math.round(x * 10) / 10;

// Pure.
function classify_clock({ captures, p10_lag, min_lag }) {
  if (captures < MIN_CAPTURES) return null;
  if (p10_lag < 0) return { flag: "ahead", est_offset_min: round1(-p10_lag) };
  if (p10_lag > LAGGING_MIN) return { flag: "lagging", est_offset_min: 0 };
  if (min_lag < -JUMP_MIN) return { flag: "jumps", est_offset_min: 0 };
  return { flag: "ok", est_offset_min: 0 };
}

const CLOCK_CS = new pgp.helpers.ColumnSet(
  ["system_id", "est_offset_min", "p10_lag_min", "min_lag_min", "median_lag_min", "captures", "flag", "window_start", "window_end"],
  { table: new pgp.helpers.TableName({ table: "system_clock", schema: "insight" }) }
);
const UPSERT_SUFFIX = ` ON CONFLICT (system_id) DO UPDATE SET est_offset_min = EXCLUDED.est_offset_min,
  p10_lag_min = EXCLUDED.p10_lag_min, min_lag_min = EXCLUDED.min_lag_min, median_lag_min = EXCLUDED.median_lag_min,
  captures = EXCLUDED.captures, flag = EXCLUDED.flag, window_start = EXCLUDED.window_start,
  window_end = EXCLUDED.window_end, computed_at = now()`;

// Read-only part (also used by verify-derive and the checkpoint report).
async function compute_clock(t, now) {
  const end = new Date(now);
  const start = new Date(end.getTime() - WINDOW_DAYS * 86400000);
  const rows = await t.any(LAG_SQL, [start.toISOString(), end.toISOString()]);
  const out = [];
  for (const r of rows) {
    const c = classify_clock(r);
    if (!c) continue;
    out.push({ system_id: r.system_id, est_offset_min: c.est_offset_min, p10_lag_min: round1(r.p10_lag),
      min_lag_min: round1(r.min_lag), median_lag_min: round1(r.median_lag), captures: r.captures, flag: c.flag,
      window_start: start, window_end: end });
  }
  return { rows: out, skipped: rows.filter((r) => !classify_clock(r)).map((r) => r.system_id) };
}

async function rebuild_clock(t, now) {
  const { rows, skipped } = await compute_clock(t, now);
  const n = rows.length ? (await t.result(pgp.helpers.insert(rows, CLOCK_CS) + UPSERT_SUFFIX)).rowCount : 0;
  return { upserted: n, skipped, flags: rows.reduce((m, r) => ((m[r.flag] = (m[r.flag] || 0) + 1), m), {}) };
}

module.exports = { rebuild_clock, compute_clock, classify_clock, WINDOW_DAYS, MIN_CAPTURES, LAGGING_MIN, JUMP_MIN };
