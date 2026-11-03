# Code review — `1e41a6c..dev`

### F1 — Migration scan accepts API views with side-effecting calls
- Severity: medium
- Confidence: confirmed (scanner probe)
- Location: migrations/lib/sqlscan.js:240
- What's wrong: `CREATE VIEW` is accepted after checking only the view name; the query body is not checked for calls to volatile or `SECURITY DEFINER` functions. Such a view can invoke a function that writes to a protected schema when a consumer reads it, outside the migration's catalog fingerprint checks.
- Failure scenario: a migration creates `api.ge_ct_example AS SELECT public.write_to_log()`; the static scan accepts it, and later a read of the API view mutates a table outside the allowed schemas.
- Evidence: a DB-free probe of `scanSql("CREATE VIEW api.ge_ct_probe AS SELECT nextval('public.external_seq');")` returned `ok: true`. `nextval` is itself a sequence side effect when the view is queried.
- Suggested fix: inspect view query bodies and reject side-effecting calls, or require API views to use an explicitly reviewed, read-only query form.

### F2 — Writer privilege audit omits executable functions
- Severity: medium
- Confidence: likely
- Location: maintenance/create_insight_writer.js:50
- What's wrong: the privilege audit enumerates relation and schema privileges, but never checks effective `EXECUTE` rights on functions. PostgreSQL commonly grants function execution to `PUBLIC`; a `SECURITY DEFINER` function with write behavior could therefore give `insight_writer` a path to write outside `insight` while the audit reports success.
- Failure scenario: a public `SECURITY DEFINER` function writes to `public` or `log`; the new role inherits `EXECUTE`, passes `UNEXPECTED_PRIVS_SQL`, and can invoke that function.
- Evidence: code inspection of `UNEXPECTED_PRIVS_SQL` shows it scans `pg_class` relations and schema `CREATE` only; no `pg_proc`, function ACL, or `has_function_privilege` check is present. No database query was run.
- Suggested fix: audit effective function `EXECUTE` grants outside `insight`, at minimum for `SECURITY DEFINER` functions, and deny or revoke any mutating entry points available to the role.

### F3 — Dedupe deletion can race a new alert reference
- Severity: medium
- Confidence: possible
- Location: maintenance/dedupe_ge_ct_gesys.js:97
- What's wrong: the “now referenced” check and deletion are in one transaction, but the check does not lock or otherwise serialize writes to `alert.detections`. A concurrent detection insert can reference a candidate after the check and before its delete commits.
- Failure scenario: delete transaction observes zero references; another transaction inserts and commits a detection for that `row_id`; delete then removes the source row, leaving the detection without its source.
- Evidence: inspection of the per-partition flow at lines 249–260 shows the check precedes `DELETE`, with no lock on `alert.detections` and no FK-based protection in this tool.
- Suggested fix: coordinate cleanup with the detection writer, or acquire a lock/serialization mechanism that prevents references from being added between the final check and delete.

### F4 — Documented restore statement includes rows deliberately kept live
- Severity: medium
- Confidence: confirmed (query logic)
- Location: maintenance/dedupe_ge_ct_gesys.js:23
- What's wrong: the restore example selects every archived row, including rows marked `referenced_by_detection` that the delete step intentionally left in `log.ge_ct_gesys`. Inserting those rows again conflicts with their existing primary keys and aborts the restore statement.
- Failure scenario: restore an archive containing the 49 kept, detection-referenced rows from the completed cleanup; the insert attempts to copy those still-live rows and fails on their primary keys.
- Evidence: archive fill copies all duplicates (lines 75–80); delete excludes `referenced_by_detection` rows (lines 102–108); the documented restore has no such filter.
- Suggested fix: restore only archived rows that were deleted (`NOT referenced_by_detection`), and make the restore safe to rerun.

### F5 — Numeric rule output can become `Infinity`
- Severity: low
- Confidence: confirmed (pure-function probe)
- Location: insight/rules/engine.js:51
- What's wrong: the engine converts `NaN` to `null` but leaves `Infinity` unchanged. Several rules convert arbitrary-length digit captures to numbers, so a malformed or corrupted log value can produce a non-finite fact value.
- Failure scenario: `tube usage data reports a total of ` followed by 400 `9` digits and ` ma*S` yields a `tube.mas_total` fact with `value_num: Infinity`; a future extraction run may persist an invalid metric or fail its fact batch.
- Evidence: a DB-free `facts_for_row` probe with that message returned `value_num: Infinity`.
- Suggested fix: normalize every non-finite numeric output to `null` or reject/count the rule result before it reaches persistence.

## Reviewed, no issues found

- Live ingest dedupe and missed-rotation handling: checked empty and all-duplicate paths, null timestamps, content comparison, error fail-open behavior, Redis ordering, existing tube-usage inputs, offline upsert input, and header handling. The reviewed behavior matches the plan's stated intent.
- SCRAM verifier: reviewed implementation; published-vector and format tests pass.
- Dedupe keeper selection and normal delete checks: exact content comparison excludes only `id` and `capture_datetime`; referenced rows are excluded from deletion and keeper checks verify exact content.
- Rule registry, reconciliation SQL, fixture labels, and scrubber: reviewed regex/scale handling and committed fixture handling; no additional concrete defect found.
- Migrations 001/002/003 and runner transaction flow: reviewed checksum behavior, rollback-on-check-failure path, declared-object checks, and partition/grant statements. No other concrete issue found.
- Catalog fingerprint: reviewed relation, function, schema, view, and partition coverage. No additional actionable gap found beyond the scanner/view issue above.
- Node 16 compatibility: no incompatible API found in reviewed changed code.

## Permitted test commands

- `node migrations/test/sqlscan.test.js` — passed (8/8).
- `node test/drop_already_ingested.test.js` — passed (9/9).
- `node test/gesys_head.test.js` — passed (4/4).
- `node test/scram.test.js` — passed (2/2).
- `node insight/test/rules.test.js` — passed (14/14).
- `node insight/test/scrub.test.js` — passed (3/3).

---

## Resolution (Claude, 2026-11-03)

Each finding was reproduced or checked independently before fixing. All 6 suites pass afterwards (43 tests), and a read-only dry run still reconciles exactly against the independent SQL.

| # | Verdict | Fix | Verified by |
|---|---|---|---|
| F1 | **Confirmed, and broader**: a column `DEFAULT public.fn()` also passed, and it would run on every pipeline insert | `migrations/lib/sqlscan.js` checks function calls everywhere (statement text, view bodies, defaults, function bodies). Schema-qualified calls are allowed only into `insight.*`, `pg_catalog.*` or `api.ge_ct_*`. Side-effecting built-ins are refused (`setval`, advisory locks, `pg_notify`, `lo_*`, `pg_sleep`, WAL/replication/stat-reset …). `nextval`/`currval` must name an `insight.*` sequence literally | 10 new refuse/allow cases in `migrations/test/sqlscan.test.js`, including Codex's probe. All 6 migration files still pass with unchanged checksums (001/002 are applied in prod) |
| F2 | **Valid gap, no current exposure**: none of the 24 non-system functions in prod is `SECURITY DEFINER`, and invoker functions run with the caller's own rights | The `create_insight_writer.js` audit now fails if the role can EXECUTE any `SECURITY DEFINER` function outside `pg_catalog`/`information_schema` | Dry run on prod passes ("no executable SECURITY DEFINER functions …"), rolls back, and leaves no role behind. The firing path was not exercised (no such function exists, and creating one would be a prod write) |
| F3 | **Valid, theoretical**: the completed run was verified with 0 detections pointing at deleted rows | `dedupe_ge_ct_gesys.js` re-checks new detection references after the DELETE and before COMMIT, inside the same transaction. That narrows the race to the commit. Fully closing it needs a lock on `alert.detections`, which the tool deliberately doesn't take (not our table). Documented: run between alert-processor runs | A re-run on today's archive (dry run) refuses at the pre-check (`archived_row_changed_or_missing = 3594`), as it should. The post-check itself can't be exercised without a fresh duplicate set |
| F4 | **Confirmed** | The wrong restore comment is replaced by `restore-sql --table T` (read-only). It prints the exact statement, which restores only `NOT referenced_by_detection` rows with `ON CONFLICT DO NOTHING`, and counts what it would do | Against the real archive: 154,945 rows to restore (= rows deleted), 49 kept rows skipped, 0 already present |
| F5 | **Confirmed** | `insight/rules/engine.js`: any non-finite or non-number `value_num` becomes `null` | New test with Codex's 400-digit probe, plus `-Infinity` and string cases |
