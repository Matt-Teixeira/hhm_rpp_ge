-- 001_insight_schema.down.sql
-- Reverts 001: removes schema `insight` and everything in it.
-- No CASCADE: if anything outside insight depends on these objects (e.g.
-- the api.ge_ct_* views from 002), the DROP fails instead of silently
-- removing it. Revert 002 first.
--
-- Destroys all insight data. Never part of the normal flow; run only via
-- migrations/run.js down (dry run by default).

DROP FUNCTION insight.ensure_ge_ct_facts_partitions(timestamptz, timestamptz);

-- Dropping the partitioned parent drops its partitions and the OWNED BY sequence.
DROP TABLE insight.ge_ct_facts;

DROP TABLE insight.ge_ct_daily;
DROP TABLE insight.system_capabilities;
DROP TABLE insight.ge_ct_exams;
DROP TABLE insight.ge_ct_tube_segments;
DROP TABLE insight.findings;
DROP TABLE insight.job_state;
DROP TABLE insight.unmatched_templates;
DROP TABLE insight.metric_catalog;
DROP TABLE insight.schema_migrations;

DROP SCHEMA insight;
