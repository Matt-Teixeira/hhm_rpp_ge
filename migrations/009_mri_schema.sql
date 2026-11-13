-- 009_mri_schema.sql
-- GE MRI insights schema (PLAN-MRI-INSIGHTS.md §2, §5, §6). New objects
-- only: no CT or CV table, view, column or grant changes. MRI shares
-- insight.metric_catalog (keys mri.*), insight.finding_catalog,
-- insight.findings (source = 'ge_mri') and insight.job_state (job names
-- ge_mri_*); this migration writes no rows to any of them: the mri.*
-- catalog rows come from the MRI rule registry, upserted by the extract
-- (as CV; §5.3 Q-M9).
--
-- No api views yet: the runner's scope is insight.* / api.ge_ct_* /
-- api.ge_cv_*, and the api.ge_mri_* views come with the viewer (MRI-6).
--
-- Source: log.ge_mri_gesys (read by the pipeline, not referenced here: no
-- FK, no view on it). About 440k facts for the 329k deduped source rows
-- since 2025-05 (§5.2), growing with each system that starts sending, so
-- the facts table is partitioned by month like insight.ge_ct_facts.
--
-- Apply ONLY through migrations/run.js.

-- 1. Facts: one row per (gesys record x metric). Every record gives an
--    mri.error fact (dim = message code) plus the named metrics its code
--    lists (at most two: the exam summary gives mri.scans_ok and
--    mri.scans_failed).
--    Key: the record's natural key (system_id, epoch, record_number_concurrent)
--    + metric, as CT. host_local is in the key only because a unique key on
--    a partitioned table must contain the partition column; it is fixed by
--    epoch (CHECK below), so the key is the 4-column natural key + metric.
--    The upsert on it dedupes the old duplicate source rows (§3 Q6).
--    epoch is the device wall clock, so the key is not unique by
--    construction (a DST fall-back hour can repeat it); it held for all
--    329,480 records on 2026-11-13, and the extract's verify reports any key
--    that would hold two different records (§5.3 Q-M9).
CREATE SEQUENCE insight.ge_mri_facts_id_seq AS bigint;

CREATE TABLE insight.ge_mri_facts (
  id                       bigint      NOT NULL DEFAULT nextval('insight.ge_mri_facts_id_seq'),
  system_id                text        NOT NULL,
  epoch                    integer     NOT NULL,     -- GE epoch: device wall-clock seconds, not UTC
  record_number_concurrent integer     NOT NULL,
  metric_key               text        NOT NULL REFERENCES insight.metric_catalog (metric_key),
  host_local               timestamp   NOT NULL,     -- device wall clock = 1970-01-01 + epoch seconds
  host_datetime            timestamptz NOT NULL,     -- log.ge_mri_gesys.host_datetime (parser's zone guess)
  message_number           integer     NOT NULL,     -- GE message code
  dim                      text        NOT NULL DEFAULT '',
  value_num                double precision,
  value_text               text,
  attrs                    jsonb,                    -- proc, coil, psd; rule detail. Never message text.
  source_id                bigint      NOT NULL,     -- log.ge_mri_gesys.id (no FK: protected, partitioned)
  source_capture_datetime  timestamptz NOT NULL,     -- with source_id = log.ge_mri_gesys primary key
  rule_version             integer     NOT NULL CHECK (rule_version > 0),
  extracted_at             timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, host_local),
  CONSTRAINT ge_mri_facts_natural_key UNIQUE (system_id, epoch, record_number_concurrent, metric_key, host_local),
  CONSTRAINT ge_mri_facts_mri_metric CHECK (metric_key LIKE 'mri.%'),
  CONSTRAINT ge_mri_facts_host_local_epoch CHECK (host_local = timestamp '1970-01-01 00:00:00' + epoch * interval '1 second')
) PARTITION BY RANGE (host_local);
ALTER SEQUENCE insight.ge_mri_facts_id_seq OWNED BY insight.ge_mri_facts.id;
CREATE INDEX ge_mri_facts_sys_metric_local_idx ON insight.ge_mri_facts (system_id, metric_key, host_local);
CREATE INDEX ge_mri_facts_source_idx ON insight.ge_mri_facts (source_id);
COMMENT ON TABLE insight.ge_mri_facts IS
  'GE MRI: one row per (log.ge_mri_gesys record x metric). mri.error for every record (dim = message code), plus the named metrics of its code. Upserted on ge_mri_facts_natural_key (natural key + metric), which dedupes re-ingested source rows; a fact is replaced only by a newer rule version. Monthly partitions on host_local (device wall clock) through 2028-12; insight_writer cannot create partitions, so later months come by migration.';
COMMENT ON COLUMN insight.ge_mri_facts.host_local IS
  'Device wall-clock time of the record: 1970-01-01 + epoch seconds (= host_date + host_time). Device days come from this, as for CT and CV; independent of sites.time_zone_id.';
COMMENT ON COLUMN insight.ge_mri_facts.dim IS
  'Breakdown within a metric: message code (mri.error), process (process deaths), reason (prescan, invalid coil), kind (coil, cooling, RF, gradient, receiver, table faults), on/off (service mode), software version (system up); '''' otherwise.';
COMMENT ON COLUMN insight.ge_mri_facts.attrs IS
  'proc (the gesys process), coil and psd when the source row has them, and rule detail (e.g. prescan mode, System Up fields). Never message text: messages carry host names, AE titles and operator free text.';

-- Partitions 2025-05 (first device day in the data: 2025-05-02) to 2028-12.
-- Bounds are device wall-clock times. No default partition (as CT): a record
-- outside the range is skipped and counted by the extract.
CREATE TABLE insight.ge_mri_facts_2025_05 PARTITION OF insight.ge_mri_facts
  FOR VALUES FROM ('2025-05-01 00:00:00') TO ('2025-06-01 00:00:00');
CREATE TABLE insight.ge_mri_facts_2025_06 PARTITION OF insight.ge_mri_facts
  FOR VALUES FROM ('2025-06-01 00:00:00') TO ('2025-07-01 00:00:00');
CREATE TABLE insight.ge_mri_facts_2025_07 PARTITION OF insight.ge_mri_facts
  FOR VALUES FROM ('2025-07-01 00:00:00') TO ('2025-08-01 00:00:00');
CREATE TABLE insight.ge_mri_facts_2025_08 PARTITION OF insight.ge_mri_facts
  FOR VALUES FROM ('2025-08-01 00:00:00') TO ('2025-09-01 00:00:00');
CREATE TABLE insight.ge_mri_facts_2025_09 PARTITION OF insight.ge_mri_facts
  FOR VALUES FROM ('2025-09-01 00:00:00') TO ('2025-10-01 00:00:00');
CREATE TABLE insight.ge_mri_facts_2025_10 PARTITION OF insight.ge_mri_facts
  FOR VALUES FROM ('2025-10-01 00:00:00') TO ('2025-11-01 00:00:00');
CREATE TABLE insight.ge_mri_facts_2025_11 PARTITION OF insight.ge_mri_facts
  FOR VALUES FROM ('2025-11-01 00:00:00') TO ('2025-12-01 00:00:00');
CREATE TABLE insight.ge_mri_facts_2025_12 PARTITION OF insight.ge_mri_facts
  FOR VALUES FROM ('2025-12-01 00:00:00') TO ('2026-01-01 00:00:00');
CREATE TABLE insight.ge_mri_facts_2026_01 PARTITION OF insight.ge_mri_facts
  FOR VALUES FROM ('2026-01-01 00:00:00') TO ('2026-02-01 00:00:00');
CREATE TABLE insight.ge_mri_facts_2026_02 PARTITION OF insight.ge_mri_facts
  FOR VALUES FROM ('2026-02-01 00:00:00') TO ('2026-03-01 00:00:00');
CREATE TABLE insight.ge_mri_facts_2026_03 PARTITION OF insight.ge_mri_facts
  FOR VALUES FROM ('2026-03-01 00:00:00') TO ('2026-04-01 00:00:00');
CREATE TABLE insight.ge_mri_facts_2026_04 PARTITION OF insight.ge_mri_facts
  FOR VALUES FROM ('2026-04-01 00:00:00') TO ('2026-05-01 00:00:00');
CREATE TABLE insight.ge_mri_facts_2026_05 PARTITION OF insight.ge_mri_facts
  FOR VALUES FROM ('2026-05-01 00:00:00') TO ('2026-06-01 00:00:00');
CREATE TABLE insight.ge_mri_facts_2026_06 PARTITION OF insight.ge_mri_facts
  FOR VALUES FROM ('2026-06-01 00:00:00') TO ('2026-07-01 00:00:00');
CREATE TABLE insight.ge_mri_facts_2026_07 PARTITION OF insight.ge_mri_facts
  FOR VALUES FROM ('2026-07-01 00:00:00') TO ('2026-08-01 00:00:00');
CREATE TABLE insight.ge_mri_facts_2026_08 PARTITION OF insight.ge_mri_facts
  FOR VALUES FROM ('2026-08-01 00:00:00') TO ('2026-09-01 00:00:00');
CREATE TABLE insight.ge_mri_facts_2026_09 PARTITION OF insight.ge_mri_facts
  FOR VALUES FROM ('2026-09-01 00:00:00') TO ('2026-10-01 00:00:00');
CREATE TABLE insight.ge_mri_facts_2026_10 PARTITION OF insight.ge_mri_facts
  FOR VALUES FROM ('2026-10-01 00:00:00') TO ('2026-11-01 00:00:00');
CREATE TABLE insight.ge_mri_facts_2026_11 PARTITION OF insight.ge_mri_facts
  FOR VALUES FROM ('2026-11-01 00:00:00') TO ('2026-12-01 00:00:00');
CREATE TABLE insight.ge_mri_facts_2026_12 PARTITION OF insight.ge_mri_facts
  FOR VALUES FROM ('2026-12-01 00:00:00') TO ('2027-01-01 00:00:00');
CREATE TABLE insight.ge_mri_facts_2027_01 PARTITION OF insight.ge_mri_facts
  FOR VALUES FROM ('2027-01-01 00:00:00') TO ('2027-02-01 00:00:00');
CREATE TABLE insight.ge_mri_facts_2027_02 PARTITION OF insight.ge_mri_facts
  FOR VALUES FROM ('2027-02-01 00:00:00') TO ('2027-03-01 00:00:00');
CREATE TABLE insight.ge_mri_facts_2027_03 PARTITION OF insight.ge_mri_facts
  FOR VALUES FROM ('2027-03-01 00:00:00') TO ('2027-04-01 00:00:00');
CREATE TABLE insight.ge_mri_facts_2027_04 PARTITION OF insight.ge_mri_facts
  FOR VALUES FROM ('2027-04-01 00:00:00') TO ('2027-05-01 00:00:00');
CREATE TABLE insight.ge_mri_facts_2027_05 PARTITION OF insight.ge_mri_facts
  FOR VALUES FROM ('2027-05-01 00:00:00') TO ('2027-06-01 00:00:00');
CREATE TABLE insight.ge_mri_facts_2027_06 PARTITION OF insight.ge_mri_facts
  FOR VALUES FROM ('2027-06-01 00:00:00') TO ('2027-07-01 00:00:00');
CREATE TABLE insight.ge_mri_facts_2027_07 PARTITION OF insight.ge_mri_facts
  FOR VALUES FROM ('2027-07-01 00:00:00') TO ('2027-08-01 00:00:00');
CREATE TABLE insight.ge_mri_facts_2027_08 PARTITION OF insight.ge_mri_facts
  FOR VALUES FROM ('2027-08-01 00:00:00') TO ('2027-09-01 00:00:00');
CREATE TABLE insight.ge_mri_facts_2027_09 PARTITION OF insight.ge_mri_facts
  FOR VALUES FROM ('2027-09-01 00:00:00') TO ('2027-10-01 00:00:00');
CREATE TABLE insight.ge_mri_facts_2027_10 PARTITION OF insight.ge_mri_facts
  FOR VALUES FROM ('2027-10-01 00:00:00') TO ('2027-11-01 00:00:00');
CREATE TABLE insight.ge_mri_facts_2027_11 PARTITION OF insight.ge_mri_facts
  FOR VALUES FROM ('2027-11-01 00:00:00') TO ('2027-12-01 00:00:00');
CREATE TABLE insight.ge_mri_facts_2027_12 PARTITION OF insight.ge_mri_facts
  FOR VALUES FROM ('2027-12-01 00:00:00') TO ('2028-01-01 00:00:00');
CREATE TABLE insight.ge_mri_facts_2028_01 PARTITION OF insight.ge_mri_facts
  FOR VALUES FROM ('2028-01-01 00:00:00') TO ('2028-02-01 00:00:00');
CREATE TABLE insight.ge_mri_facts_2028_02 PARTITION OF insight.ge_mri_facts
  FOR VALUES FROM ('2028-02-01 00:00:00') TO ('2028-03-01 00:00:00');
CREATE TABLE insight.ge_mri_facts_2028_03 PARTITION OF insight.ge_mri_facts
  FOR VALUES FROM ('2028-03-01 00:00:00') TO ('2028-04-01 00:00:00');
CREATE TABLE insight.ge_mri_facts_2028_04 PARTITION OF insight.ge_mri_facts
  FOR VALUES FROM ('2028-04-01 00:00:00') TO ('2028-05-01 00:00:00');
CREATE TABLE insight.ge_mri_facts_2028_05 PARTITION OF insight.ge_mri_facts
  FOR VALUES FROM ('2028-05-01 00:00:00') TO ('2028-06-01 00:00:00');
CREATE TABLE insight.ge_mri_facts_2028_06 PARTITION OF insight.ge_mri_facts
  FOR VALUES FROM ('2028-06-01 00:00:00') TO ('2028-07-01 00:00:00');
CREATE TABLE insight.ge_mri_facts_2028_07 PARTITION OF insight.ge_mri_facts
  FOR VALUES FROM ('2028-07-01 00:00:00') TO ('2028-08-01 00:00:00');
CREATE TABLE insight.ge_mri_facts_2028_08 PARTITION OF insight.ge_mri_facts
  FOR VALUES FROM ('2028-08-01 00:00:00') TO ('2028-09-01 00:00:00');
CREATE TABLE insight.ge_mri_facts_2028_09 PARTITION OF insight.ge_mri_facts
  FOR VALUES FROM ('2028-09-01 00:00:00') TO ('2028-10-01 00:00:00');
CREATE TABLE insight.ge_mri_facts_2028_10 PARTITION OF insight.ge_mri_facts
  FOR VALUES FROM ('2028-10-01 00:00:00') TO ('2028-11-01 00:00:00');
CREATE TABLE insight.ge_mri_facts_2028_11 PARTITION OF insight.ge_mri_facts
  FOR VALUES FROM ('2028-11-01 00:00:00') TO ('2028-12-01 00:00:00');
CREATE TABLE insight.ge_mri_facts_2028_12 PARTITION OF insight.ge_mri_facts
  FOR VALUES FROM ('2028-12-01 00:00:00') TO ('2029-01-01 00:00:00');

-- 2. Daily rollup per system, device wall-clock day, metric and dim.
CREATE TABLE insight.ge_mri_daily (
  system_id   text        NOT NULL,
  local_day   date        NOT NULL,
  metric_key  text        NOT NULL REFERENCES insight.metric_catalog (metric_key),
  dim         text        NOT NULL DEFAULT '',
  n           bigint      NOT NULL CHECK (n > 0),
  value_sum   double precision,
  value_min   double precision,
  value_max   double precision,
  value_last  double precision,
  first_at    timestamp   NOT NULL,
  last_at     timestamp   NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (system_id, local_day, metric_key, dim),
  CONSTRAINT ge_mri_daily_mri_metric CHECK (metric_key LIKE 'mri.%'),
  CHECK (last_at >= first_at),
  CHECK (first_at::date = local_day AND last_at::date = local_day)
);
CREATE INDEX ge_mri_daily_metric_day_idx ON insight.ge_mri_daily (metric_key, local_day);
COMMENT ON TABLE insight.ge_mri_daily IS
  'GE MRI: per system, device wall-clock day (date of ge_mri_facts.host_local), metric and dim. n = facts; a row exists only when n > 0. first_at / last_at are device wall-clock times. Recomputed for touched days only.';

-- 3. Message-code labels (§5.3 Q-M8): derived from the data, not a decoding.
--    label = the code's most common masked template (own host, MAC / IP /
--    serial, digits, dates, AE titles masked). Never raw message text.
CREATE TABLE insight.ge_mri_codes (
  message_number integer     PRIMARY KEY,
  process        text        NOT NULL,
  category       text        CHECK (category IN ('utilization','reliability','hardware','service','inventory','noise')),
  label          text,
  label_share    double precision CHECK (label_share > 0 AND label_share <= 1),
  n              bigint      NOT NULL CHECK (n > 0),
  systems        integer     NOT NULL CHECK (systems > 0),
  first_seen     timestamp   NOT NULL,
  last_seen      timestamp   NOT NULL,
  rule_version   integer     NOT NULL CHECK (rule_version > 0),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (last_seen >= first_seen),
  CHECK ((label IS NULL) = (label_share IS NULL))
);
COMMENT ON TABLE insight.ge_mri_codes IS
  'GE MRI message codes seen: most common process, the reviewed category (NULL = not yet reviewed), and a label = the most common masked template (label_share = its share of the code''s rows). first_seen / last_seen are device wall-clock times. Internal wording.';

-- 4. insight_writer: same rights as on the CT and CV pipeline tables.
GRANT SELECT, INSERT, UPDATE, DELETE ON insight.ge_mri_facts, insight.ge_mri_daily, insight.ge_mri_codes TO insight_writer;
GRANT USAGE, SELECT ON SEQUENCE insight.ge_mri_facts_id_seq TO insight_writer;
