"use strict";
// Independent SQL for the GE MRI verify-findings (PLAN-MRI-INSIGHTS.md §9.6:
// "verify-findings (ge_mri) equals the independent SQL at each system's
// as-of day").
//
// Re-derives every MRI finding set-based, without the JS rules or CT's
// state machine (same method as insight/findings/verify_sql.js and CV's):
//   - data days from ge_mri_daily (JS: from facts), the device-midnight
//     instant and the newest fact from the facts;
//   - per data day the series; rule 10's residual from ge_mri_codes.category
//     (JS: codes_reviewed.js) and the excluded codes written out below;
//   - the 28-day baselines (percentile_cont over the data days before; JS:
//     median), 7- and 28-day RANGE windows over data days (JS: dense prefix
//     sums); rule 1's baseline over D-34..D-7;
//   - rule 4 per death and as-of day: at a restart = a restart event within
//     10 device minutes; for a death on the as-of day only events on a day
//     <= it count (JS: strict / full counts);
//   - rule 11 by lag() over the software events (JS: a walk in source order);
//   - findings as islands of trip days: a trip more than 14 evaluated days
//     after the previous one starts a new finding (JS: a day-by-day fold).
// $1 = today (date): data on later device days is ignored, as in the run.
//
// Thresholds and code lists are written out here on purpose (not imported
// from rules.js / context.js), so an edit in only one place shows up as a
// difference (a test pins them equal).
// Nothing in the GE CT or CV run loads this file.

// Rule 10: codes with a finding of their own (rules 2-9) and the restart signatures.
const RESIDUAL_EXCLUDED = [
  // cooling
  2266425, 2266420, 2261733, 2261732, 2261731, 2266402, 2268884, 2248604,
  // TPS reset failed, StartupCondition TPS reset failure
  2227556, 2256925,
  // process deaths
  200002354, 200002381, 200002356, 200002352, 2223878,
  // prescan
  2224666, 2224667, 2255008,
  // coil faults
  2252301, 2274023, 2252395, 2252305, 103428, 2273000, 2273015, 2276129,
  // table faults
  103453, 103413, 103466, 2224842, 2224864, 2268955, 2268821, 103419, 103414, 2268879, 103418, 2268836, 2268819, 2261552,
  // image-quality warning, PM overdue
  2218672, 2218671, 2218673,
  // software start / stop, stop companion, exited with status, msgView
  200002347, 200002348, 200002364, 200002379, 5600,
];
const PRESCAN_OPERATOR = ["stop_button", "pause_button", "operator_request", "door_open", "table_not_at_scan_plane"];
const RESTART_EVENT = `(metric_key IN ('mri.sw_start', 'mri.sw_stop', 'mri.system_up') OR (metric_key = 'mri.error' AND dim = '200002364'))`;
const lit = (xs) => xs.map((x) => `'${x}'`).join(", ");

const FINDINGS_SQL = `
WITH
dd AS (
  SELECT d.system_id, d.d, s.last_at, s.start_at,
         row_number() OVER (PARTITION BY d.system_id ORDER BY d.d) AS i,
         max(d.d) OVER (PARTITION BY d.system_id) AS max_d
  FROM (SELECT DISTINCT system_id, local_day AS d FROM insight.ge_mri_daily WHERE local_day <= $1::date) d
  JOIN (SELECT system_id, host_local::date AS d, max(host_datetime) AS last_at,
               (array_agg(host_datetime - (host_local - date_trunc('day', host_local)) ORDER BY host_local, host_datetime))[1] AS start_at
        FROM insight.ge_mri_facts WHERE host_local < ($1::date + 1) GROUP BY 1, 2) s USING (system_id, d)
),
m AS (
  SELECT y.system_id, y.local_day AS d,
         coalesce(sum(y.value_sum) FILTER (WHERE y.metric_key = 'mri.scans_ok'), 0) AS ok,
         coalesce(sum(y.value_sum) FILTER (WHERE y.metric_key = 'mri.scans_failed'), 0) AS fl,
         coalesce(sum(y.n) FILTER (WHERE y.metric_key = 'mri.cooling_fault'), 0) AS cool,
         coalesce(sum(y.n) FILTER (WHERE y.metric_key = 'mri.cooling_fault' AND left(y.dim, 8) = 'hec_cryo'), 0) AS cryo,
         coalesce(sum(y.n) FILTER (WHERE y.metric_key = 'mri.tps_reset_failed' OR (y.metric_key = 'mri.error' AND y.dim = '2256925')), 0) AS tpsf,
         coalesce(sum(y.n) FILTER (WHERE y.metric_key = 'mri.prescan_failed' AND y.dim NOT IN (${lit(PRESCAN_OPERATOR)})), 0) AS pre,
         coalesce(sum(y.n) FILTER (WHERE y.metric_key = 'mri.coil_fault'), 0) AS coil,
         coalesce(sum(y.n) FILTER (WHERE y.metric_key = 'mri.table_fault'), 0) AS tbl,
         coalesce(sum(y.n) FILTER (WHERE y.metric_key = 'mri.iq_warning'), 0) AS iq,
         coalesce(sum(y.n) FILTER (WHERE y.metric_key = 'mri.pm_overdue'), 0) AS pm,
         coalesce(sum(y.n) FILTER (WHERE y.metric_key = 'mri.error' AND y.dim NOT IN (${lit(RESIDUAL_EXCLUDED)})
                                     AND (c.category IS NULL OR c.category IN ('reliability', 'hardware'))), 0) AS res
  FROM insight.ge_mri_daily y
  LEFT JOIN insight.ge_mri_codes c ON y.metric_key = 'mri.error' AND c.message_number::text = y.dim
  WHERE y.local_day <= $1::date
  GROUP BY 1, 2
),
sw AS (
  SELECT system_id, host_local, CASE WHEN metric_key = 'mri.sw_start' THEN 'start' ELSE 'stop' END AS kind,
         lag(CASE WHEN metric_key = 'mri.sw_start' THEN 'start' ELSE 'stop' END)
           OVER (PARTITION BY system_id ORDER BY host_local, record_number_concurrent, metric_key COLLATE "C") AS prev
  FROM insight.ge_mri_facts
  WHERE host_local < ($1::date + 1) AND (metric_key IN ('mri.sw_start', 'mri.sw_stop') OR (metric_key = 'mri.error' AND dim = '200002364'))
),
uc AS (
  SELECT system_id, host_local::date AS d, count(*) AS unclean FROM sw WHERE kind = 'start' AND prev = 'start' GROUP BY 1, 2
),
rv AS (
  SELECT system_id, host_local FROM insight.ge_mri_facts WHERE host_local < ($1::date + 1) AND ${RESTART_EVENT}
),
dth AS (
  SELECT x.id, x.system_id, x.host_local::date AS dday, x.dim AS proc,
         count(r.host_local) > 0 AS mark_any,
         count(r.host_local) FILTER (WHERE r.host_local::date <= x.host_local::date) > 0 AS mark_early
  FROM insight.ge_mri_facts x
  LEFT JOIN rv r ON r.system_id = x.system_id
              AND r.host_local BETWEEN x.host_local - interval '10 minutes' AND x.host_local + interval '10 minutes'
  WHERE x.metric_key = 'mri.process_death' AND x.host_local < ($1::date + 1)
  GROUP BY x.id, x.host_local, x.system_id, x.dim
),
cr AS (
  SELECT system_id, d, max(cnt) AS crash_max
  FROM (SELECT dd.system_id, dd.d, x.proc, count(*) AS cnt
        FROM dd JOIN dth x ON x.system_id = dd.system_id AND x.dday BETWEEN dd.d - 6 AND dd.d
        WHERE (x.dday < dd.d AND NOT x.mark_any) OR (x.dday = dd.d AND NOT x.mark_early)
        GROUP BY 1, 2, 3) q
  GROUP BY 1, 2
),
x AS (
  SELECT dd.system_id, dd.d, m.ok, m.fl, m.cool, m.cryo, m.tpsf, m.pre, m.coil, m.tbl, m.iq, m.pm, m.res,
         coalesce(uc.unclean, 0) AS unclean, coalesce(cr.crash_max, 0) AS crash_max
  FROM dd JOIN m USING (system_id, d) LEFT JOIN uc USING (system_id, d) LEFT JOIN cr USING (system_id, d)
),
b AS (
  SELECT x.*, pb.n AS pre_n, pb.med AS pre_med, tb.n AS tbl_n, tb.med AS tbl_med, rb.n AS res_n, rb.med AS res_med
  FROM x
  CROSS JOIN LATERAL (SELECT count(*) AS n, percentile_cont(0.5) WITHIN GROUP (ORDER BY y.pre) AS med
                      FROM x y WHERE y.system_id = x.system_id AND y.d BETWEEN x.d - 28 AND x.d - 1) pb
  CROSS JOIN LATERAL (SELECT count(*) AS n, percentile_cont(0.5) WITHIN GROUP (ORDER BY y.tbl) AS med
                      FROM x y WHERE y.system_id = x.system_id AND y.d BETWEEN x.d - 28 AND x.d - 1) tb
  CROSS JOIN LATERAL (SELECT count(*) AS n, percentile_cont(0.5) WITHIN GROUP (ORDER BY y.res) AS med
                      FROM x y WHERE y.system_id = x.system_id AND y.d BETWEEN x.d - 28 AND x.d - 1) rb
),
f AS (
  SELECT b.*,
         (pre >= 15 AND pre_n >= 7 AND pre >= 5 * greatest(pre_med, 1)) AS pspk,
         (tbl >= 10 AND tbl_n >= 7 AND tbl >= 5 * greatest(tbl_med, 1)) AS tspk,
         (res >= 300 AND res_n >= 7 AND res >= 10 * greatest(res_med, 1)) AS storm
  FROM b
),
w AS (
  SELECT f.*,
         sum(ok) OVER r7 AS ok7, sum(fl) OVER r7 AS fl7, coalesce(sum(ok) OVER rb, 0) AS okb, coalesce(sum(fl) OVER rb, 0) AS flb,
         sum((cool > 0)::int) OVER r7 AS coold7, sum((cool >= 50)::int) OVER r7 AS coolb7, sum(cool) OVER r7 AS cool7, sum(cryo) OVER r7 AS cryo7,
         sum((tpsf > 0)::int) OVER r7 AS tpsd7, sum((tpsf > 0)::int) OVER r28 AS tpsd28,
         max(CASE WHEN pspk THEN d END) OVER r7 AS pre_last,
         sum((coil > 0)::int) OVER r7 AS coild7, sum((coil > 0)::int) OVER r28 AS coild28, sum(coil) OVER r7 AS coil7,
         max(CASE WHEN tspk THEN d END) OVER r7 AS tbl_last, sum((tbl >= 10)::int) OVER r7 AS tpd7, sum(tbl) OVER r7 AS tbl7,
         sum((iq > 0)::int) OVER r7 AS iqd7, sum(iq) OVER r7 AS iq7,
         sum((pm > 0)::int) OVER r7 AS pmd7,
         sum(storm::int) OVER r7 AS st7, sum(storm::int) OVER r28 AS st28, max(CASE WHEN storm THEN d END) OVER r7 AS st_last,
         sum(unclean) OVER r7 AS uc7
  FROM f
  WINDOW r7 AS (PARTITION BY system_id ORDER BY d RANGE BETWEEN '6 days' PRECEDING AND CURRENT ROW),
         r28 AS (PARTITION BY system_id ORDER BY d RANGE BETWEEN '27 days' PRECEDING AND CURRENT ROW),
         rb AS (PARTITION BY system_id ORDER BY d RANGE BETWEEN '34 days' PRECEDING AND '7 days' PRECEDING)
),
tr AS (
  SELECT system_id, 'mri_failed_scans_high' AS k, d, 'medium' AS sev,
         100.0 * fl7 / (ok7 + fl7) AS obs, 100.0 * flb / (okb + flb) AS base
  FROM w WHERE okb + flb >= 100 AND fl7 >= 10 AND 100 * fl7 >= 5 * (ok7 + fl7) AND fl7 * (okb + flb) >= 3 * flb * (ok7 + fl7)
  UNION ALL
  SELECT system_id, 'mri_cooling_fault', d, CASE WHEN coolb7 > 0 OR cryo7 > 0 THEN 'high' ELSE 'medium' END, cool7::double precision, NULL
  FROM w WHERE coold7 >= 3 OR coolb7 > 0
  UNION ALL
  SELECT system_id, 'mri_tps_reset_failures', d, CASE WHEN tpsd28 >= 4 THEN 'high' ELSE 'medium' END, tpsd7::double precision, NULL
  FROM w WHERE tpsd7 >= 2
  UNION ALL
  SELECT system_id, 'mri_process_crash_loop', d, CASE WHEN crash_max >= 20 THEN 'high' ELSE 'medium' END, crash_max::double precision, NULL
  FROM w WHERE crash_max >= 5
  UNION ALL
  SELECT w.system_id, 'mri_prescan_failures', w.d, 'medium', l.pre::double precision, l.pre_med::double precision
  FROM w JOIN f l ON l.system_id = w.system_id AND l.d = w.pre_last WHERE w.pre_last IS NOT NULL
  UNION ALL
  SELECT system_id, 'mri_coil_fault', d, CASE WHEN coild28 >= 14 THEN 'high' ELSE 'medium' END, coil7::double precision, NULL
  FROM w WHERE coild7 >= 4
  UNION ALL
  SELECT w.system_id, 'mri_table_fault', w.d, 'medium',
         CASE WHEN w.tbl_last IS NOT NULL THEN l.tbl ELSE w.tbl7 END::double precision,
         CASE WHEN w.tbl_last IS NOT NULL THEN l.tbl_med END::double precision
  FROM w LEFT JOIN f l ON l.system_id = w.system_id AND l.d = w.tbl_last WHERE w.tbl_last IS NOT NULL OR w.tpd7 >= 5
  UNION ALL
  SELECT system_id, 'mri_image_quality_warning', d, 'medium', iq7::double precision, NULL
  FROM w WHERE iqd7 >= 2
  UNION ALL
  SELECT system_id, 'mri_pm_overdue', d, 'low', pmd7::double precision, NULL
  FROM w WHERE pmd7 >= 3
  UNION ALL
  SELECT w.system_id, 'mri_error_storm', w.d, CASE WHEN w.st28 >= 3 THEN 'high' ELSE 'medium' END, l.res::double precision, l.res_med::double precision
  FROM w JOIN f l ON l.system_id = w.system_id AND l.d = w.st_last WHERE w.st7 > 0
  UNION ALL
  SELECT system_id, 'mri_unclean_restarts', d, 'low', uc7::double precision, NULL
  FROM w WHERE uc7 >= 3
),
t2 AS (
  SELECT tr.*, dd.i, dd.start_at, 14 AS q, lag(dd.i) OVER (PARTITION BY tr.system_id, tr.k ORDER BY tr.d) AS prev_i
  FROM tr JOIN dd USING (system_id, d)
),
t3 AS (
  SELECT t2.*, sum(CASE WHEN prev_i IS NULL OR i - prev_i > q THEN 1 ELSE 0 END)
                 OVER (PARTITION BY system_id, k ORDER BY d ROWS UNBOUNDED PRECEDING) AS grp
  FROM t2
),
isl AS (
  SELECT system_id, k, grp, max(q) AS q, min(d) AS opened_day, max(d) AS last_trip_day, max(i) AS last_i, count(*) AS trip_days,
         (array_agg(sev ORDER BY array_position(ARRAY['info','low','medium','high'], sev) DESC))[1] AS severity,
         (array_agg(obs ORDER BY d DESC))[1] AS observed, (array_agg(base ORDER BY d DESC))[1] AS baseline,
         (array_agg(start_at + 6 * interval '-24 hours' ORDER BY d DESC))[1] AS window_start,
         (array_agg(start_at + interval '24 hours' ORDER BY d DESC))[1] AS window_end
  FROM t3 GROUP BY system_id, k, grp
),
windowed AS (
  SELECT isl.system_id, isl.k AS finding_key, isl.severity, o.start_at AS opened_at, r.d AS resolved_day, r.start_at AS resolved_at,
         isl.observed, isl.baseline, isl.window_start, isl.window_end, isl.opened_day, isl.last_trip_day, isl.trip_days::int,
         coalesce(r.d, mx.max_d) AS data_through
  FROM isl
  JOIN dd o ON o.system_id = isl.system_id AND o.d = isl.opened_day
  LEFT JOIN dd r ON r.system_id = isl.system_id AND r.i = isl.last_i + isl.q
  JOIN (SELECT DISTINCT system_id, max_d FROM dd) mx ON mx.system_id = isl.system_id
)
SELECT x.system_id, x.finding_key, x.severity, x.opened_at, x.resolved_at,
       CASE WHEN x.resolved_day IS NULL THEN 'open' ELSE 'resolved' END AS status,
       x.observed, x.baseline, x.window_start, x.window_end,
       to_char(x.opened_day, 'YYYY-MM-DD') AS opened_day, to_char(x.last_trip_day, 'YYYY-MM-DD') AS last_trip_day, x.trip_days,
       to_char(x.data_through, 'YYYY-MM-DD') AS data_through, l.last_at AS last_evaluated
FROM windowed x
JOIN dd l ON l.system_id = x.system_id AND l.d = x.data_through
ORDER BY 1, 2, 4`;

module.exports = { FINDINGS_SQL, RESIDUAL_EXCLUDED, PRESCAN_OPERATOR };
