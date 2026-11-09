-- 007_cv_schema.down.sql
-- Reverts 007: drops the api.ge_cv_* views and the three CV tables (the
-- facts id sequence goes with its table). Destroys all CV insight data;
-- leaves every shared table (metric_catalog, finding_catalog, findings,
-- job_state) and its rows alone, so cv.* catalog rows, ge_cv findings and
-- ge_cv_* job_state rows written by the pipeline stay behind. No CASCADE.

-- Views first: they depend on the tables.
DROP VIEW api.ge_cv_system_summary_v;
DROP VIEW api.ge_cv_findings_v;
DROP VIEW api.ge_cv_codes_v;
DROP VIEW api.ge_cv_capabilities_v;
DROP VIEW api.ge_cv_daily_v;

REVOKE USAGE, SELECT ON SEQUENCE insight.ge_cv_facts_id_seq FROM insight_writer;
REVOKE SELECT, INSERT, UPDATE, DELETE ON insight.ge_cv_facts, insight.ge_cv_daily, insight.ge_cv_codes FROM insight_writer;

DROP TABLE insight.ge_cv_codes;
DROP TABLE insight.ge_cv_daily;
-- Drops the OWNED BY sequence insight.ge_cv_facts_id_seq too.
DROP TABLE insight.ge_cv_facts;
