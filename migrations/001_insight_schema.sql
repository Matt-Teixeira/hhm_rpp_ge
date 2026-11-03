-- 001_insight_schema.sql
-- GE CT insights schema (PLAN-CT-INSIGHTS.md §3).
--
-- Apply ONLY through migrations/run.js (dry run by default, --apply to
-- commit). No BEGIN/COMMIT here: the runner owns the transaction and runs
-- with search_path = pg_catalog, so every name is schema-qualified.
--
-- Scope: creates schema `insight` and objects inside it. Touches nothing
-- outside `insight`: no foreign keys to log.*/public.* (they would lock
-- protected tables), no grants on other schemas.

CREATE SCHEMA insight;
COMMENT ON SCHEMA insight IS
  'Derived metrics/findings from raw device logs (GE CT first). Written only by the insight pipeline in hhm_rpp_ge; consumers read the api.ge_ct_* views. See PLAN-CT-INSIGHTS.md.';

-- ------------------------------------------------------------------ runner
CREATE TABLE insight.schema_migrations (
  version       integer     PRIMARY KEY CHECK (version > 0),
  name          text        NOT NULL,
  checksum      text        NOT NULL,           -- sha256 of the up file as applied
  down_checksum text        NOT NULL,           -- sha256 of the matching down file
  applied_at    timestamptz NOT NULL DEFAULT now(),
  applied_by    text        NOT NULL DEFAULT current_user,
  git_commit    text,
  runner_host   text
);
COMMENT ON TABLE insight.schema_migrations IS
  'Applied migrations (migrations/run.js). The runner refuses to proceed if a file''s checksum no longer matches its row.';

-- ---------------------------------------------------------- metric catalog
CREATE TABLE insight.metric_catalog (
  metric_key       text        PRIMARY KEY CHECK (metric_key ~ '^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$'),
  label            text        NOT NULL,
  unit             text,
  category         text        NOT NULL CHECK (category IN ('utilization','tube','reliability','compliance','environment','inventory')),
  value_kind       text        NOT NULL CHECK (value_kind IN ('event','gauge','counter','text')),
  description      text,
  customer_visible boolean     NOT NULL DEFAULT true,
  model_specific   boolean     NOT NULL DEFAULT false,  -- gate on insight.system_capabilities
  rule_version     integer     NOT NULL DEFAULT 1 CHECK (rule_version > 0),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE insight.metric_catalog IS
  'One row per metric_key. Drives labels/units in every consumer. value_kind tells consumers which daily aggregates are meaningful (sum for events, last for counters/gauges).';

-- ------------------------------------------------------------------- facts
CREATE SEQUENCE insight.ge_ct_facts_id_seq AS bigint;

CREATE TABLE insight.ge_ct_facts (
  id                       bigint      NOT NULL DEFAULT nextval('insight.ge_ct_facts_id_seq'),
  system_id                text        NOT NULL,
  epoch                    integer     NOT NULL,     -- GE epoch (local wall-clock seconds, see plan §1b)
  record_number_concurrent integer     NOT NULL,
  metric_key               text        NOT NULL REFERENCES insight.metric_catalog (metric_key),
  host_datetime            timestamptz NOT NULL,
  value_num                double precision,
  value_text               text,
  exam_no                  text,
  attrs                    jsonb,
  source_id                bigint      NOT NULL,     -- log.ge_ct_gesys.id (no FK: protected, partitioned)
  source_capture_datetime  timestamptz NOT NULL,     -- with source_id = log.ge_ct_gesys primary key
  rule_version             integer     NOT NULL,
  extracted_at             timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, host_datetime),
  CONSTRAINT ge_ct_facts_natural_key UNIQUE (system_id, epoch, record_number_concurrent, metric_key, host_datetime)
) PARTITION BY RANGE (host_datetime);
ALTER SEQUENCE insight.ge_ct_facts_id_seq OWNED BY insight.ge_ct_facts.id;
COMMENT ON TABLE insight.ge_ct_facts IS
  'One row per (gesys record x metric). Upserted ON CONFLICT DO NOTHING on the natural key, which dedupes re-ingested gesys rows. Monthly partitions on host_datetime (UTC bounds, alert.detections naming); create future months with insight.ensure_ge_ct_facts_partitions().';

CREATE INDEX ge_ct_facts_sys_metric_time_idx ON insight.ge_ct_facts (system_id, metric_key, host_datetime);
CREATE INDEX ge_ct_facts_source_idx ON insight.ge_ct_facts (source_id);

CREATE TABLE insight.ge_ct_facts_2025_05 PARTITION OF insight.ge_ct_facts
  FOR VALUES FROM ('2025-05-01 00:00:00+00') TO ('2025-06-01 00:00:00+00');
CREATE TABLE insight.ge_ct_facts_2025_06 PARTITION OF insight.ge_ct_facts
  FOR VALUES FROM ('2025-06-01 00:00:00+00') TO ('2025-07-01 00:00:00+00');
CREATE TABLE insight.ge_ct_facts_2025_07 PARTITION OF insight.ge_ct_facts
  FOR VALUES FROM ('2025-07-01 00:00:00+00') TO ('2025-08-01 00:00:00+00');
CREATE TABLE insight.ge_ct_facts_2025_08 PARTITION OF insight.ge_ct_facts
  FOR VALUES FROM ('2025-08-01 00:00:00+00') TO ('2025-09-01 00:00:00+00');
CREATE TABLE insight.ge_ct_facts_2025_09 PARTITION OF insight.ge_ct_facts
  FOR VALUES FROM ('2025-09-01 00:00:00+00') TO ('2025-10-01 00:00:00+00');
CREATE TABLE insight.ge_ct_facts_2025_10 PARTITION OF insight.ge_ct_facts
  FOR VALUES FROM ('2025-10-01 00:00:00+00') TO ('2025-11-01 00:00:00+00');
CREATE TABLE insight.ge_ct_facts_2025_11 PARTITION OF insight.ge_ct_facts
  FOR VALUES FROM ('2025-11-01 00:00:00+00') TO ('2025-12-01 00:00:00+00');
CREATE TABLE insight.ge_ct_facts_2025_12 PARTITION OF insight.ge_ct_facts
  FOR VALUES FROM ('2025-12-01 00:00:00+00') TO ('2026-01-01 00:00:00+00');
CREATE TABLE insight.ge_ct_facts_2026_01 PARTITION OF insight.ge_ct_facts
  FOR VALUES FROM ('2026-01-01 00:00:00+00') TO ('2026-02-01 00:00:00+00');
CREATE TABLE insight.ge_ct_facts_2026_02 PARTITION OF insight.ge_ct_facts
  FOR VALUES FROM ('2026-02-01 00:00:00+00') TO ('2026-03-01 00:00:00+00');
CREATE TABLE insight.ge_ct_facts_2026_03 PARTITION OF insight.ge_ct_facts
  FOR VALUES FROM ('2026-03-01 00:00:00+00') TO ('2026-04-01 00:00:00+00');
CREATE TABLE insight.ge_ct_facts_2026_04 PARTITION OF insight.ge_ct_facts
  FOR VALUES FROM ('2026-04-01 00:00:00+00') TO ('2026-05-01 00:00:00+00');
CREATE TABLE insight.ge_ct_facts_2026_05 PARTITION OF insight.ge_ct_facts
  FOR VALUES FROM ('2026-05-01 00:00:00+00') TO ('2026-06-01 00:00:00+00');
CREATE TABLE insight.ge_ct_facts_2026_06 PARTITION OF insight.ge_ct_facts
  FOR VALUES FROM ('2026-06-01 00:00:00+00') TO ('2026-07-01 00:00:00+00');
CREATE TABLE insight.ge_ct_facts_2026_07 PARTITION OF insight.ge_ct_facts
  FOR VALUES FROM ('2026-07-01 00:00:00+00') TO ('2026-08-01 00:00:00+00');
CREATE TABLE insight.ge_ct_facts_2026_08 PARTITION OF insight.ge_ct_facts
  FOR VALUES FROM ('2026-08-01 00:00:00+00') TO ('2026-09-01 00:00:00+00');
CREATE TABLE insight.ge_ct_facts_2026_09 PARTITION OF insight.ge_ct_facts
  FOR VALUES FROM ('2026-09-01 00:00:00+00') TO ('2026-10-01 00:00:00+00');
CREATE TABLE insight.ge_ct_facts_2026_10 PARTITION OF insight.ge_ct_facts
  FOR VALUES FROM ('2026-10-01 00:00:00+00') TO ('2026-11-01 00:00:00+00');
CREATE TABLE insight.ge_ct_facts_2026_11 PARTITION OF insight.ge_ct_facts
  FOR VALUES FROM ('2026-11-01 00:00:00+00') TO ('2026-12-01 00:00:00+00');
CREATE TABLE insight.ge_ct_facts_2026_12 PARTITION OF insight.ge_ct_facts
  FOR VALUES FROM ('2026-12-01 00:00:00+00') TO ('2027-01-01 00:00:00+00');
CREATE TABLE insight.ge_ct_facts_2027_01 PARTITION OF insight.ge_ct_facts
  FOR VALUES FROM ('2027-01-01 00:00:00+00') TO ('2027-02-01 00:00:00+00');
CREATE TABLE insight.ge_ct_facts_2027_02 PARTITION OF insight.ge_ct_facts
  FOR VALUES FROM ('2027-02-01 00:00:00+00') TO ('2027-03-01 00:00:00+00');
CREATE TABLE insight.ge_ct_facts_2027_03 PARTITION OF insight.ge_ct_facts
  FOR VALUES FROM ('2027-03-01 00:00:00+00') TO ('2027-04-01 00:00:00+00');
CREATE TABLE insight.ge_ct_facts_2027_04 PARTITION OF insight.ge_ct_facts
  FOR VALUES FROM ('2027-04-01 00:00:00+00') TO ('2027-05-01 00:00:00+00');
CREATE TABLE insight.ge_ct_facts_2027_05 PARTITION OF insight.ge_ct_facts
  FOR VALUES FROM ('2027-05-01 00:00:00+00') TO ('2027-06-01 00:00:00+00');
CREATE TABLE insight.ge_ct_facts_2027_06 PARTITION OF insight.ge_ct_facts
  FOR VALUES FROM ('2027-06-01 00:00:00+00') TO ('2027-07-01 00:00:00+00');

-- Creates any missing monthly partitions covering [p_from, p_to]. Called by
-- the pipeline before upserting a batch. Insight-only; no default partition
-- by design (out-of-range host dates are skipped and counted by extract).
CREATE FUNCTION insight.ensure_ge_ct_facts_partitions(p_from timestamptz, p_to timestamptz)
RETURNS integer
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  m       date := date_trunc('month', p_from AT TIME ZONE 'UTC')::date;
  last_m  date := date_trunc('month', p_to AT TIME ZONE 'UTC')::date;
  part    text;
  created integer := 0;
BEGIN
  IF p_from IS NULL OR p_to IS NULL OR p_to < p_from THEN
    RAISE EXCEPTION 'ensure_ge_ct_facts_partitions: bad range % .. %', p_from, p_to;
  END IF;
  IF last_m > m + interval '36 months' THEN
    RAISE EXCEPTION 'ensure_ge_ct_facts_partitions: range % .. % exceeds 36 months', p_from, p_to;
  END IF;
  WHILE m <= last_m LOOP
    part := 'ge_ct_facts_' || to_char(m, 'YYYY_MM');
    IF to_regclass('insight.' || part) IS NULL THEN
      EXECUTE format('CREATE TABLE insight.%I PARTITION OF insight.ge_ct_facts FOR VALUES FROM (%L) TO (%L)',
                     part, (m::timestamp AT TIME ZONE 'UTC'), ((m + interval '1 month')::timestamp AT TIME ZONE 'UTC'));
      created := created + 1;
    END IF;
    m := (m + interval '1 month')::date;
  END LOOP;
  RETURN created;
END
$fn$;
COMMENT ON FUNCTION insight.ensure_ge_ct_facts_partitions(timestamptz, timestamptz) IS
  'Create missing monthly insight.ge_ct_facts partitions for [p_from, p_to] (max 36 months). Returns the number created.';

-- ------------------------------------------------------------ daily rollup
CREATE TABLE insight.ge_ct_daily (
  system_id   text        NOT NULL,
  local_day   date        NOT NULL,          -- site-local day (sites.time_zone_id)
  metric_key  text        NOT NULL REFERENCES insight.metric_catalog (metric_key),
  time_zone   text        NOT NULL,          -- zone used to compute local_day
  n           bigint      NOT NULL CHECK (n >= 0),
  value_sum   double precision,
  value_min   double precision,
  value_max   double precision,
  value_last  double precision,
  last_at     timestamptz,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (system_id, local_day, metric_key)
);
CREATE INDEX ge_ct_daily_metric_day_idx ON insight.ge_ct_daily (metric_key, local_day);
COMMENT ON TABLE insight.ge_ct_daily IS
  'Per (system, site-local day, metric) aggregates over deduped facts. Recomputed for touched days only.';

-- ------------------------------------------------------------------- exams
CREATE TABLE insight.ge_ct_exams (
  system_id        text        NOT NULL,
  exam_no          text        NOT NULL,
  started_at       timestamptz NOT NULL,
  last_activity_at timestamptz NOT NULL,
  local_day        date        NOT NULL,
  protocol         text,
  series           integer     NOT NULL DEFAULT 0 CHECK (series >= 0),
  scans            integer     NOT NULL DEFAULT 0 CHECK (scans >= 0),
  images           integer     NOT NULL DEFAULT 0 CHECK (images >= 0),
  aborts_operator  integer     NOT NULL DEFAULT 0 CHECK (aborts_operator >= 0),
  aborts_system    integer     NOT NULL DEFAULT 0 CHECK (aborts_system >= 0),
  attrs            jsonb,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (system_id, exam_no, started_at),
  CHECK (last_activity_at >= started_at)
);
CREATE INDEX ge_ct_exams_sys_day_idx ON insight.ge_ct_exams (system_id, local_day);
COMMENT ON TABLE insight.ge_ct_exams IS
  'One row per exam: first/last activity, series/scans/images, aborts during the exam. Basis for per-exam rates.';

-- ----------------------------------------------------------- tube segments
CREATE TABLE insight.ge_ct_tube_segments (
  system_id          text        NOT NULL,
  segment_start      timestamptz NOT NULL,     -- first counter reading of this tube
  segment_end        timestamptz,              -- last reading before replacement; NULL = current tube
  install_date       date,                     -- corroborated swap date, else counter-reset date (§4)
  install_confidence text        CHECK (install_confidence IN ('confirmed','counter_only','initial')),
  start_mas          double precision NOT NULL,
  latest_mas         double precision NOT NULL,
  latest_at          timestamptz NOT NULL,
  mas_per_day        double precision,
  readings           integer     NOT NULL CHECK (readings > 0),
  ended_reason       text        CHECK (ended_reason IN ('replacement')),
  evidence           jsonb,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (system_id, segment_start),
  CHECK ((segment_end IS NULL) = (ended_reason IS NULL))
);
CREATE UNIQUE INDEX ge_ct_tube_segments_one_current_idx ON insight.ge_ct_tube_segments (system_id) WHERE segment_end IS NULL;
COMMENT ON TABLE insight.ge_ct_tube_segments IS
  'Tube lifetimes from the cumulative mA·s counter. install_confidence: confirmed (reset + corroborating service events), counter_only, or initial (segment already running when data starts).';

-- ------------------------------------------------------------ capabilities
CREATE TABLE insight.system_capabilities (
  system_id  text        NOT NULL,
  metric_key text        NOT NULL REFERENCES insight.metric_catalog (metric_key),
  first_seen timestamptz NOT NULL,
  last_seen  timestamptz NOT NULL,
  n          bigint      NOT NULL CHECK (n > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (system_id, metric_key),
  CHECK (last_seen >= first_seen)
);
COMMENT ON TABLE insight.system_capabilities IS
  'Which metrics a system has ever emitted. Separates "this model does not log it" from "zero events".';

-- ---------------------------------------------------------------- findings
CREATE TABLE insight.findings (
  system_id      text        NOT NULL,
  finding_key    text        NOT NULL,
  opened_at      timestamptz NOT NULL,
  source         text        NOT NULL DEFAULT 'ge_ct',   -- rule registry (MRI/CV later)
  status         text        NOT NULL CHECK (status IN ('open','resolved')),
  severity       text        NOT NULL CHECK (severity IN ('info','low','medium','high')),
  window_start   timestamptz,
  window_end     timestamptz,
  observed       double precision,
  baseline       double precision,
  evidence       jsonb       NOT NULL DEFAULT '{}'::jsonb,
  rule_version   integer     NOT NULL,
  last_evaluated timestamptz NOT NULL,
  resolved_at    timestamptz,
  PRIMARY KEY (system_id, finding_key, opened_at),
  CHECK ((status = 'resolved') = (resolved_at IS NOT NULL))
);
CREATE UNIQUE INDEX findings_one_open_idx ON insight.findings (system_id, finding_key) WHERE status = 'open';
CREATE INDEX findings_status_severity_idx ON insight.findings (status, severity);
COMMENT ON TABLE insight.findings IS
  'Open/resolved findings per system with the evidence used. At most one open finding per (system_id, finding_key).';

-- --------------------------------------------------------------- job state
CREATE TABLE insight.job_state (
  job_name                   text        PRIMARY KEY,
  watermark_id               bigint      NOT NULL DEFAULT 0 CHECK (watermark_id >= 0),  -- last processed log.ge_ct_gesys.id
  watermark_capture_datetime timestamptz,                                             -- partition-pruning floor
  last_run_id                uuid,
  last_run_started_at        timestamptz,
  last_run_finished_at       timestamptz,
  last_run_status            text        CHECK (last_run_status IN ('ok','skipped','error')),
  last_run_stats             jsonb,
  updated_at                 timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE insight.job_state IS
  'Pipeline watermark and last-run stats. Advanced in the same transaction as the fact upserts.';

-- ----------------------------------------------------- unmatched templates
CREATE TABLE insight.unmatched_templates (
  process        text        NOT NULL,
  template_hash  text        NOT NULL,
  template       text        NOT NULL,
  sample_message text,                         -- raw log text: internal only, not exposed in api views
  n              bigint      NOT NULL CHECK (n > 0),
  system_count   integer     NOT NULL CHECK (system_count > 0),
  first_seen     timestamptz NOT NULL,
  last_seen      timestamptz NOT NULL,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (process, template_hash)
);
COMMENT ON TABLE insight.unmatched_templates IS
  'High-volume message templates no rule matches (weekly digest), so new firmware wording gets noticed.';
