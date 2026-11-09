# Review: CV-2 extract

## Findings

### P2 — `backfill` does not validate the registry before writing the shared catalog

`insight/cv/rules.js` exports `validate()`, and `dry_run()` calls it, but `run_extract()` does not. Both `backfill --rehearse` and `backfill --apply` reach `catalog_statement(rules)` without checking the registry (`insight/cv/load.js:228-230, 256-258`). The apply path commits that catalog upsert in its own transaction before extracting any batch.

If a future registry edit uses a syntactically valid but non-`cv.*` metric key, the catalog upsert can commit that shared row before the fact-table `cv.%` CHECK rejects the batch. An overlapping code list can likewise leave catalog rows committed before a matching row aborts extraction. These partial outcomes make rehearsal/apply fail after a shared-table write and can affect catalog verification. Call `validate()` and refuse both write modes before `catalog_statement`; keep the check in `dry-run` as well. Add a test that `run_extract` refuses an invalid registry without reaching the catalog write.

## Reviewed paths

- `reconcile_sql.js` is a separate SQL implementation of the per-system/per-metric predicates. I compared its relay, storable-row, and named-metric conditions with `rules.js`: the anticollision predicates count the same rows, including the intentionally empty dim fallback for code 1050177; the remaining code/text predicates also match. JS and PostgreSQL matching are case-sensitive here, and the patterns tolerate the stored quotes and leading spaces. The full-row classifier comparison and SQL reconciliation in the handoff add useful evidence beyond fixture tests.
- The `ge_cv_facts_source_key` constraint in migration 007 matches the loader’s conflict target. The upsert updates the mutable fact columns and `rule_version` only when the incoming version is higher. Per-batch stats are copied back only after the facts, watermark, and pending-day update commit together.
- The late-commit query checks the full source key and the two-hour capture window. It intentionally re-reads relays because they have no facts; this is bounded by the window and does not create facts. `record_derive_pending` creates the CV derive row if needed and locks/merges its pending map without overwriting the CT job rows.
- The C1 and C2 checks run in preflight before catalog or fact writes in apply mode. Rehearsal may run before C1 because all its catalog, facts, and job-state writes are in one transaction that is rolled back. C2 is checked in both modes.
- CV and CT use different advisory-lock keys and different `job_state` keys. Their table-level DML locks are compatible; the catalog upserts address distinct metric keys. I found no other CT read path affected by CV’s shared catalog or job-state rows beyond the documented C1 verifier checks.
- The rule-error policy aborts the batch instead of silently dropping a fact; for this manual backfill, that preserves the coverage guarantee and leaves the watermark unchanged for retry.
- The fixtures I inspected contain generic GE diagnostic text, source-file paths, and no apparent patient identifiers or live network addresses. Fixture SQL avoids encoded fields, and the production extractor/reconciliation queries select no `errortext`, `fru`, `majorfunction`, or `minorfunction` fields.
- The facts retain the source row key, error code, subsystem, host/device time, and `cv.error` source attributes needed for CV-3. The transactionally merged pending device days give derive the affected ranges.

## Verification

- `node insight/cv/test/cv.test.js`: 14 passed.
- All seven `insight/test/*.test.js` suites passed (14, 12, 31, 3, 16, 3, and 24 tests).
- `node --test migrations/test`: passed.
- No CV CLI or database migration commands were run.
