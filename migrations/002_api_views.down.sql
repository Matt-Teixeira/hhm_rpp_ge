-- 002_api_views.down.sql
-- Reverts 002: removes the api.ge_ct_* views. Leaves the rest of `api`
-- (hca_odata, request_history, ...) untouched. No CASCADE.

DROP VIEW api.ge_ct_system_summary_v;
DROP VIEW api.ge_ct_exams_v;
DROP VIEW api.ge_ct_tube_v;
DROP VIEW api.ge_ct_findings_v;
DROP VIEW api.ge_ct_daily_v;
