# CV-5 step 1 review: lock-free cores

## Findings

- **P3 — Findings apply no longer logs its aggregate run summary.** In the old apply body, `pass()` logged the aggregate totals after processing the selected systems, including evaluated and stale counts, and emitted drift details. The extracted `findings_step` logs one line per evaluated system and returns totals/drift in its result, but neither `run_findings` nor the stage wrapper logs that returned aggregate or the drift details. This changes the manual CLI's operator output and hides skipped-stale counts and the final fleet total. Consider logging the aggregate and drift details from the caller, or preserve the prior summary in the core. See [insight/cv/findings/run.js](insight/cv/findings/run.js:287).

## Review notes

- The extract apply body preserves catalog sync, late re-read, per-batch transaction boundaries, commit-gated stats/watermarks, and error recording. `extract_step` deliberately requires the backfill-created watermark; `run_extract` retains its existing no-watermark start-at-zero behavior. This split is sound.
- Derive reads the extract watermark under the shared lock and writes it only after all pending/full work and code rebuilding succeed. On a caught error it preserves the previous watermark. A process interruption before the final job-state transaction can leave the watermark behind, not ahead.
- Fleet-wide findings reads the derive watermark under the shared lock and writes it only on success. A selected-system run does not write fleet job state. A failure after some per-system commits preserves the previous watermark. The default mode still intentionally skips stale systems according to its existing rules.
- The reviewed-code addition is documented as `cv.error`-only and is pinned by the unit test. I did not independently validate the cited production rows; the handoff prohibits production-targeting commands.
- I found no other correctness change in the three apply bodies beyond extraction into cores and the stated watermark writes.

## Verification

Passed: `node insight/cv/test/stage.test.js`, `node insight/cv/test/cv.test.js`, `node insight/cv/test/derive.test.js`, and `node insight/cv/test/findings.test.js` (25, 16, 9, and 18 tests respectively). No CLI, database, or migration commands were run.
