-- 004_phase3_derive.sql
-- Phase 3 schema (PLAN-CT-INSIGHTS.md §13.2, §13.4). Insight-only. The
-- derived tables (ge_ct_daily, ge_ct_exams, ge_ct_tube_segments) are still
-- empty, so the key change and new columns are cheap.
--
-- Apply ONLY through migrations/run.js.

-- 1. Daily breakdown column (§13.2 item 3). dim = ermes code for
--    error.ermes, step for prep.tube_temp / service.calibration, process for
--    process.restart, destination for xfer.*, status for ipc.*, '' otherwise.
--    It joins the primary key, so one metric can have several rows per day.
ALTER TABLE insight.ge_ct_daily ADD COLUMN dim text NOT NULL DEFAULT '';
ALTER TABLE insight.ge_ct_daily DROP CONSTRAINT ge_ct_daily_pkey;
ALTER TABLE insight.ge_ct_daily ADD CONSTRAINT ge_ct_daily_pkey PRIMARY KEY (system_id, local_day, metric_key, dim);
COMMENT ON COLUMN insight.ge_ct_daily.dim IS
  'Breakdown within a metric: ermes code (error.ermes), step (prep.tube_temp, service.calibration), process (process.restart), destination (xfer.*), status (ipc.*); '''' otherwise.';
COMMENT ON COLUMN insight.ge_ct_daily.local_day IS
  'Device wall-clock day (date of ge_ct_facts.host_local), not sites.time_zone_id (§12 item 2).';

-- 2. Tube source per segment (§13.2 item 1): the identity verdict logged in
--    the segment's first 30 days. NULL when the system logs no identity.
ALTER TABLE insight.ge_ct_tube_segments ADD COLUMN tube_source text
  CONSTRAINT ge_ct_tube_segments_tube_source_check CHECK (tube_source IN ('verified','unrecognized','no_smart_id'));
COMMENT ON COLUMN insight.ge_ct_tube_segments.tube_source IS
  'tube.identity verdict in the segment''s first 30 days: verified (GE tube), unrecognized (third-party / refurbished), no_smart_id. NULL if none logged.';

-- 3. Per-system clock estimate (§13.2 item 2): estimate and flag, never
--    used to correct timestamps in v1. lag = capture_datetime minus the
--    newest host_datetime in that capture, over a trailing window.
CREATE TABLE insight.system_clock (
  system_id      text        PRIMARY KEY,
  est_offset_min double precision,          -- minutes the device clock runs ahead (lower bound); 0 when not flagged ahead
  p10_lag_min    double precision NOT NULL,
  min_lag_min    double precision NOT NULL,
  median_lag_min double precision NOT NULL,
  captures       integer     NOT NULL CHECK (captures > 0),
  flag           text        NOT NULL CHECK (flag IN ('ok','ahead','lagging','jumps')),
  window_start   timestamptz NOT NULL,
  window_end     timestamptz NOT NULL,
  computed_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (window_end > window_start)
);
COMMENT ON TABLE insight.system_clock IS
  'Per-system device clock estimate from capture lag (capture_datetime - newest host_datetime per capture). flag: ahead (p10 lag < 0), lagging (p10 lag > 45 min), jumps (one-off negative lags), ok. Informational: rollups keep the device wall clock.';

-- 4. insight_writer: same rights as on the other pipeline tables.
GRANT SELECT, INSERT, UPDATE, DELETE ON insight.system_clock TO insight_writer;

-- 5. Consumer views. Column lists change, which CREATE OR REPLACE can't do
--    in the middle of a view, so drop and re-create (no grants or
--    dependants on these views; checked 2026-11-04).
DROP VIEW api.ge_ct_daily_v;
CREATE VIEW api.ge_ct_daily_v AS
SELECT d.system_id,
       d.local_day,
       d.metric_key,
       d.dim,
       c.label,
       c.unit,
       c.category,
       c.value_kind,
       c.customer_visible,
       d.n,
       d.value_sum,
       d.value_min,
       d.value_max,
       d.value_last,
       d.last_at,
       d.updated_at
FROM insight.ge_ct_daily d
JOIN insight.metric_catalog c ON c.metric_key = d.metric_key;
COMMENT ON VIEW api.ge_ct_daily_v IS
  'Per system, device wall-clock day, metric and dim (breakdown: ermes code, step, process, destination, status, or ''''), with catalog labels.';

DROP VIEW api.ge_ct_tube_v;
CREATE VIEW api.ge_ct_tube_v AS
SELECT t.system_id,
       t.segment_start,
       t.segment_end,
       (t.segment_end IS NULL) AS is_current,
       t.install_date,
       t.install_confidence,
       t.tube_source,
       t.start_mas,
       t.latest_mas,
       (t.latest_mas - t.start_mas) AS segment_mas,
       t.latest_at,
       t.mas_per_day,
       t.readings,
       t.ended_reason
FROM insight.ge_ct_tube_segments t;
COMMENT ON VIEW api.ge_ct_tube_v IS
  'Tube segments; values are mA·s (the legacy scan_seconds metadata is also mA·s). install_confidence: initial | confirmed | counter_only (needs field-service review). tube_source: verified | unrecognized | no_smart_id.';

DROP VIEW api.ge_ct_exams_v;
CREATE VIEW api.ge_ct_exams_v AS
SELECT e.system_id,
       e.exam_no,
       e.started_at,
       e.last_activity_at,
       e.local_day,
       e.protocol,
       e.series,
       e.scans,
       e.images,
       e.aborts_operator,
       e.aborts_system,
       coalesce((e.attrs ->> 'reopened')::boolean, false) AS reopened
FROM insight.ge_ct_exams e;
COMMENT ON VIEW api.ge_ct_exams_v IS
  'One row per exam start. reopened = the same exam_no was started again. exam_no is internal raw material; external renders scrub it.';

DROP VIEW api.ge_ct_system_summary_v;
CREATE VIEW api.ge_ct_system_summary_v AS
WITH sys AS (
  SELECT c.system_id FROM insight.system_capabilities c
  UNION
  SELECT t.system_id FROM insight.ge_ct_tube_segments t
  UNION
  SELECT f.system_id FROM insight.findings f WHERE f.source = 'ge_ct'
  UNION
  SELECT k.system_id FROM insight.system_clock k
)
SELECT s.system_id,
       (SELECT max(c.last_seen) FROM insight.system_capabilities c WHERE c.system_id = s.system_id) AS last_seen,
       cur.install_date                       AS current_tube_install_date,
       cur.install_confidence                 AS current_tube_install_confidence,
       (cur.latest_mas - cur.start_mas)       AS current_tube_mas,
       cur.mas_per_day                        AS current_tube_mas_per_day,
       (SELECT count(*) FROM insight.findings f
         WHERE f.system_id = s.system_id AND f.source = 'ge_ct' AND f.status = 'open') AS open_findings,
       (SELECT f.severity FROM insight.findings f
         WHERE f.system_id = s.system_id AND f.source = 'ge_ct' AND f.status = 'open'
         ORDER BY array_position(ARRAY['info','low','medium','high']::text[], f.severity) DESC
         LIMIT 1)                             AS open_findings_max_severity,
       cur.tube_source                        AS current_tube_source,
       clk.flag                               AS clock_flag,
       clk.est_offset_min                     AS clock_est_offset_min
FROM sys s
LEFT JOIN insight.ge_ct_tube_segments cur
       ON cur.system_id = s.system_id AND cur.segment_end IS NULL
LEFT JOIN insight.system_clock clk
       ON clk.system_id = s.system_id;
COMMENT ON VIEW api.ge_ct_system_summary_v IS
  'One row per GE CT system known to insight. Numeric columns here are what a future alert.models threshold would read (§5). clock_flag / clock_est_offset_min are informational (§13.2 item 2).';
