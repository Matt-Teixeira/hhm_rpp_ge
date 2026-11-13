"use strict";
// Independent counts for the MRI-2 exit criterion (PLAN-MRI-INSIGHTS.md §4:
// "dry run equals independent SQL per system × metric"). Written from each
// metric's definition in plan §5.2 / PLAN-MRI-INSIGHTS-CODES.md §1, NOT
// translated from rules.js, so a difference means one side is wrong.
// PostgreSQL '~' is case-sensitive like the JS regexes, and '.' and '\S'
// behave the same on these one-record messages.
// $1 = from id (exclusive), $2 = to id (inclusive), $3 = system or NULL.
//
// Nothing in the GE CT or CV run loads this file.

// device wall clock from epoch, exactly the facts table's CHECK; a = table alias or ""
const host_local_sql = (a = "") => `(timestamp '1970-01-01 00:00:00' + ${a ? `${a}.` : ""}epoch * interval '1 second')`;
const HOST_LOCAL = host_local_sql();

// Records the facts table can hold (extract.js skip_reason, by definition):
// the natural key, the code, a device time, and a device month with a partition.
const STORABLE = `coalesce(system_id, '') <> '' AND epoch IS NOT NULL AND record_number_concurrent IS NOT NULL
    AND message_number IS NOT NULL AND host_datetime IS NOT NULL
    AND ${HOST_LOCAL} >= timestamp '2025-05-01 00:00:00' AND ${HOST_LOCAL} < timestamp '2029-01-01 00:00:00'`;

// A record's content (extract.js identity): md5 of code, type, message joined by U+001F.
const identity_sql = (a = "") => { const p = a ? `${a}.` : "";
  return `md5(coalesce(${p}message_number::text, '') || chr(31) || coalesce(${p}type, '') || chr(31) || coalesce(${p}message, ''))`; };
const IDENTITY_SQL = identity_sql();

const RANGE = `id > $1 AND id <= $2 AND ($3::text IS NULL OR system_id = $3)`;

const codes = (...c) => `message_number IN (${c.join(", ")})`;

// One condition per metric (on a deduped record).
const COND = {
  "mri.error": `true`,
  "mri.scans_ok": `message_number = 2218650 AND message ~ 'No of Successful Scan = [0-9]+ , No of Failed Scan = [0-9]+'`,
  "mri.scans_failed": `message_number = 2218650 AND message ~ 'No of Successful Scan = [0-9]+ , No of Failed Scan = [0-9]+'`,
  "mri.exam_started": `message_number = 2218714 AND message LIKE 'New Exam Started%'`,
  "mri.sw_start": `message_number = 200002347 AND message LIKE '%System Software is starting%'`,
  "mri.sw_stop": `message_number = 200002348 AND message LIKE '%System Software has terminated%'`,
  "mri.tps_reset": `message_number = 2227557 AND message LIKE '%Reset/Download TPS In progress%'`,
  "mri.tps_reset_failed": `message_number = 2227556 AND message LIKE '%Reset/Download TPS was not successful%'`,
  // dsserver deaths and shutdown lines are not counted (Q-M2)
  "mri.process_death": `(message_number = 200002354 AND message ~ 'An unexpected death of \\S+ caused it to be restarted')
      OR (message_number = 200002381 AND message ~ '^Process \\S+, pid [0-9]+ terminated by unexpected signal')
      OR (message_number = 200002356 AND message ~ '^\\S+ died unexpectedly'
          AND rtrim(substring(message from '^(\\S+) died unexpectedly'), '.') <> 'dsserver')
      OR (message_number = 200002352 AND message ~ 'HOST_SHUTDOWN was initiated by the death of \\S+')
      OR (message_number = 2223878 AND message ~ 'A process has crashed on the VRE.*Process: \\S+,')`,
  "mri.prescan_failed": `${codes(2224666, 2224667, 2255008)} AND message LIKE '%Prescan failed,%'`,
  "mri.autoshim_inconclusive": `message_number = 2224708 AND message LIKE '%Autoshim results inconclusive%'`,
  "mri.coil_invalid": `message_number = 2277604 AND message LIKE '%Invalid coil connected%'`,
  "mri.coil_fault": codes(2252301, 2274023, 2252395, 2252305, 103428, 2273000, 2273015, 2276129),
  "mri.cooling_fault": codes(2266425, 2266420, 2261733, 2261732, 2261731, 2266402, 2268884, 2248604),
  "mri.rf_amp_fault": codes(101255, 2254050, 2248765, 2248775, 2254352, 2254204),
  "mri.gradient_fault": codes(2244860, 2244862, 2244857, 2244861, 2244858, 2244845, 2244851, 2244847, 2244573, 2244850, 2244897, 2250109, 2250082),
  "mri.receiver_fault": codes(2267597, 2267412, 2270016, 2270023, 2270024, 2270028, 2270031, 2270032, 2267425, 2267432, 2247184, 2267637),
  "mri.table_fault": codes(103453, 103413, 103466, 2224842, 2224864, 2268955, 2268821, 103419, 103414, 2268879, 103418, 2268836, 2268819, 2261552),
  "mri.door_sensor_fault": `message_number = 2218716 AND message LIKE '%Door sensor is not working%'`,
  "mri.service_mode": `(message_number = 2218663 AND message LIKE '%GE-Service Mode%') OR (message_number = 2218664 AND message LIKE '%Normal Mode%')`,
  "mri.pm_overdue": `${codes(2218671, 2218673)} AND message LIKE '%overdue for Planned Maintenance%'`,
  "mri.iq_warning": `message_number = 2218672 AND message LIKE '%could significantly degrade Image Quality%'`,
  "mri.system_up": `message_number = 2227566 AND message ~ '^System Up\\. sw=\\S'`,
};

// The deduped, storable records: the first source row (lowest id) per key.
const BASE = `
  SELECT DISTINCT ON (system_id, epoch, record_number_concurrent) id, system_id, message_number, message
  FROM log.ge_mri_gesys
  WHERE ${RANGE} AND ${STORABLE}
  ORDER BY system_id, epoch, record_number_concurrent, id`;

// Expected facts per (system, metric).
const RECONCILE_SQL = `
WITH base AS (${BASE})
SELECT system_id, k.key, count(*)::int AS n
FROM base
CROSS JOIN LATERAL (VALUES
${Object.entries(COND).map(([k, c]) => `  ('${k}', coalesce(${c}, false))`).join(",\n")}
) AS k(key, hit)
WHERE k.hit
GROUP BY 1, 2`;

// Expected mri.error per (system, code), and the exam-summary scan sums per system.
const ERROR_DIMS_SQL = `
WITH base AS (${BASE})
SELECT system_id, message_number::text AS dim, count(*)::int AS n FROM base GROUP BY 1, 2`;
const SCAN_SUMS_SQL = `
WITH base AS (${BASE})
SELECT system_id,
       sum(substring(message from 'No of Successful Scan = ([0-9]+) ,')::bigint)::bigint AS ok,
       sum(substring(message from 'No of Failed Scan = ([0-9]+)')::bigint)::bigint AS failed
FROM base WHERE coalesce(${COND["mri.scans_ok"]}, false)
GROUP BY 1`;

// The whole range accounted for: every source row is unstorable, the first
// row of a record (counted), or a later copy (duplicate); plus the codes of
// the counted records.
const COVERAGE_SQL = `
WITH r AS (
  SELECT id, system_id, epoch, record_number_concurrent, message_number, (${STORABLE}) AS ok
  FROM log.ge_mri_gesys WHERE ${RANGE}
)
SELECT count(*)::int AS rows,
       count(*) FILTER (WHERE NOT coalesce(ok, false))::int AS unstorable,
       (SELECT count(*) FROM (SELECT DISTINCT system_id, epoch, record_number_concurrent FROM r WHERE ok) d)::int AS counted,
       coalesce((SELECT array_agg(DISTINCT message_number ORDER BY message_number) FROM r WHERE ok), '{}') AS codes
FROM r`;

// One key, two different records (plan §6.6: a DST fall-back fold). The
// facts table keeps one, so any row here fails verify and stops --apply.
// Expected: none.
const CONFLICTS_SQL = `
SELECT system_id, epoch, record_number_concurrent, count(DISTINCT ${IDENTITY_SQL})::int AS versions,
       array_agg(id ORDER BY id) AS ids
FROM log.ge_mri_gesys
WHERE ${RANGE} AND ${STORABLE}
GROUP BY 1, 2, 3
HAVING count(DISTINCT ${IDENTITY_SQL}) > 1
ORDER BY 1, 2, 3
LIMIT 50`;

module.exports = { RECONCILE_SQL, ERROR_DIMS_SQL, SCAN_SUMS_SQL, COVERAGE_SQL, CONFLICTS_SQL, COND, STORABLE, IDENTITY_SQL, HOST_LOCAL, identity_sql, host_local_sql };
