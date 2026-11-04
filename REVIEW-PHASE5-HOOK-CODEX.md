# Code review: Phase 5 ge_ct hook

### F1 — A logger failure in the hook fallback can prevent the run log from being written

- Severity: medium
- Confidence: confirmed
- Location: `index.js:95-101,105-112`
- What's wrong: The hook's inner catch awaits `addLogEvent` without guarding it. If that call rejects, control enters `on_boot()`'s outer catch, which also awaits `addLogEvent` before calling `writeLogEvents`. A persistent logger failure therefore escapes the hook's promised best-effort behavior and skips the run-log write. `on_boot()` is invoked without a top-level rejection handler (`index.js:115`), so the rejection can also become unhandled.
- Failure scenario: `require("./insight")` fails, or `run_ct_insight` unexpectedly rejects, while `addLogEvent` is failing (for example, its backing logger/database is unavailable). The inner fallback log throws; the outer error logger throws again; `writeLogEvents(run_log)` is never reached.
- Evidence: Read the new hook catch and the existing outer catch/write order in `index.js:95-112`, plus the bare `on_boot()` call at line 115. No harness or database connection run.
- Suggested fix: Make the new hook catch best-effort around its `addLogEvent` call, then allow execution to continue to `writeLogEvents`. Consider protecting the outer error logger similarly so a logging outage cannot suppress the final log write.

### F2 — Per-query timeouts do not bound the hook's total wait

- Severity: low
- Confidence: possible
- Location: `insight/index.js:57-59,76`; `insight/stage.js:65-73`
- What's wrong: The hook applies connection, statement, and client query timeouts, but awaits the entire stage with no overall deadline. The stage processes systems and their queries sequentially; many individually successful queries can each take close to the configured 120/135 seconds. The per-query backstop therefore does not establish the handoff's stated short upper bound for how long `on_boot()` waits before it writes the run log.
- Failure scenario: Under sustained database degradation, a sequence of queries across systems remains just below its timeout. The stage continues through them, holding the `ge_ct` process at the hook for many timeout periods, potentially well beyond the normal 30-minute run interval.
- Evidence: Read the awaited `run_stage` call in `insight/index.js:76`, the per-step loop in `stage.js:65-73`, and the per-system loops in the derive/findings cores. Timeout settings bound individual statements, not the aggregate stage duration. No timing probe or database connection run.
- Suggested fix: Add and enforce a stage-wide deadline that cancels active queries and closes the pool when exceeded, or document and measure a defensible maximum aggregate duration from the number of queries and their limits.
