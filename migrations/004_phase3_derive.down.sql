-- 004_phase3_derive.down.sql
-- Reverts 004: restores the 002 view definitions, drops system_clock and
-- the new columns, and restores the 3-column daily key. Only valid while
-- ge_ct_daily has no two rows that differ only in dim (the old key would
-- be violated) and while losing system_clock / tube_source data is
-- acceptable. No CASCADE.

-- Views first: they depend on the columns dropped below.
DROP VIEW api.ge_ct_system_summary_v;
CREATE VIEW api.ge_ct_system_summary_v AS
WITH sys AS (
  SELECT c.system_id FROM insight.system_capabilities c
  UNION
  SELECT t.system_id FROM insight.ge_ct_tube_segments t
  UNION
  SELECT f.system_id FROM insight.findings f WHERE f.source = 'ge_ct'
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
         LIMIT 1)                             AS open_findings_max_severity
FROM sys s
LEFT JOIN insight.ge_ct_tube_segments cur
       ON cur.system_id = s.system_id AND cur.segment_end IS NULL;
COMMENT ON VIEW api.ge_ct_system_summary_v IS
  'v0 placeholder. One row per GE CT system known to insight. Numeric columns here are what a future alert.models threshold would read (§5).';

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
       e.aborts_system
FROM insight.ge_ct_exams e;
COMMENT ON VIEW api.ge_ct_exams_v IS
  'v0 placeholder. exam_no is internal raw material; external renders scrub it.';

DROP VIEW api.ge_ct_tube_v;
CREATE VIEW api.ge_ct_tube_v AS
SELECT t.system_id,
       t.segment_start,
       t.segment_end,
       (t.segment_end IS NULL) AS is_current,
       t.install_date,
       t.install_confidence,
       t.start_mas,
       t.latest_mas,
       (t.latest_mas - t.start_mas) AS segment_mas,
       t.latest_at,
       t.mas_per_day,
       t.readings,
       t.ended_reason
FROM insight.ge_ct_tube_segments t;
COMMENT ON VIEW api.ge_ct_tube_v IS
  'v0 placeholder. Tube segments; values are mA·s (the legacy scan_seconds metadata is also mA·s).';

DROP VIEW api.ge_ct_daily_v;
CREATE VIEW api.ge_ct_daily_v AS
SELECT d.system_id,
       d.local_day,
       d.metric_key,
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
  'v0 placeholder. Per system, site-local day and metric, with catalog labels.';

REVOKE SELECT, INSERT, UPDATE, DELETE ON insight.system_clock FROM insight_writer;
DROP TABLE insight.system_clock;

ALTER TABLE insight.ge_ct_tube_segments DROP COLUMN tube_source;

ALTER TABLE insight.ge_ct_daily DROP CONSTRAINT ge_ct_daily_pkey;
ALTER TABLE insight.ge_ct_daily ADD CONSTRAINT ge_ct_daily_pkey PRIMARY KEY (system_id, local_day, metric_key);
COMMENT ON COLUMN insight.ge_ct_daily.local_day IS NULL;
ALTER TABLE insight.ge_ct_daily DROP COLUMN dim;
