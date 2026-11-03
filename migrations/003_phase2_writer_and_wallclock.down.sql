-- 003_phase2_writer_and_wallclock.down.sql
-- Reverts 003. Only valid while the tables are empty: SET NOT NULL fails
-- if any daily row has a NULL time_zone, and dropping host_local discards
-- data. No CASCADE.

REVOKE USAGE, SELECT ON SEQUENCE insight.ge_ct_facts_id_seq FROM insight_writer;
REVOKE SELECT, INSERT, UPDATE, DELETE ON insight.metric_catalog, insight.ge_ct_facts, insight.ge_ct_daily, insight.ge_ct_exams, insight.ge_ct_tube_segments, insight.system_capabilities, insight.findings, insight.job_state, insight.unmatched_templates FROM insight_writer;
REVOKE SELECT ON insight.schema_migrations FROM insight_writer;
REVOKE USAGE ON SCHEMA insight FROM insight_writer;

DROP TABLE insight.ge_ct_facts_2027_07;
DROP TABLE insight.ge_ct_facts_2027_08;
DROP TABLE insight.ge_ct_facts_2027_09;
DROP TABLE insight.ge_ct_facts_2027_10;
DROP TABLE insight.ge_ct_facts_2027_11;
DROP TABLE insight.ge_ct_facts_2027_12;
DROP TABLE insight.ge_ct_facts_2028_01;
DROP TABLE insight.ge_ct_facts_2028_02;
DROP TABLE insight.ge_ct_facts_2028_03;
DROP TABLE insight.ge_ct_facts_2028_04;
DROP TABLE insight.ge_ct_facts_2028_05;
DROP TABLE insight.ge_ct_facts_2028_06;
DROP TABLE insight.ge_ct_facts_2028_07;
DROP TABLE insight.ge_ct_facts_2028_08;
DROP TABLE insight.ge_ct_facts_2028_09;
DROP TABLE insight.ge_ct_facts_2028_10;
DROP TABLE insight.ge_ct_facts_2028_11;
DROP TABLE insight.ge_ct_facts_2028_12;

COMMENT ON COLUMN insight.ge_ct_daily.time_zone IS NULL;
ALTER TABLE insight.ge_ct_daily ALTER COLUMN time_zone SET NOT NULL;

ALTER TABLE insight.ge_ct_facts DROP COLUMN host_local;
