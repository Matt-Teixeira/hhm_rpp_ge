"use strict";
// Independent SQL for the GE CV verify-findings (PLAN-CV-INSIGHTS.md §10.4,
// §10.7: "verify-findings (ge_cv) equals independent SQL at each system's
// as-of day").
//
// Re-derives every CV finding set-based, without the JS rules or CT's state
// machine (same method as insight/findings/verify_sql.js):
//   - data days from ge_cv_daily (JS: from facts), the device-midnight
//     instant from each day's first fact;
//   - per data day the series, the residual and the 28-day baselines
//     (percentile_cont over the data days before; JS: median);
//   - per data day, 7- and 28-day RANGE windows over data days (JS: dense
//     prefix sums), and the rules' trip days (`tr`);
//   - findings as islands of trip days: a trip more than 14 evaluated days
//     after the previous one starts a new finding (JS: a day-by-day fold).
// $1 = today (date): data on later device days is ignored, as in the run.
//
// Thresholds are written out here on purpose (not imported from rules.js),
// so a threshold edited in only one place shows up as a difference.
// Nothing in the GE CT run loads this file.

const FINDINGS_SQL = `
WITH
dd AS (
  SELECT d.system_id, d.d, d.last_at, s.start_at,
         row_number() OVER (PARTITION BY d.system_id ORDER BY d.d) AS i,
         max(d.d) OVER (PARTITION BY d.system_id) AS max_d
  FROM (SELECT system_id, local_day AS d, max(last_at) AS last_at FROM insight.ge_cv_daily
        WHERE local_day <= $1::date GROUP BY 1, 2) d
  JOIN (SELECT system_id, host_local::date AS d,
               (array_agg(host_datetime - (host_local - date_trunc('day', host_local)) ORDER BY host_local, host_datetime))[1] AS start_at
        FROM insight.ge_cv_facts WHERE host_local < ($1::date + 1) GROUP BY 1, 2) s USING (system_id, d)
),
m AS (
  SELECT system_id, local_day AS d,
         coalesce(sum(n) FILTER (WHERE metric_key = 'cv.error'), 0) AS err,
         coalesce(sum(n) FILTER (WHERE metric_key = 'cv.error' AND dim = '1200019'), 0) AS off,
         coalesce(sum(n) FILTER (WHERE metric_key = 'cv.detector_com_error'), 0) AS det,
         coalesce(sum(n) FILTER (WHERE metric_key = 'cv.anticollision_error'), 0) AS ac,
         coalesce(sum(n) FILTER (WHERE metric_key = 'cv.table_encoder_failure'), 0) AS tbl,
         coalesce(sum(n) FILTER (WHERE metric_key = 'cv.pib_com_loss'), 0) AS pib
  FROM insight.ge_cv_daily WHERE local_day <= $1::date GROUP BY 1, 2
),
x AS (
  SELECT dd.system_id, dd.d, m.err - m.det - m.ac - m.tbl - m.pib - m.off AS res, m.det, m.ac, m.tbl, m.pib
  FROM dd JOIN m USING (system_id, d)
),
b AS (
  SELECT x.*, rb.n AS res_n, rb.med AS res_med, ab.n AS ac_n, ab.med AS ac_med
  FROM x
  CROSS JOIN LATERAL (SELECT count(*) AS n, percentile_cont(0.5) WITHIN GROUP (ORDER BY y.res) AS med
                      FROM x y WHERE y.system_id = x.system_id AND y.d BETWEEN x.d - 28 AND x.d - 1) rb
  CROSS JOIN LATERAL (SELECT count(*) AS n, percentile_cont(0.5) WITHIN GROUP (ORDER BY y.ac) AS med
                      FROM x y WHERE y.system_id = x.system_id AND y.d BETWEEN x.d - 28 AND x.d - 1) ab
),
f AS (
  SELECT b.*,
         (res_n >= 7 AND res >= 300 AND res >= 10 * greatest(res_med, 1)) AS storm,
         (det >= 50) AS dstorm,
         (ac >= 50 AND (ac_n < 7 OR ac >= 5 * greatest(ac_med, 1))) AS burst,
         (tbl >= 5) AS t5
  FROM b
),
w AS (
  SELECT f.*,
         sum(storm::int) OVER r7 AS storm7, sum(storm::int) OVER r28 AS storm28, max(CASE WHEN storm THEN d END) OVER r7 AS storm_last,
         sum(dstorm::int) OVER r7 AS det7, sum(dstorm::int) OVER r28 AS det28, max(CASE WHEN dstorm THEN d END) OVER r7 AS det_last,
         max(CASE WHEN burst THEN d END) OVER r7 AS burst_last,
         sum(t5::int) OVER r7 AS t5_7, sum(t5::int) OVER r28 AS t5_28, sum(tbl) OVER r7 AS tbl7,
         sum(pib) OVER r7 AS pib7, sum((pib > 0)::int) OVER r7 AS pibd7
  FROM f
  WINDOW r7 AS (PARTITION BY system_id ORDER BY d RANGE BETWEEN '6 days' PRECEDING AND CURRENT ROW),
         r28 AS (PARTITION BY system_id ORDER BY d RANGE BETWEEN '27 days' PRECEDING AND CURRENT ROW)
),
tr AS (
  SELECT w.system_id, 'cv_error_storm' AS k, w.d, CASE WHEN w.storm28 >= 3 THEN 'high' ELSE 'medium' END AS sev,
         l.res::double precision AS obs, l.res_med::double precision AS base
  FROM w JOIN f l ON l.system_id = w.system_id AND l.d = w.storm_last WHERE w.storm7 > 0
  UNION ALL
  SELECT w.system_id, 'cv_detector_com_errors', w.d, CASE WHEN w.det28 >= 3 THEN 'high' ELSE 'medium' END,
         l.det::double precision, NULL
  FROM w JOIN f l ON l.system_id = w.system_id AND l.d = w.det_last WHERE w.det7 > 0
  UNION ALL
  SELECT w.system_id, 'cv_anticollision_burst', w.d, 'medium',
         l.ac::double precision, CASE WHEN l.ac_n >= 7 THEN l.ac_med END::double precision
  FROM w JOIN f l ON l.system_id = w.system_id AND l.d = w.burst_last WHERE w.burst_last IS NOT NULL
  UNION ALL
  SELECT system_id, 'cv_table_encoder_fault', d, CASE WHEN t5_28 >= 10 THEN 'high' ELSE 'medium' END, tbl7::double precision, NULL
  FROM w WHERE t5_7 >= 2
  UNION ALL
  SELECT system_id, 'cv_pib_com_loss', d, CASE WHEN pibd7 >= 3 THEN 'high' ELSE 'medium' END, pib7::double precision, NULL
  FROM w WHERE pib7 >= 3
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

module.exports = { FINDINGS_SQL };
