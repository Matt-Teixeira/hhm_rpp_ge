-- 009_mri_schema.down.sql
-- Reverts 009: drops the three MRI tables (the facts partitions and id
-- sequence go with their table). Destroys all MRI insight data; leaves
-- every shared table (metric_catalog, finding_catalog, findings, job_state)
-- and its rows alone, so mri.* catalog rows, ge_mri findings and ge_mri_*
-- job_state rows written by the pipeline stay behind. No CASCADE.

REVOKE USAGE, SELECT ON SEQUENCE insight.ge_mri_facts_id_seq FROM insight_writer;
REVOKE SELECT, INSERT, UPDATE, DELETE ON insight.ge_mri_facts, insight.ge_mri_daily, insight.ge_mri_codes FROM insight_writer;

DROP TABLE insight.ge_mri_codes;
DROP TABLE insight.ge_mri_daily;
-- Drops its partitions and the OWNED BY sequence insight.ge_mri_facts_id_seq too.
DROP TABLE insight.ge_mri_facts;
