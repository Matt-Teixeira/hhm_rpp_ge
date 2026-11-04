# Code review — Phase 3 checkpoint 4

### F1 — Missing `--system` value silently selects the whole fleet
- Severity: medium
- Confidence: confirmed
- Location: insight/cli.js:49
- What's wrong: When `--system` is the final argument, `a.system` becomes `undefined`. The later conversion to `a.systems` is conditional on `a.system` being truthy, so the derive call receives `systems: null` and `run_derive` interprets that as “all systems.” A typo in a scoped command can therefore turn into a fleet-wide apply instead of a usage error.
- Failure scenario: `node insight/cli.js derive --apply --system` prompts for the database and `APPLY`, then rebuilds every system and advances the fleet derive watermark. The prompt does not tell the user that the missing system value changed the scope.
- Evidence: code inspection of `args()` at lines 49 and 62 and `derive()` at lines 202-203, together with `run_derive()` at `insight/derive/run.js:76`, where a null system list selects `all_systems()`. No database connection or test was used.
- Suggested fix: require a non-empty value after `--system` / `--systems`, reject values beginning with `--`, and reject an empty parsed system list before connecting.
- Data impact: future runs only; no evidence the recorded apply used a malformed invocation.

### F2 — Exam verification omits `protocol` and `local_day`
- Severity: medium
- Confidence: confirmed
- Location: insight/derive/verify.js:87
- What's wrong: `EXAMS_DIFF_SQL` reconstructs and compares counts, activity time, reopened status, and series count, but it does not select or compare the expected exam protocol (`exam.start.value_text`) or device `local_day` (`exam.start.host_local::date`). These are stored output columns, and the handoff says exam rows are compared on every column. A verify pass can succeed when either field is wrong.
- Failure scenario: an exam row has the correct key, counts, and activity time but a stale or incorrectly derived `protocol` or `local_day`. The full join still matches the row, and none of the `differ` predicates checks those columns, so `verify-derive` reports PASS.
- Evidence: code inspection of the independent exam CTE and comparison predicates at `verify.js:63-108`; neither expected value is included in `x`, and neither stored column appears in the comparisons. No database connection or test was used.
- Suggested fix: add expected protocol and device local day to the independent CTE and compare them with `IS DISTINCT FROM`, including them in the diagnostic sample predicate.
- Data impact: existing exam rows could contain errors that this verifier would not report; I found no evidence that the written values are actually wrong.

### F3 — Boot verification can collapse distinct natural keys
- Severity: low
- Confidence: confirmed
- Location: insight/derive/verify.js:122
- What's wrong: The comparison key uses only `(system_id, epoch, record_number_concurrent)`, while the facts table's natural key also includes `host_datetime`. The repository documents known cases where the shorter triple is not unique. In `check_boots`, SQL rows are put in a `Map` by this shortened key; multiple expected boots with the same triple overwrite one another. The code reports the SQL/fact counts but does not fail on a count mismatch by itself.
- Failure scenario: two expected boot rows share the triple but have different `host_datetime` values, and only one corresponding fact exists. The map contains one SQL entry; the one fact can match it, leaving no unmatched map entry, so the missing boot may pass the key comparison.
- Evidence: code inspection of `key()` at line 122 and `check_boots()` at lines 179-190. The table's natural key definition includes `host_datetime` in `migrations/001_insight_schema.sql`; no database query or test was run.
- Suggested fix: include normalized `host_datetime` in the comparison key and explicitly compare the fact and SQL result counts. Apply the same key correction to the tube comparison for consistency.
- Data impact: verification could miss a missing boot if a collision occurs; no evidence that such a collision affected the written boot facts.

