"use strict";
// GE MRI derived queries (PLAN-MRI-INSIGHTS.md §8): read-only SQL over
// insight.ge_mri_facts / ge_mri_daily, no tables. MRI-4 (findings) uses
// them; MRI-6 turns them into api views (with the runner scope change).
// verify_derive.js checks each against an independent JS computation from
// the facts. All times are device wall clock (host_local).
//
//   CAPABILITIES  per system × metric: first / last device day, days, n
//                 (from ge_mri_daily). "Doesn't log it" is no row, not 0.
//   INVENTORY     per system: the latest System Up (software version, field
//                 strength in tesla, hardware attrs), when that version was
//                 first seen, and how many versions / field strengths.
//   SW_SESSIONS   per software start: ended by the next stop (sw_stop or its
//                 companion 200002364), or by the next start with no stop
//                 between ('no_stop': a crash or power loss), or 'open'.
//   SERVICE       GE service mode: from an 'on' (not preceded by another
//                 'on') to the next 'off', or 'open'.
//   DEATHS        every process death, with at_restart = a restart event
//                 (sw_start, sw_stop, System Up, or 200002364) on the same
//                 system within ±RESTART_WINDOW_MIN device minutes (Q-M2:
//                 shutdown kills and start-up deaths, not crashes).
//
// $1 = system or NULL (all systems). Nothing in the GE CT or CV run loads this file.

const RESTART_WINDOW_MIN = 10;
const STOP_COMPANION = 200002364; // "same event as a software stop" (codes doc §3); logged even when sw_stop is not
const SYS = `($1::text IS NULL OR system_id = $1)`;

const CAPABILITIES_SQL = `
SELECT system_id, metric_key, min(local_day)::text AS first_day, max(local_day)::text AS last_day,
       count(DISTINCT local_day)::int AS days, sum(n)::bigint AS n
FROM insight.ge_mri_daily
WHERE ${SYS}
GROUP BY 1, 2
ORDER BY 1, 2`;

const INVENTORY_SQL = `
WITH up AS (
  SELECT system_id, host_local, record_number_concurrent, id, dim AS sw, value_num AS field_strength_t, attrs
  FROM insight.ge_mri_facts WHERE metric_key = 'mri.system_up' AND ${SYS}
), latest AS (
  SELECT DISTINCT ON (system_id) * FROM up ORDER BY system_id, host_local DESC, record_number_concurrent DESC, id DESC
)
SELECT l.system_id, l.sw, l.field_strength_t, l.attrs, to_char(l.host_local, 'YYYY-MM-DD"T"HH24:MI:SS') AS last_up_at,
       (SELECT to_char(min(u.host_local), 'YYYY-MM-DD"T"HH24:MI:SS') FROM up u WHERE u.system_id = l.system_id AND u.sw = l.sw) AS sw_first_seen,
       (SELECT count(DISTINCT u.sw)::int FROM up u WHERE u.system_id = l.system_id) AS sw_versions,
       (SELECT array_agg(DISTINCT u.field_strength_t ORDER BY u.field_strength_t) FROM up u WHERE u.system_id = l.system_id AND u.field_strength_t IS NOT NULL) AS field_strengths_t,
       (SELECT count(*)::int FROM up u WHERE u.system_id = l.system_id) AS system_ups
FROM latest l
ORDER BY 1`;

const SW_SESSIONS_SQL = `
WITH e AS (
  SELECT system_id, host_local, record_number_concurrent AS rnc, metric_key,
         CASE WHEN metric_key = 'mri.sw_start' THEN 'start' ELSE 'stop' END AS kind
  FROM insight.ge_mri_facts
  WHERE ${SYS} AND (metric_key IN ('mri.sw_start', 'mri.sw_stop') OR (metric_key = 'mri.error' AND dim = '${STOP_COMPANION}'))
), s AS (
  SELECT *, lead(kind) OVER w AS next_kind, lead(host_local) OVER w AS next_at
  FROM e WINDOW w AS (PARTITION BY system_id ORDER BY host_local, rnc, metric_key COLLATE "C")
)
SELECT system_id, to_char(host_local, 'YYYY-MM-DD"T"HH24:MI:SS') AS started_at,
       CASE next_kind WHEN 'stop' THEN 'stop' WHEN 'start' THEN 'no_stop' ELSE 'open' END AS end_kind,
       to_char(next_at, 'YYYY-MM-DD"T"HH24:MI:SS') AS next_at,
       CASE WHEN next_kind = 'stop' THEN extract(epoch FROM next_at - host_local)::bigint END AS duration_s
FROM s WHERE kind = 'start'
ORDER BY 1, 2`;

const SERVICE_SESSIONS_SQL = `
WITH e AS (
  SELECT system_id, host_local, record_number_concurrent AS rnc, dim
  FROM insight.ge_mri_facts WHERE metric_key = 'mri.service_mode' AND ${SYS}
), s AS (
  SELECT *, lag(dim) OVER (PARTITION BY system_id ORDER BY host_local, rnc) AS prev FROM e
)
SELECT s.system_id, to_char(s.host_local, 'YYYY-MM-DD"T"HH24:MI:SS') AS started_at,
       to_char(o.host_local, 'YYYY-MM-DD"T"HH24:MI:SS') AS ended_at,
       CASE WHEN o.host_local IS NULL THEN 'open' ELSE 'off' END AS end_kind,
       extract(epoch FROM o.host_local - s.host_local)::bigint AS duration_s
FROM s
LEFT JOIN LATERAL (
  SELECT x.host_local FROM e x
  WHERE x.system_id = s.system_id AND x.dim = 'off' AND (x.host_local, x.rnc) > (s.host_local, s.rnc)
  ORDER BY x.host_local, x.rnc LIMIT 1
) o ON true
WHERE s.dim = 'on' AND s.prev IS DISTINCT FROM 'on'
ORDER BY 1, 2`;

const DEATHS_SQL = `
SELECT d.system_id, to_char(d.host_local, 'YYYY-MM-DD"T"HH24:MI:SS') AS at, d.dim AS process, d.message_number,
       EXISTS (
         SELECT 1 FROM insight.ge_mri_facts r
         WHERE r.system_id = d.system_id
           AND r.host_local BETWEEN d.host_local - interval '${RESTART_WINDOW_MIN} minutes' AND d.host_local + interval '${RESTART_WINDOW_MIN} minutes'
           AND (r.metric_key IN ('mri.sw_start', 'mri.sw_stop', 'mri.system_up') OR (r.metric_key = 'mri.error' AND r.dim = '${STOP_COMPANION}'))
       ) AS at_restart
FROM insight.ge_mri_facts d
WHERE d.metric_key = 'mri.process_death' AND ${SYS.replace(/system_id/g, "d.system_id")}
ORDER BY 1, 2, 3`;

module.exports = { CAPABILITIES_SQL, INVENTORY_SQL, SW_SESSIONS_SQL, SERVICE_SESSIONS_SQL, DEATHS_SQL, RESTART_WINDOW_MIN, STOP_COMPANION };
