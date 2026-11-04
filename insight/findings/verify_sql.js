"use strict";
// Independent SQL for verify-findings (PLAN-CT-INSIGHTS.md §14.4: "every
// open finding reproduces from independent SQL at its as-of day").
//
// Re-derives every finding set-based, without the JS rules or state machine:
//   - data days from ge_ct_daily (JS: from facts), the device-midnight
//     instant from each day's first fact;
//   - a dense per-system calendar with window-function sums (JS: prefix sums);
//   - per rule, the data days on which it trips (`tr`);
//   - findings as islands of trip days: a trip more than quiet_days evaluated
//     days after the previous one starts a new finding (JS: a day-by-day fold);
//   - tube_replaced from the replacement facts.
// $1 = today (date): data on later device days is ignored, as in the run.
//
// Thresholds are written out here on purpose (not imported from rules.js),
// so a threshold edited in only one place shows up as a difference.

const FINDINGS_SQL = `
WITH
dd AS (
  SELECT d.system_id, d.d, d.last_at, s.start_at,
         row_number() OVER (PARTITION BY d.system_id ORDER BY d.d) AS i,
         max(d.d) OVER (PARTITION BY d.system_id) AS max_d
  FROM (SELECT system_id, local_day AS d, max(last_at) AS last_at FROM insight.ge_ct_daily
        WHERE local_day <= $1::date GROUP BY 1, 2) d
  JOIN (SELECT system_id, host_local::date AS d,
               (array_agg(host_datetime - (host_local - date_trunc('day', host_local)) ORDER BY host_local, host_datetime))[1] AS start_at
        FROM insight.ge_ct_facts WHERE host_local < ($1::date + 1) GROUP BY 1, 2) s USING (system_id, d)
),
cal AS (
  SELECT s.system_id, g::date AS d
  FROM (SELECT system_id, min(d) - 70 AS lo FROM dd GROUP BY 1) s
  CROSS JOIN LATERAL generate_series(s.lo::timestamp, $1::date::timestamp, interval '1 day') g
),
m AS (
  SELECT system_id, local_day AS d,
         coalesce(sum(n) FILTER (WHERE metric_key = 'tube.rotor_unexpected_stop'), 0) AS rotor,
         coalesce(sum(n) FILTER (WHERE metric_key = 'scan.abort.system'), 0) AS ab,
         coalesce(sum(n) FILTER (WHERE metric_key = 'exam.start'), 0) AS ex,
         bool_or(metric_key = 'prep.tube_temp' AND dim IN ('Fast Calibration', 'Cold Tube Warmup (Fast Calibration)')) AS fc,
         bool_or(metric_key = 'env.plenum_temp') AS e_plenum,
         bool_or(metric_key = 'env.detector_temp_low') AS e_det,
         bool_or(metric_key = 'env.humidity_out_of_range') AS e_hum,
         bool_or(metric_key IN ('env.psu_temp_out_of_spec', 'env.psu_voltage_out_of_spec')) AS e_psu,
         bool_or(metric_key IN ('op.warmup_skipped', 'op.scan_in_warmup_zone')) AS bypass,
         bool_or(metric_key = 'calibration.air_overdue') AS air
  FROM insight.ge_ct_daily WHERE local_day <= $1::date GROUP BY 1, 2
),
c AS (
  SELECT cal.system_id, cal.d, (dd.d IS NOT NULL) AS is_data,
         coalesce(m.rotor, 0) AS rotor, coalesce(m.ab, 0) AS ab, coalesce(m.ex, 0) AS ex,
         (coalesce(m.ex, 0) > 0) AS scan, coalesce(m.fc, false) AS fc,
         coalesce(m.e_plenum, false) AS e_plenum, coalesce(m.e_det, false) AS e_det, coalesce(m.e_hum, false) AS e_hum,
         coalesce(m.e_psu, false) AS e_psu, coalesce(m.bypass, false) AS bypass, coalesce(m.air, false) AS air
  FROM cal LEFT JOIN dd USING (system_id, d) LEFT JOIN m USING (system_id, d)
),
w AS (
  SELECT c.*,
         sum(rotor) OVER w7 AS rotor7, sum(is_data::int) OVER w7 AS data7,
         sum(ab) OVER w7 AS ab7, sum(ex) OVER w7 AS ex7, sum(ab) OVER w28 AS ab28, sum(ex) OVER w28 AS ex28,
         sum(ab) OVER wb AS abb, sum(ex) OVER wb AS exb,
         sum(scan::int) OVER w14 AS scan14, sum((scan AND NOT fc)::int) OVER w14 AS nofc14,
         sum(scan::int) OVER w28 AS scan28, sum((scan AND bypass)::int) OVER w28 AS byp28,
         bool_or(bypass) OVER (PARTITION BY system_id ORDER BY d ROWS UNBOUNDED PRECEDING) AS capable,
         sum(e_plenum::int) OVER w7 AS plenum7, sum(e_det::int) OVER w7 AS det7, sum(e_hum::int) OVER w7 AS hum7,
         sum(e_psu::int) OVER w7 AS psu7, sum(air::int) OVER w7 AS air7
  FROM c
  WINDOW w7 AS (PARTITION BY system_id ORDER BY d ROWS BETWEEN 6 PRECEDING AND CURRENT ROW),
         w14 AS (PARTITION BY system_id ORDER BY d ROWS BETWEEN 13 PRECEDING AND CURRENT ROW),
         w28 AS (PARTITION BY system_id ORDER BY d ROWS BETWEEN 27 PRECEDING AND CURRENT ROW),
         wb AS (PARTITION BY system_id ORDER BY d ROWS BETWEEN 62 PRECEDING AND 7 PRECEDING)
),
wk AS (
  SELECT w.*,
         ARRAY[rotor7, lag(rotor7, 7) OVER p, lag(rotor7, 14) OVER p, lag(rotor7, 21) OVER p] AS recent,
         array_remove(ARRAY[
           CASE WHEN lag(data7, 7) OVER p > 0 THEN lag(rotor7, 7) OVER p END,
           CASE WHEN lag(data7, 14) OVER p > 0 THEN lag(rotor7, 14) OVER p END,
           CASE WHEN lag(data7, 21) OVER p > 0 THEN lag(rotor7, 21) OVER p END,
           CASE WHEN lag(data7, 28) OVER p > 0 THEN lag(rotor7, 28) OVER p END,
           CASE WHEN lag(data7, 35) OVER p > 0 THEN lag(rotor7, 35) OVER p END,
           CASE WHEN lag(data7, 42) OVER p > 0 THEN lag(rotor7, 42) OVER p END,
           CASE WHEN lag(data7, 49) OVER p > 0 THEN lag(rotor7, 49) OVER p END,
           CASE WHEN lag(data7, 56) OVER p > 0 THEN lag(rotor7, 56) OVER p END], NULL) AS base
  FROM w WINDOW p AS (PARTITION BY system_id ORDER BY d)
),
r1 AS (
  SELECT system_id, d, recent[1] AS obs,
         (SELECT count(*) FROM unnest(recent) x WHERE x >= 5) >= 3 AS sustained,
         CASE WHEN cardinality(base) >= 4 THEN (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY x) FROM unnest(base) x) END AS med
  FROM wk WHERE is_data
),
safe AS (
  SELECT s.system_id, s.host_local::date AS d, coalesce(s.attrs ->> 'ermes', '') AS code
  FROM insight.ge_ct_facts s
  WHERE s.metric_key = 'scan.safe_state' AND s.host_local < ($1::date + 1)
    AND coalesce(s.attrs ->> 'ermes', '') <> '260116316'
    AND NOT EXISTS (SELECT 1 FROM insight.ge_ct_facts b
                    WHERE b.system_id = s.system_id AND b.metric_key IN ('system.boot', 'system.shutdown')
                      AND b.host_local < ($1::date + 1)
                      AND b.host_datetime BETWEEN s.host_datetime - interval '30 minutes' AND s.host_datetime + interval '30 minutes')
),
r4 AS (
  SELECT dd.system_id, dd.d, max(x.n) AS obs
  FROM dd JOIN LATERAL (SELECT safe.code, count(*) AS n FROM safe
                        WHERE safe.system_id = dd.system_id AND safe.d BETWEEN dd.d - 6 AND dd.d GROUP BY safe.code) x ON true
  GROUP BY 1, 2 HAVING max(x.n) >= 3
),
ub AS (
  SELECT b.system_id, b.host_local::date AS d
  FROM insight.ge_ct_facts b
  WHERE b.metric_key = 'system.boot' AND (b.attrs ->> 'clean')::boolean IS NOT TRUE AND b.host_local < ($1::date + 1)
    AND NOT EXISTS (SELECT 1 FROM insight.ge_ct_facts e
                    WHERE e.system_id = b.system_id AND e.metric_key = 'service.mode' AND e.value_text = 'enter'
                      AND e.host_local < ($1::date + 1)
                      AND e.host_datetime < b.host_datetime AND e.host_datetime >= b.host_datetime - interval '12 hours')
),
r9 AS (
  SELECT dd.system_id, dd.d, count(*) AS obs
  FROM dd JOIN ub ON ub.system_id = dd.system_id AND ub.d BETWEEN dd.d - 6 AND dd.d
  GROUP BY 1, 2 HAVING count(*) >= 3
),
tr AS (
  SELECT system_id, 'tube_rotor_instability' AS k, d, CASE WHEN sustained THEN 'high' ELSE 'medium' END AS sev,
         obs::double precision AS obs, med AS base, 27 AS back
  FROM r1 WHERE sustained OR (obs >= 5 AND med IS NOT NULL AND obs >= 2 * med)
  UNION ALL
  SELECT x.system_id, 'process_restart_loop', x.local_day, 'medium', max(x.n)::double precision, NULL, 0
  FROM insight.ge_ct_daily x JOIN dd ON dd.system_id = x.system_id AND dd.d = x.local_day
  WHERE x.metric_key = 'process.restart' GROUP BY 1, 2, 3 HAVING max(x.n) >= 50
  UNION ALL
  SELECT system_id, 'abort_rate_high', d, 'medium',
         CASE WHEN chronic THEN round(100.0 * ab28 / ex28, 2) ELSE round(100.0 * ab7 / ex7, 2) END::double precision,
         CASE WHEN exb > 0 THEN round(100.0 * abb / exb, 2)::double precision END,
         CASE WHEN chronic THEN 27 ELSE 6 END
  FROM (SELECT w.*, (ex28 >= 20 AND 100 * ab28 >= 50 * ex28) AS chronic,
               (ex7 >= 10 AND 100 * ab7 >= 30 * ex7 AND exb > 0 AND ab7 * exb >= 3 * abb * ex7) AS spike
        FROM w WHERE is_data) a
  WHERE chronic OR spike
  UNION ALL
  SELECT system_id, 'safe_state_recurrent', d, 'medium', obs::double precision, NULL, 6 FROM r4
  UNION ALL
  SELECT system_id, 'prep_noncompliance', d, 'low', round(100.0 * nofc14 / scan14, 2)::double precision, NULL, 13
  FROM w WHERE is_data AND scan14 >= 5 AND 2 * nofc14 > scan14
  UNION ALL
  SELECT system_id, k, d, 'medium', n::double precision, NULL, 6
  FROM w CROSS JOIN LATERAL (VALUES ('env_plenum', plenum7), ('env_detector_temp', det7), ('env_humidity', hum7), ('env_psu', psu7)) v(k, n)
  WHERE is_data AND n >= 3
  UNION ALL
  SELECT system_id, 'warmup_bypass_habit', d, 'low', round(100.0 * byp28 / scan28, 2)::double precision, NULL, 27
  FROM w WHERE is_data AND capable AND scan28 > 0 AND 2 * byp28 >= scan28
  UNION ALL
  SELECT system_id, 'powered_off_without_shutdown', d, 'low', obs::double precision, NULL, 6 FROM r9
  UNION ALL
  SELECT system_id, 'air_calibration_overdue', d, 'low', air7::double precision, NULL, 6 FROM w WHERE is_data AND air7 >= 3
),
t2 AS (
  SELECT tr.*, dd.i, dd.start_at, CASE WHEN tr.k = 'process_restart_loop' THEN 7 ELSE 14 END AS q,
         lag(dd.i) OVER (PARTITION BY tr.system_id, tr.k ORDER BY tr.d) AS prev_i
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
         (array_agg(start_at + back * interval '-24 hours' ORDER BY d DESC))[1] AS window_start,
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
),
rep0 AS (
  SELECT f.system_id, (f.attrs ->> 'install_date')::date AS inst,
         CASE WHEN f.attrs ->> 'confidence' = 'confirmed' THEN 'info' ELSE 'low' END AS severity, f.value_num AS old_mas
  FROM insight.ge_ct_facts f WHERE f.metric_key = 'tube.replacement' AND f.host_local < ($1::date + 1)
),
rep AS (  -- opens on the first data day on or after the install date; same opening day: the later install wins
  SELECT DISTINCT ON (system_id, open_day) * FROM (
    SELECT rep0.*, (SELECT min(dd.d) FROM dd WHERE dd.system_id = rep0.system_id AND dd.d >= rep0.inst) AS open_day FROM rep0) x
  WHERE open_day IS NOT NULL
  ORDER BY system_id, open_day, inst DESC
),
rep2 AS (
  SELECT rep.*, lead(open_day) OVER (PARTITION BY system_id ORDER BY open_day) AS next_open,
         (SELECT min(dd.d) FROM dd WHERE dd.system_id = rep.system_id AND dd.d >= rep.inst + 30) AS due
  FROM rep
),
events AS (
  SELECT rep2.system_id, 'tube_replaced' AS finding_key, rep2.severity, o.start_at AS opened_at,
         least(rep2.due, rep2.next_open) AS resolved_day, r.start_at AS resolved_at,
         rep2.old_mas AS observed, NULL::double precision AS baseline,
         o.start_at AS window_start, o.start_at + 30 * interval '24 hours' AS window_end,
         rep2.open_day AS opened_day, NULL::date AS last_trip_day, NULL::int AS trip_days,
         coalesce(least(rep2.due, rep2.next_open), mx.max_d) AS data_through
  FROM rep2
  JOIN dd o ON o.system_id = rep2.system_id AND o.d = rep2.open_day
  LEFT JOIN dd r ON r.system_id = rep2.system_id AND r.d = least(rep2.due, rep2.next_open)
  JOIN (SELECT DISTINCT system_id, max_d FROM dd) mx ON mx.system_id = rep2.system_id
)
SELECT x.system_id, x.finding_key, x.severity, x.opened_at, x.resolved_at,
       CASE WHEN x.resolved_day IS NULL THEN 'open' ELSE 'resolved' END AS status,
       x.observed, x.baseline, x.window_start, x.window_end,
       to_char(x.opened_day, 'YYYY-MM-DD') AS opened_day, to_char(x.last_trip_day, 'YYYY-MM-DD') AS last_trip_day, x.trip_days,
       to_char(x.data_through, 'YYYY-MM-DD') AS data_through, l.last_at AS last_evaluated
FROM (SELECT * FROM windowed UNION ALL SELECT * FROM events) x
JOIN dd l ON l.system_id = x.system_id AND l.d = x.data_through
ORDER BY 1, 2, 4`;

module.exports = { FINDINGS_SQL };
