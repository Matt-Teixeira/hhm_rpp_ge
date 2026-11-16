"use strict";
// Reads one system's GE MRI findings inputs (./context.js). Read-only; works
// on any connection or transaction. Nothing in the GE CT or CV run loads
// this file.
const { SERIES_METRICS } = require("./context");
const { STOP_COMPANION } = require("../derived_sql");

// Data days: every device day with an MRI fact. start_at = the instant of
// local midnight, from the clock offset (host_datetime - host_local) of the
// day's first fact (whole hours on all 17 systems, checked 2026-11-16).
// No clock table (Q-D4).
const DAYS_SQL = `
  SELECT to_char(a.d, 'YYYY-MM-DD') AS day, a.start_at, b.last_at
  FROM (SELECT DISTINCT ON (host_local::date) host_local::date AS d,
               host_datetime - (host_local - host_local::date::timestamp) AS start_at
        FROM insight.ge_mri_facts WHERE system_id = $1
        ORDER BY host_local::date, host_local, host_datetime) a
  JOIN (SELECT host_local::date AS d, max(host_datetime) AS last_at
        FROM insight.ge_mri_facts WHERE system_id = $1 GROUP BY 1) b USING (d)
  ORDER BY a.d`;

const DAILY_SQL = `
  SELECT to_char(local_day, 'YYYY-MM-DD') AS day, metric_key AS m, dim, n::int AS n, value_sum AS v
  FROM insight.ge_mri_daily WHERE system_id = $1 AND metric_key = ANY($2)`;

// Restart events, in source order (as derived_sql.js SW_SESSIONS_SQL):
// start, stop (sw_stop or its companion), up (System Up).
const EVENTS_SQL = `
  SELECT to_char(host_local, 'YYYY-MM-DD"T"HH24:MI:SS') AS at,
         CASE metric_key WHEN 'mri.sw_start' THEN 'start' WHEN 'mri.system_up' THEN 'up' ELSE 'stop' END AS kind
  FROM insight.ge_mri_facts
  WHERE system_id = $1
    AND (metric_key IN ('mri.sw_start', 'mri.sw_stop', 'mri.system_up') OR (metric_key = 'mri.error' AND dim = '${STOP_COMPANION}'))
  ORDER BY host_local, record_number_concurrent, metric_key COLLATE "C"`;

const DEATHS_SQL = `
  SELECT to_char(host_local, 'YYYY-MM-DD"T"HH24:MI:SS') AS at, dim AS process
  FROM insight.ge_mri_facts WHERE system_id = $1 AND metric_key = 'mri.process_death'
  ORDER BY host_local, record_number_concurrent`;

async function load_inputs(t, system_id) {
  const [days, daily, events, deaths] = await Promise.all([
    t.any(DAYS_SQL, [system_id]), t.any(DAILY_SQL, [system_id, SERIES_METRICS]), t.any(EVENTS_SQL, [system_id]), t.any(DEATHS_SQL, [system_id]),
  ]);
  return { system_id, days, daily, events, deaths };
}

module.exports = { load_inputs, DAYS_SQL, DAILY_SQL, EVENTS_SQL, DEATHS_SQL };
