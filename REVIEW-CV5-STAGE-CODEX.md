# CV-5 step 2 review: stage, wrapper, and rehearsal

## Findings

No stage-specific correctness findings.

## Review notes

- `run_cv_insight` is a faithful copy of CT's wrapper for the reviewed concerns: the dedicated connection, bounded timeouts, whole-stage deadline, lock acquisition/release, preflight skip, logger guards, and connection/pool cleanup all carry over. The differences are the CV switch, module paths, application name/function label, and removal of CT-only rules and partition warning. The root `index.js` hook remains out of scope for this step.
- Findings runs on every stage invocation update one `ge_cv_findings` job-state row and merge the two systems' `as_of_by_system` entries. That map remains bounded to the fixed set of systems; unchanged findings are not rewritten. I see no material 30-minute write risk.
- The rehearsal's CT fingerprint comparison can observe a concurrent CT commit under READ COMMITTED. Avoiding the scheduled :18/:48 CT windows is sufficient for the expected scheduled run, given the rehearsal's measured ~13 seconds, but it does not protect against a delayed or manually started CT run. If the assertion must be race-proof, use a stable snapshot or coordinate with the CT stage; otherwise the documented scheduling constraint is reasonable.
- The stages use distinct advisory locks but only contend on disjoint CV/CT rows in shared tables. Their normal `INSERT ... ON CONFLICT` and update paths have no evident row-lock cycle or lock wait between stages.
- The rehearsal uses a single outer transaction and the stage's nested transactions become savepoints. Its checks cover the intended CV content, CT-scoped fingerprints, and watermarks before/after rollback. The `CT_SQL` comparison is the concurrency-sensitive part described above.

## Verification

Passed: `node insight/cv/test/stage.test.js` (25 tests). I did not run the CLI or any database/migration command; the handoff says the checkout's `.env` points at production.
