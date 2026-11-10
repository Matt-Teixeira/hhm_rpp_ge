"use strict";
// Reads one system's GE CV findings inputs (./context.js). Read-only; works
// on any connection or transaction. Nothing in the GE CT run loads this file.
const { SERIES_METRICS } = require("./context");

// Data days: every device day with a CV fact. start_at = the instant of
// local midnight, from the clock offset (host_datetime - host_local) of the
// day's first fact (offsets are whole hours on both systems, checked
// 2026-11-10: PDT / PST). No clock table (plan §9.4 K1).
const DAYS_SQL = `
  SELECT to_char(a.d, 'YYYY-MM-DD') AS day, a.start_at, b.last_at
  FROM (SELECT DISTINCT ON (host_local::date) host_local::date AS d,
               host_datetime - (host_local - host_local::date::timestamp) AS start_at
        FROM insight.ge_cv_facts WHERE system_id = $1
        ORDER BY host_local::date, host_local, host_datetime) a
  JOIN (SELECT host_local::date AS d, max(host_datetime) AS last_at
        FROM insight.ge_cv_facts WHERE system_id = $1 GROUP BY 1) b USING (d)
  ORDER BY a.d`;

const DAILY_SQL = `
  SELECT to_char(local_day, 'YYYY-MM-DD') AS day, metric_key AS m, dim, n::int AS n
  FROM insight.ge_cv_daily WHERE system_id = $1 AND metric_key = ANY($2)`;

async function load_inputs(t, system_id) {
  const [days, daily] = await Promise.all([t.any(DAYS_SQL, [system_id]), t.any(DAILY_SQL, [system_id, SERIES_METRICS])]);
  return { system_id, days, daily };
}

module.exports = { load_inputs, DAYS_SQL, DAILY_SQL };
