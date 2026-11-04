-- 005_phase4_findings.down.sql
-- Reverts 005: restores the 002 findings view, drops data_through, the
-- foreign key and insight.finding_catalog. Loses the catalog rows and
-- every finding's data_through; findings themselves are kept. No CASCADE.

-- View first: it depends on finding_catalog and data_through.
DROP VIEW api.ge_ct_findings_v;
CREATE VIEW api.ge_ct_findings_v AS
SELECT f.system_id,
       f.finding_key,
       f.source,
       f.status,
       f.severity,
       f.opened_at,
       f.resolved_at,
       f.window_start,
       f.window_end,
       f.observed,
       f.baseline,
       f.evidence,
       f.rule_version,
       f.last_evaluated
FROM insight.findings f;
COMMENT ON VIEW api.ge_ct_findings_v IS
  'v0 placeholder. evidence may hold internal ids; external renders go through the sme_reports scrub.';

ALTER TABLE insight.findings DROP COLUMN data_through;
ALTER TABLE insight.findings DROP CONSTRAINT findings_finding_key_fkey;

REVOKE SELECT, INSERT, UPDATE, DELETE ON insight.finding_catalog FROM insight_writer;
DROP TABLE insight.finding_catalog;
