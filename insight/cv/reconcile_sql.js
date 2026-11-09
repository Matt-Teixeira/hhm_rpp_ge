"use strict";
// Independent per-(system, metric) counts for the CV-2 exit criterion
// (PLAN-CV-INSIGHTS.md §4: "per system and metric, counts exactly equal
// independent SQL; every code covered by a rule or the reviewed ignore
// list"). Written from each metric's definition in plan §6.2, NOT
// translated from rules.js, so a difference means one side is wrong.
// PostgreSQL '~' is case-sensitive like the JS regexes; '.' also matches a
// newline here (debug text is one line, so that changes nothing).
// $1 = from id (exclusive), $2 = to id (inclusive), $3 = system or NULL.
//
// Nothing in the GE CT run loads this file.

// The reviewed ignore list, by definition: RTA relays of positioner errors.
const RELAY = `btrim(subsystem) = 'RTA' AND sourcefile = 'XRImChainPos'`;

const COND = {
  "cv.error": `true`,
  "cv.detector_com_error": `errorcode IN (1200014, 1200114) AND debugtext ~ 'Detector com error'`,
  "cv.positioner_collision": `(errorcode = 1050168 AND debugtext ~ 'LIFT COLLISION') OR (errorcode = 1050170 AND debugtext ~ 'COLLIMATOR COLLISION')`,
  "cv.anticollision_error": `(errorcode IN (1050142, 1050143, 1050144, 1050145, 1050301, 1050302) AND debugtext ~ 'ANTICOLLISION CINEMATIC ERROR .*error on [^"]')
                             OR (errorcode = 1050177 AND debugtext ~ 'Anticollision error on axis')`,
  "cv.table_encoder_failure": `errorcode IN (1050709, 1050710, 1050711, 1050182, 1050187, 1050188)`,
  "cv.pib_com_loss": `errorcode = 1050024 AND debugtext ~ 'PIB : COM (Reset|Fail)'`,
  "cv.emergency_backout": `errorcode = 1050297 AND debugtext ~ 'Emergency backout has been pressed'`,
  "cv.dose_export_rejected": `errorcode = 2800176 AND debugtext ~ 'Association rejected'`,
  "cv.worklist_query_failed": `errorcode IN (2800036, 2800175) AND debugtext ~ 'BROWSER_(NETWORK|WL_QUERY)_FAILED'`,
};

// Rows the facts table can hold (extract.js skip_reason, by definition).
const STORABLE = `system_id IS NOT NULL AND sequencenumber IS NOT NULL AND errorcode IS NOT NULL
    AND btrim(coalesce(subsystem, '')) <> '' AND host_datetime IS NOT NULL
    AND host_date IS NOT NULL AND btrim(coalesce(host_time, '')) ~ '^[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]{1,6})?$'`;

const RANGE = `id > $1 AND id <= $2 AND ($3::text IS NULL OR system_id = $3)`;

// Expected facts per (system, metric).
const RECONCILE_SQL = `
WITH base AS (
  SELECT system_id, errorcode, debugtext
  FROM log.ge_cv_syserror
  WHERE ${RANGE} AND NOT coalesce(${RELAY}, false) AND ${STORABLE}
)
SELECT system_id, k.key, count(*)::int AS n
FROM base
CROSS JOIN LATERAL (VALUES
${Object.entries(COND).map(([k, c]) => `  ('${k}', coalesce(${c}, false))`).join(",\n")}
) AS k(key, hit)
WHERE k.hit
GROUP BY 1, 2`;

// The whole range accounted for: every source row is ignored (relay),
// counted (storable) or unstorable; plus the codes seen in counted rows.
const COVERAGE_SQL = `
SELECT count(*)::int AS rows,
       count(*) FILTER (WHERE coalesce(${RELAY}, false))::int AS relay,
       count(*) FILTER (WHERE NOT coalesce(${RELAY}, false) AND ${STORABLE})::int AS counted,
       count(*) FILTER (WHERE NOT coalesce(${RELAY}, false) AND NOT (${STORABLE}))::int AS unstorable,
       coalesce(array_agg(DISTINCT errorcode ORDER BY errorcode) FILTER (WHERE NOT coalesce(${RELAY}, false) AND ${STORABLE}), '{}') AS codes
FROM log.ge_cv_syserror
WHERE ${RANGE}`;

// Data quality (review CV1-SCHEMA P2): the device-side identity repeated in
// the source. Facts key on the source row, so a repeat is kept, not merged;
// it is reported, never an error. Expected: none.
const REPEATS_SQL = `
SELECT system_id, host_datetime, sequencenumber, errorcode, count(*)::int AS n, array_agg(id ORDER BY id) AS ids
FROM log.ge_cv_syserror
WHERE ${RANGE} AND NOT coalesce(${RELAY}, false)
GROUP BY 1, 2, 3, 4
HAVING count(*) > 1
ORDER BY 1, 2
LIMIT 50`;

module.exports = { RECONCILE_SQL, COVERAGE_SQL, REPEATS_SQL, COND, RELAY, STORABLE };
