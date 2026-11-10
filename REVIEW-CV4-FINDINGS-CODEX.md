# Review: CV-4 findings

## Findings

### P2 — A missing initial derive can pass preflight and produce a false green run

`preflight()` treats a missing `ge_cv_derive` job-state row as caught up: `d` is null, so neither the pending-day nor owed-label check fires (`insight/cv/findings/run.js:106-110`). The run then enumerates systems from `ge_cv_daily` only (`:85`). If CV facts were extracted but the initial derive was skipped or its state row was lost, `findings --rehearse --replay` sees no systems, and `verify-findings` also derives its expected data days from `ge_cv_daily` (`insight/cv/findings/verify_sql.js:24-32`). The rehearsal can therefore report success without evaluating the fact-bearing system; apply can likewise write the catalog and job state while producing no findings.

Require evidence that the initial derive completed successfully before allowing findings runs, or fail closed when CV facts exist without matching daily data. The verifier/system inventory should also be able to expose a facts-only system rather than using the derived table as its only inventory. This is a rollout/interlock gap; when derive has completed and its pending markers are maintained, the facts-based JS days and daily-based SQL days agree by construction because each counted fact has a `cv.error` fact.

## Reviewed paths

- The JS and SQL windows agree: recent windows are D−6..D and D−27..D; baselines use data days in D−28..D−1 and require seven. `percentile_cont(0.5)` gives the same midpoint as the JS median for an even sample, and both implementations omit missing calendar days from baseline samples. The SQL `RANGE` windows span calendar days, matching the JS date bounds even when data days are gapped.
- Both sides choose the latest qualifying storm/burst day in the seven-day window for `observed` and `baseline`. The SQL trip-day islands split when the next trip is more than 14 evaluated days later, matching the fold’s resolution on the 14th quiet evaluated day.
- The residual is exact for the current CV-2 classifier: every counted row emits one `cv.error` and at most one named metric (`insight/cv/rules.js`, `MAX_FACTS_PER_ROW`). The subtraction in `context.js` and `verify_sql.js` is therefore consistent. A future named metric must preserve that invariant or explicitly adjust residual construction; otherwise subtraction could underflow or lose meaning.
- The current thresholds, baseline/no-baseline branch, severity rules, and evidence fields match the handoff’s F1–F6 decisions. Evidence contains codes, dimensions, and counts rather than source debug text.
- The reused CT fold does not branch on `source`; `as_cv_rows()` enforces the `cv_` key prefix and changes the fold’s hard-coded `ge_ct` source to `ge_cv`. CV reads, writes, deletes, fingerprints, and finding verification are source-scoped; catalog handling is `cv\_%`-scoped. The JS string escaping produces SQL `LIKE 'cv\_%'`, where `_` is literal. CT reconciliation remains `source = 'ge_ct'`, and CT catalog sync only reports unknown keys.
- The shared default reconciliation, final-resolved cutoff, conditional upsert, and replay behavior are reused without changing CT code. Job state uses the separate `ge_cv_findings` name. Migration 008 recreates only `api.ge_ct_findings_v` with the 005 columns and source filter; its down definition restores 005. The handoff reports a read-only production check found no grants or dependants, which supports the drop/recreate approach. The CT viewer’s existing source filter remains compatible.

## Verification

Static code and diff review only. I did not run tests, the CV CLI, or migrations. The handoff reports passing tests and local PostgreSQL rehearsal; I did not independently reproduce those checks.
