"use strict";
// Independent SQL for the derived facts (PLAN-CT-INSIGHTS.md §13.3). Written
// separately from insight/rules/ge_ct_derived.js (window functions instead
// of the JS scan) so the two can check each other. Used to label test
// fixtures (insight/tools/build_derived_fixtures.js) and by
// `cli.js verify-derive`. Read-only.

// $1 = system_id or NULL (all). One row per boot.
const BOOTS_SQL = `
WITH i AS (
  SELECT system_id, epoch, record_number_concurrent AS rnc, host_datetime AS t,
         lag(host_datetime) OVER (PARTITION BY system_id ORDER BY host_datetime, epoch, record_number_concurrent) AS prev_init
  FROM insight.ge_ct_facts
  WHERE metric_key = 'system.sw_init_complete' AND ($1::text IS NULL OR system_id = $1)
), b AS (
  SELECT i.* FROM i
  WHERE (i.prev_init IS NULL OR i.t - i.prev_init >= interval '10 minutes')
    AND NOT EXISTS (SELECT 1 FROM insight.ge_ct_facts r
                    WHERE r.system_id = i.system_id AND r.metric_key = 'process.restart'
                      AND r.host_datetime BETWEEN i.t - interval '5 minutes' AND i.t)
), bb AS (
  SELECT b.*, lag(b.t) OVER (PARTITION BY b.system_id ORDER BY b.t, b.epoch, b.rnc) AS prev_boot FROM b
)
SELECT bb.system_id, bb.epoch, bb.rnc, bb.t,
       EXISTS (SELECT 1 FROM insight.ge_ct_facts s
               WHERE s.system_id = bb.system_id AND s.metric_key = 'system.shutdown'
                 AND s.host_datetime <= bb.t AND (bb.prev_boot IS NULL OR s.host_datetime > bb.prev_boot)) AS clean
FROM bb
ORDER BY bb.system_id, bb.t, bb.epoch, bb.rnc`;

// $1 = system_id or NULL. One row per tube counter reset that stays low,
// with the calibration count in [reset - 7 d, reset + 1 d].
const RESETS_SQL = `
WITH r AS (
  SELECT system_id, epoch, record_number_concurrent AS rnc, host_datetime AS t, host_local, value_num AS v,
         lag(value_num)     OVER w AS prev,
         lead(value_num, 1) OVER w AS n1,
         lead(value_num, 2) OVER w AS n2,
         lead(value_num, 3) OVER w AS n3
  FROM insight.ge_ct_facts
  -- finite readings only (NaN / ±Infinity are dropped, like Number.isFinite in the JS rule)
  WHERE metric_key = 'tube.mas_total' AND value_num IS NOT NULL
    AND value_num NOT IN ('NaN'::float8, 'Infinity'::float8, '-Infinity'::float8)
    AND ($1::text IS NULL OR system_id = $1)
  WINDOW w AS (PARTITION BY system_id ORDER BY host_datetime, epoch, record_number_concurrent)
)
SELECT r.system_id, r.epoch, r.rnc, r.t, r.host_local::date AS reset_day, r.prev AS old_mas, r.v AS new_mas,
       (SELECT count(*)::int FROM insight.ge_ct_facts c
         WHERE c.system_id = r.system_id AND c.metric_key = 'service.calibration'
           AND c.host_datetime BETWEEN r.t - interval '7 days' AND r.t + interval '1 day') AS calibrations
FROM r
WHERE r.prev > 100000 AND r.v < 0.5 * r.prev
  AND r.n1 IS NOT NULL AND r.n2 IS NOT NULL
  AND r.n1 < 0.5 * r.prev AND r.n2 < 0.5 * r.prev AND (r.n3 IS NULL OR r.n3 < 0.5 * r.prev)
ORDER BY r.system_id, r.t`;

module.exports = { BOOTS_SQL, RESETS_SQL };
