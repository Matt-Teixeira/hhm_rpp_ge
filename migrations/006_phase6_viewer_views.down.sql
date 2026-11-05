-- 006_phase6_viewer_views.down.sql
-- Reverts 006: drops the two Phase 6 contract views. Views only, so no
-- data is lost. No CASCADE: fails if anything has come to depend on them.

DROP VIEW api.ge_ct_capabilities_v;
DROP VIEW api.ge_ct_days_v;
