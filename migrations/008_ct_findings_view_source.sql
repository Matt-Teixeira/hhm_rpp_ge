-- 008_ct_findings_view_source.sql
-- C3 (PLAN-CV-INSIGHTS.md §7.4, §10.5; F5 agreed 2026-11-10): the CT
-- findings view shows CT findings only. insight.findings is shared with GE
-- CV (source = 'ge_cv', written by insight/cv/findings from CV-4 on);
-- api.ge_cv_findings_v (007) already shows only those.
--
-- Every consumer of api.ge_ct_findings_v filters source = 'ge_ct' itself
-- (reports/sme_reports/ct/data.js and verify.js; checked 2026-11-10), and
-- today every finding is ge_ct, so nothing they see changes. Same columns
-- as 005. The runner treats CREATE OR REPLACE as a create, so drop and
-- re-create, as 005 did: the view has no grants and no dependants (checked
-- on prod, read-only, 2026-11-10).
--
-- Apply ONLY through migrations/run.js.

DROP VIEW api.ge_ct_findings_v;
CREATE VIEW api.ge_ct_findings_v AS
SELECT f.system_id,
       f.finding_key,
       c.label,
       c.category,
       c.description,
       c.customer_visible,
       f.source,
       f.status,
       f.severity,
       f.opened_at,
       f.resolved_at,
       f.data_through,
       f.window_start,
       f.window_end,
       f.observed,
       f.baseline,
       f.evidence,
       f.rule_version,
       f.last_evaluated
FROM insight.findings f
JOIN insight.finding_catalog c ON c.finding_key = f.finding_key
WHERE f.source = 'ge_ct';
COMMENT ON VIEW api.ge_ct_findings_v IS
  'GE CT open and resolved findings (source ge_ct) with catalog labels. data_through = the device day the evaluation''s data ran through. evidence may hold internal ids; external renders go through the sme_reports scrub.';
