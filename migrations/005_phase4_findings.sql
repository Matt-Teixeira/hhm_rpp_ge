-- 005_phase4_findings.sql
-- Phase 4 schema (PLAN-CT-INSIGHTS.md §14.2 "Schema"). Insight-only.
-- insight.findings is still empty (checked 2026-11-04), so the NOT NULL
-- column and the foreign key are cheap. insight_writer already has DML on
-- insight.findings (003).
--
-- Apply ONLY through migrations/run.js.

-- 1. Finding catalog: one row per finding_key, generated from the findings
--    registry (insight/findings/) and synced at stage start, like
--    metric_catalog. Gives the viewer and the frontend their labels.
CREATE TABLE insight.finding_catalog (
  finding_key      text        PRIMARY KEY CHECK (finding_key ~ '^[a-z][a-z0-9_]*$'),
  label            text        NOT NULL,
  description      text,
  category         text        NOT NULL CHECK (category IN ('utilization','tube','reliability','compliance','environment','inventory')),
  default_severity text        NOT NULL CHECK (default_severity IN ('info','low','medium','high')),
  rule_version     integer     NOT NULL DEFAULT 1 CHECK (rule_version > 0),
  customer_visible boolean     NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE insight.finding_catalog IS
  'One row per finding_key, generated from the findings registry (insight/findings). Drives labels in every consumer. default_severity is the usual severity; a finding row carries its own.';

-- 2. Findings reference the catalog (facts do the same with metric_catalog),
--    and record the device day the evaluation's data ran through.
ALTER TABLE insight.findings ADD CONSTRAINT findings_finding_key_fkey
  FOREIGN KEY (finding_key) REFERENCES insight.finding_catalog (finding_key);
ALTER TABLE insight.findings ADD COLUMN data_through date NOT NULL;
COMMENT ON COLUMN insight.findings.data_through IS
  'Device wall-clock day the system''s data ran through at the last evaluation (as-of day). Systems with no data in the last 7 device days are not evaluated, so this shows how stale an open finding is.';

-- 3. insight_writer: same rights as on metric_catalog.
GRANT SELECT, INSERT, UPDATE, DELETE ON insight.finding_catalog TO insight_writer;

-- 4. Consumer view with catalog labels. The column list changes, so drop
--    and re-create (no grants or dependants on this view; checked
--    2026-11-04).
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
