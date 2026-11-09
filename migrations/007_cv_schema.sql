-- 007_cv_schema.sql
-- GE CV insights schema (PLAN-CV-INSIGHTS.md §2 item 2, §6, §7). New
-- objects only: no CT table, view, column or grant changes. CV shares
-- insight.metric_catalog (keys cv.*), insight.finding_catalog,
-- insight.findings (source = 'ge_cv') and insight.job_state (job names
-- ge_cv_*); this migration writes no rows to any of them.
--
-- Source: log.ge_cv_syserror (read by the pipeline, not referenced here: no
-- FK, no view on it). Volume is small (~96k source rows in 6 months, ~140k
-- facts with the proposed mapping), so the facts table is not partitioned.
--
-- Apply ONLY through migrations/run.js.

-- 1. Facts: one row per (sysError row x metric). Every counted source row
--    gives a cv.error fact (dim = error code) and at most one named-metric
--    fact. RTA relays of positioner errors (sourcefile XRImChainPos, debug
--    text "(null)") are skipped by the extract, not stored here (§6.2).
--    Natural key: (system_id, host_datetime, sequencenumber) is unique over
--    all 96,204 source rows (checked 2026-11-09); sequencenumber is a
--    within-file order only, never a count (§5.5 D2).
CREATE SEQUENCE insight.ge_cv_facts_id_seq AS bigint;

CREATE TABLE insight.ge_cv_facts (
  id                      bigint      NOT NULL DEFAULT nextval('insight.ge_cv_facts_id_seq') PRIMARY KEY,
  system_id               text        NOT NULL,
  host_datetime           timestamptz NOT NULL,     -- log.ge_cv_syserror.host_datetime
  sequencenumber          integer     NOT NULL,     -- within-file order only (§5.5 D2)
  metric_key              text        NOT NULL REFERENCES insight.metric_catalog (metric_key),
  host_local              timestamp   NOT NULL,     -- device wall clock: host_date + host_time
  errorcode               integer     NOT NULL,
  subsystem               text        NOT NULL,     -- trimmed ('DL ' in the source -> 'DL')
  exceptioncategory       text,
  dim                     text        NOT NULL DEFAULT '',
  value_num               double precision,
  value_text              text,
  attrs                   jsonb,                    -- repeatcount, sourcefile, sourceline, rule detail
  source_id               bigint      NOT NULL,     -- log.ge_cv_syserror.id (no FK: protected, partitioned)
  source_capture_datetime timestamptz NOT NULL,     -- with source_id = log.ge_cv_syserror primary key
  rule_version            integer     NOT NULL CHECK (rule_version > 0),
  extracted_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ge_cv_facts_natural_key UNIQUE (system_id, host_datetime, sequencenumber, metric_key),
  CONSTRAINT ge_cv_facts_cv_metric CHECK (metric_key LIKE 'cv.%'),
  CONSTRAINT ge_cv_facts_subsystem_trimmed CHECK (subsystem <> '' AND subsystem = btrim(subsystem))
);
ALTER SEQUENCE insight.ge_cv_facts_id_seq OWNED BY insight.ge_cv_facts.id;
CREATE INDEX ge_cv_facts_sys_metric_time_idx ON insight.ge_cv_facts (system_id, metric_key, host_datetime);
CREATE INDEX ge_cv_facts_sys_local_idx ON insight.ge_cv_facts (system_id, host_local);
CREATE INDEX ge_cv_facts_source_idx ON insight.ge_cv_facts (source_id);
COMMENT ON TABLE insight.ge_cv_facts IS
  'GE CV: one row per (log.ge_cv_syserror row x metric). cv.error for every counted row (dim = error code), plus at most one named metric. RTA relays of positioner errors are not stored. Upserted on the natural key; a fact is replaced only by a newer rule version.';
COMMENT ON COLUMN insight.ge_cv_facts.dim IS
  'Breakdown within a metric: error code (cv.error), axis or part (collision, anticollision, encoder), operation (detector com), sub-kind (PIB, worklist); '''' otherwise.';
COMMENT ON COLUMN insight.ge_cv_facts.sequencenumber IS
  'GE sysError sequence number: order within one file only (resets at each new file; known historic gaps, PLAN-CV-INSIGHTS.md §5.2). Never a count.';
COMMENT ON COLUMN insight.ge_cv_facts.host_local IS
  'Device wall-clock time of the source record (host_date + host_time). Local day comes from this, as for CT.';

-- 2. Daily rollup per system, device wall-clock day, metric and dim.
CREATE TABLE insight.ge_cv_daily (
  system_id   text        NOT NULL,
  local_day   date        NOT NULL,
  metric_key  text        NOT NULL REFERENCES insight.metric_catalog (metric_key),
  dim         text        NOT NULL DEFAULT '',
  n           bigint      NOT NULL CHECK (n > 0),
  value_sum   double precision,
  value_min   double precision,
  value_max   double precision,
  value_last  double precision,
  first_at    timestamptz NOT NULL,
  last_at     timestamptz NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (system_id, local_day, metric_key, dim),
  CONSTRAINT ge_cv_daily_cv_metric CHECK (metric_key LIKE 'cv.%'),
  CHECK (last_at >= first_at)
);
CREATE INDEX ge_cv_daily_metric_day_idx ON insight.ge_cv_daily (metric_key, local_day);
COMMENT ON TABLE insight.ge_cv_daily IS
  'GE CV: per system, device wall-clock day (date of ge_cv_facts.host_local), metric and dim. n = facts; a row exists only when n > 0. Recomputed for touched days only.';

-- 3. Error-code labels (§2 item 4): derived from the data, not a decoding
--    of GE's encoded fields. label = the code's most common readable
--    debug-text template (numbers and hex masked).
CREATE TABLE insight.ge_cv_codes (
  errorcode   integer     PRIMARY KEY,
  subsystem   text        NOT NULL CHECK (subsystem <> '' AND subsystem = btrim(subsystem)),
  label       text,
  label_share double precision CHECK (label_share > 0 AND label_share <= 1),
  sourcefile  text,
  n           bigint      NOT NULL CHECK (n > 0),
  systems     integer     NOT NULL CHECK (systems > 0),
  first_seen  timestamptz NOT NULL,
  last_seen   timestamptz NOT NULL,
  rule_version integer    NOT NULL CHECK (rule_version > 0),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (last_seen >= first_seen),
  CHECK ((label IS NULL) = (label_share IS NULL))
);
COMMENT ON TABLE insight.ge_cv_codes IS
  'GE CV error codes seen in counted rows: most common subsystem and source file, and a label = the most common readable debug-text template (label_share = its share of the code''s rows; NULL when no row is readable). Internal: debug text is GE service text, not customer wording.';

-- 4. insight_writer: same rights as on the CT pipeline tables (003, 004).
GRANT SELECT, INSERT, UPDATE, DELETE ON insight.ge_cv_facts, insight.ge_cv_daily, insight.ge_cv_codes TO insight_writer;
GRANT USAGE, SELECT ON SEQUENCE insight.ge_cv_facts_id_seq TO insight_writer;

-- 5. Consumer views (read only insight.*).
CREATE VIEW api.ge_cv_daily_v AS
SELECT d.system_id,
       d.local_day,
       d.metric_key,
       d.dim,
       c.label,
       c.unit,
       c.category,
       c.value_kind,
       c.customer_visible,
       k.label     AS code_label,
       k.subsystem AS code_subsystem,
       d.n,
       d.value_sum,
       d.value_min,
       d.value_max,
       d.value_last,
       d.first_at,
       d.last_at,
       d.updated_at
FROM insight.ge_cv_daily d
JOIN insight.metric_catalog c ON c.metric_key = d.metric_key
LEFT JOIN insight.ge_cv_codes k ON d.metric_key = 'cv.error' AND k.errorcode::text = d.dim;
COMMENT ON VIEW api.ge_cv_daily_v IS
  'GE CV per system, device wall-clock day, metric and dim, with catalog labels. For cv.error, dim is the error code and code_label / code_subsystem come from insight.ge_cv_codes (internal wording).';

-- Capabilities as a view over the facts (no table, nothing to derive or
-- verify): a metric absent here for a system means it never logged it.
CREATE VIEW api.ge_cv_capabilities_v AS
SELECT s.system_id,
       s.metric_key,
       c.label,
       c.unit,
       c.category,
       c.value_kind,
       c.model_specific,
       c.customer_visible,
       s.first_seen,
       s.last_seen,
       s.n
FROM (SELECT f.system_id,
             f.metric_key,
             min(f.host_datetime) AS first_seen,
             max(f.host_datetime) AS last_seen,
             count(*)             AS n
      FROM insight.ge_cv_facts f
      GROUP BY f.system_id, f.metric_key) s
JOIN insight.metric_catalog c ON c.metric_key = s.metric_key;
COMMENT ON VIEW api.ge_cv_capabilities_v IS
  'GE CV metrics each system has ever emitted (first/last seen, fact count), computed from insight.ge_cv_facts. Absent = the system does not log it; present with no daily rows in a period = zero events.';

CREATE VIEW api.ge_cv_codes_v AS
SELECT k.errorcode,
       k.subsystem,
       k.label,
       k.label_share,
       k.sourcefile,
       k.n,
       k.systems,
       k.first_seen,
       k.last_seen,
       k.updated_at
FROM insight.ge_cv_codes k;
COMMENT ON VIEW api.ge_cv_codes_v IS
  'GE CV error codes with derived labels (most common readable debug-text template). Internal wording; not a decoding of GE''s encoded fields.';

CREATE VIEW api.ge_cv_findings_v AS
SELECT f.system_id,
       f.finding_key,
       c.label,
       c.category,
       c.description,
       c.customer_visible,
       f.source,
       f.status,
       f.severity,
       f.opened_at,
       f.resolved_at,
       f.data_through,
       f.window_start,
       f.window_end,
       f.observed,
       f.baseline,
       f.evidence,
       f.rule_version,
       f.last_evaluated
FROM insight.findings f
JOIN insight.finding_catalog c ON c.finding_key = f.finding_key
WHERE f.source = 'ge_cv';
COMMENT ON VIEW api.ge_cv_findings_v IS
  'GE CV open and resolved findings (source ge_cv) with catalog labels. data_through = the device day the evaluation''s data ran through. evidence may hold internal ids.';

CREATE VIEW api.ge_cv_system_summary_v AS
WITH sys AS (
  SELECT f.system_id FROM insight.ge_cv_facts f
  UNION
  SELECT f.system_id FROM insight.findings f WHERE f.source = 'ge_cv'
)
SELECT s.system_id,
       (SELECT max(f.host_datetime) FROM insight.ge_cv_facts f WHERE f.system_id = s.system_id) AS last_seen,
       (SELECT max(d.local_day) FROM insight.ge_cv_daily d WHERE d.system_id = s.system_id)     AS last_local_day,
       (SELECT count(*) FROM insight.findings f
         WHERE f.system_id = s.system_id AND f.source = 'ge_cv' AND f.status = 'open') AS open_findings,
       (SELECT f.severity FROM insight.findings f
         WHERE f.system_id = s.system_id AND f.source = 'ge_cv' AND f.status = 'open'
         ORDER BY array_position(ARRAY['info','low','medium','high']::text[], f.severity) DESC
         LIMIT 1)                                                                     AS open_findings_max_severity
FROM sys s;
COMMENT ON VIEW api.ge_cv_system_summary_v IS
  'One row per GE CV system known to insight: newest fact, newest device day, open ge_cv findings and their highest severity.';
