-- 006_phase6_viewer_views.sql
-- Phase 6 contract views (PLAN-CT-INSIGHTS.md §16.3 Q1). Views only: no
-- table, no column, no grant, nothing the ge_ct stage reads. New names, so
-- nothing is dropped. Both read only insight.*: no dependency on log.* or
-- public.* objects. The internal viewer (reports sme_reports/ct) and later
-- the frontend read them.
--
-- Apply ONLY through migrations/run.js.

-- 1. Device days. One row per system and device wall-clock day that has at
--    least one fact. The day and local_midnight use exactly the definition
--    of the findings loader (insight/findings/load.js DAYS_SQL): the day is
--    host_local::date, and local_midnight is taken from the day's earliest
--    fact by device clock (ties: earliest host_datetime). Checked read-only
--    2026-11-05: 0 differences from DAYS_SQL over 5,057 days, 34 systems.
--    A filter on system_id reaches the facts index in both branches.
CREATE VIEW api.ge_ct_days_v AS
SELECT a.system_id,
       a.local_day,
       a.local_midnight,
       b.first_at,
       b.last_at
FROM (SELECT DISTINCT ON (f.system_id, f.host_local::date)
             f.system_id,
             f.host_local::date AS local_day,
             f.host_datetime - (f.host_local - f.host_local::date::timestamp) AS local_midnight
      FROM insight.ge_ct_facts f
      ORDER BY f.system_id, f.host_local::date, f.host_local, f.host_datetime) a
JOIN (SELECT f.system_id,
             f.host_local::date AS local_day,
             min(f.host_datetime) AS first_at,
             max(f.host_datetime) AS last_at
      FROM insight.ge_ct_facts f
      GROUP BY f.system_id, f.host_local::date) b
  ON b.system_id = a.system_id AND b.local_day = a.local_day;
COMMENT ON VIEW api.ge_ct_days_v IS
  'One row per system and device wall-clock day with data (same definition as the findings rules). local_midnight = the instant of device-local midnight that day, from the earliest fact by device clock: local hour of an instant t that day = t - local_midnight (shifts if the device clock offset changes within the day). first_at / last_at = earliest / latest fact instant (host_datetime) of the day.';

-- 2. Capabilities with catalog labels. A metric absent here for a system
--    means "this system never logged it", not "zero events" (§3).
CREATE VIEW api.ge_ct_capabilities_v AS
SELECT s.system_id,
       s.metric_key,
       c.label,
       c.unit,
       c.category,
       c.value_kind,
       c.model_specific,
       c.customer_visible,
       s.first_seen,
       s.last_seen,
       s.n,
       s.updated_at
FROM insight.system_capabilities s
JOIN insight.metric_catalog c ON c.metric_key = s.metric_key;
COMMENT ON VIEW api.ge_ct_capabilities_v IS
  'Metrics each system has ever emitted (first/last seen, fact count), with catalog labels. Absent = the system does not log it; present with no daily rows in a period = zero events.';
