# Code review — Phase 6 step 1 (migration 006)

## No findings

I found no actionable defect in the two view definitions, their down migration, or the added scanner tests.

- `api.ge_ct_days_v` computes one row per non-null `(system_id, host_local::date)`. Adding `system_id` to `DISTINCT ON` and the ordering preserves the findings loader's result for a per-system query; the join on both keys correctly pairs each day's midnight with its min/max fact times. The facts schema declares `system_id` non-null.
- The `local_midnight` expression and tie-break order match `DAYS_SQL`. A clock/DST change within a device day can make the heatmap hour estimate shift, but that limitation is documented in the view comment and matches the agreed contract.
- `api.ge_ct_capabilities_v` includes the agreed capability and catalog fields. `system_capabilities.metric_key` has a foreign key to `metric_catalog`, so the inner join does not silently drop valid capability rows.
- The up migration creates and comments on only the two new views. The down migration drops only those views without `CASCADE`.
- The new tests check the created object set, down migration, and key day-definition expressions.

Evidence: code/schema inspection only. The handoff's read-only database comparison and migration dry-run results were considered as reported; I did not run tests, probes, or database commands.
