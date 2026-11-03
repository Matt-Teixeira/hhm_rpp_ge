-- 003_phase2_writer_and_wallclock.sql
-- Phase 2 schema follow-ups (PLAN-CT-INSIGHTS.md §12). Insight-only; the
-- tables are still empty.
--
-- PREREQUISITE: role insight_writer must exist. It is created by
-- maintenance/create_insight_writer.js, run on the production server. If
-- it doesn't exist, the GRANTs fail and the runner rolls everything back.
--
-- Apply ONLY through migrations/run.js.

-- 1. Device wall-clock time on every fact. Daily/hourly rollups use this,
--    not sites.time_zone_id, which is NULL for 19 of 31 reporting systems.
ALTER TABLE insight.ge_ct_facts ADD COLUMN host_local timestamp NOT NULL;
COMMENT ON COLUMN insight.ge_ct_facts.host_local IS
  'Device wall-clock time of the source record (log.ge_ct_gesys host_date + host_time). Local day/hour come from this.';

-- 2. ge_ct_daily.time_zone is no longer used: the day comes from the device
--    wall clock. Kept as a nullable column (not dropped) so 003 down
--    restores the table exactly.
ALTER TABLE insight.ge_ct_daily ALTER COLUMN time_zone DROP NOT NULL;
COMMENT ON COLUMN insight.ge_ct_daily.time_zone IS
  'Unused since 003: local_day comes from the device wall clock (ge_ct_facts.host_local).';

-- 3. Partitions through 2028-12. insight_writer can't create partitions
--    (that needs ownership of ge_ct_facts), so they are added by migration;
--    the stage warns when fewer than 6 months remain.
CREATE TABLE insight.ge_ct_facts_2027_07 PARTITION OF insight.ge_ct_facts
  FOR VALUES FROM ('2027-07-01 00:00:00+00') TO ('2027-08-01 00:00:00+00');
CREATE TABLE insight.ge_ct_facts_2027_08 PARTITION OF insight.ge_ct_facts
  FOR VALUES FROM ('2027-08-01 00:00:00+00') TO ('2027-09-01 00:00:00+00');
CREATE TABLE insight.ge_ct_facts_2027_09 PARTITION OF insight.ge_ct_facts
  FOR VALUES FROM ('2027-09-01 00:00:00+00') TO ('2027-10-01 00:00:00+00');
CREATE TABLE insight.ge_ct_facts_2027_10 PARTITION OF insight.ge_ct_facts
  FOR VALUES FROM ('2027-10-01 00:00:00+00') TO ('2027-11-01 00:00:00+00');
CREATE TABLE insight.ge_ct_facts_2027_11 PARTITION OF insight.ge_ct_facts
  FOR VALUES FROM ('2027-11-01 00:00:00+00') TO ('2027-12-01 00:00:00+00');
CREATE TABLE insight.ge_ct_facts_2027_12 PARTITION OF insight.ge_ct_facts
  FOR VALUES FROM ('2027-12-01 00:00:00+00') TO ('2028-01-01 00:00:00+00');
CREATE TABLE insight.ge_ct_facts_2028_01 PARTITION OF insight.ge_ct_facts
  FOR VALUES FROM ('2028-01-01 00:00:00+00') TO ('2028-02-01 00:00:00+00');
CREATE TABLE insight.ge_ct_facts_2028_02 PARTITION OF insight.ge_ct_facts
  FOR VALUES FROM ('2028-02-01 00:00:00+00') TO ('2028-03-01 00:00:00+00');
CREATE TABLE insight.ge_ct_facts_2028_03 PARTITION OF insight.ge_ct_facts
  FOR VALUES FROM ('2028-03-01 00:00:00+00') TO ('2028-04-01 00:00:00+00');
CREATE TABLE insight.ge_ct_facts_2028_04 PARTITION OF insight.ge_ct_facts
  FOR VALUES FROM ('2028-04-01 00:00:00+00') TO ('2028-05-01 00:00:00+00');
CREATE TABLE insight.ge_ct_facts_2028_05 PARTITION OF insight.ge_ct_facts
  FOR VALUES FROM ('2028-05-01 00:00:00+00') TO ('2028-06-01 00:00:00+00');
CREATE TABLE insight.ge_ct_facts_2028_06 PARTITION OF insight.ge_ct_facts
  FOR VALUES FROM ('2028-06-01 00:00:00+00') TO ('2028-07-01 00:00:00+00');
CREATE TABLE insight.ge_ct_facts_2028_07 PARTITION OF insight.ge_ct_facts
  FOR VALUES FROM ('2028-07-01 00:00:00+00') TO ('2028-08-01 00:00:00+00');
CREATE TABLE insight.ge_ct_facts_2028_08 PARTITION OF insight.ge_ct_facts
  FOR VALUES FROM ('2028-08-01 00:00:00+00') TO ('2028-09-01 00:00:00+00');
CREATE TABLE insight.ge_ct_facts_2028_09 PARTITION OF insight.ge_ct_facts
  FOR VALUES FROM ('2028-09-01 00:00:00+00') TO ('2028-10-01 00:00:00+00');
CREATE TABLE insight.ge_ct_facts_2028_10 PARTITION OF insight.ge_ct_facts
  FOR VALUES FROM ('2028-10-01 00:00:00+00') TO ('2028-11-01 00:00:00+00');
CREATE TABLE insight.ge_ct_facts_2028_11 PARTITION OF insight.ge_ct_facts
  FOR VALUES FROM ('2028-11-01 00:00:00+00') TO ('2028-12-01 00:00:00+00');
CREATE TABLE insight.ge_ct_facts_2028_12 PARTITION OF insight.ge_ct_facts
  FOR VALUES FROM ('2028-12-01 00:00:00+00') TO ('2029-01-01 00:00:00+00');

-- 4. insight_writer: read the schema version, read/write the pipeline
--    tables, use the facts id sequence. No DDL, no TRUNCATE, and
--    schema_migrations stays read-only.
GRANT USAGE ON SCHEMA insight TO insight_writer;
GRANT SELECT ON insight.schema_migrations TO insight_writer;
GRANT SELECT, INSERT, UPDATE, DELETE ON insight.metric_catalog, insight.ge_ct_facts, insight.ge_ct_daily, insight.ge_ct_exams, insight.ge_ct_tube_segments, insight.system_capabilities, insight.findings, insight.job_state, insight.unmatched_templates TO insight_writer;
GRANT USAGE, SELECT ON SEQUENCE insight.ge_ct_facts_id_seq TO insight_writer;
