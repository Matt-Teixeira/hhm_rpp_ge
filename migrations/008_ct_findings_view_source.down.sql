-- 008_ct_findings_view_source.down.sql
-- Reverts 008: restores the 005 definition of api.ge_ct_findings_v (no
-- source filter). No data changes.

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
JOIN insight.finding_catalog c ON c.finding_key = f.finding_key;
COMMENT ON VIEW api.ge_ct_findings_v IS
  'Open and resolved findings with catalog labels. data_through = the device day the evaluation''s data ran through. evidence may hold internal ids; external renders go through the sme_reports scrub.';
