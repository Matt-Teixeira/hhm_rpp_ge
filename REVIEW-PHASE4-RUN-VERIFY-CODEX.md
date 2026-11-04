# Code review: Phase 4 findings write path and verification

### F1 — Missing safe-state codes are counted as one shared code

- Severity: medium
- Confidence: likely
- Location: `insight/findings/context.js:141-144`
- What's wrong: A safe-state fact with no `ermes` code is converted to the empty string and retained in `ctx.safe`. The rule groups incidents by `s.code`, so all missing-code safe states are treated as incidents of the same code. The independent SQL repeats this by `coalesce(... ->> 'ermes', '')`, so verification will agree with the false grouping. The agreed rule requires the same safe-state code; a missing code does not establish that.
- Failure scenario: Three or more distinct unclassified safe-state incidents within seven days can open `safe_state_recurrent` even when they may have different causes. This could create a customer-visible finding without evidence of a repeated code.
- Evidence: Read `insight/rules/ge_ct.js:17,212-214`: `num()` returns null for a missing value, and the extractor emits a safe-state fact regardless. Read `context.js:141-151` and `verify_sql.js:94-107`: null becomes `""` and incidents are grouped by it on both sides. No database query or probe run.
- Suggested fix: Exclude safe-state events with a missing/blank code from the same-code rule, or treat each unclassified event independently. Keep a separate count of unclassified events in evidence if useful, and apply the same rule in SQL.

### F2 — Verification uses the previous fleet date after a subset apply

- Severity: medium
- Confidence: confirmed
- Location: `insight/cli.js:297-300`
- What's wrong: `verify-findings` takes its as-of date from `job_state.last_run_stats.today`. A `findings --apply --system/--systems` run intentionally does not update that fleet-wide job row (`insight/findings/run.js:242-243`), while it does reconcile selected systems using the current UTC date. After such a run, verification can compare those newly updated rows against SQL evaluated at an older fleet date.
- Failure scenario: A fleet run records yesterday as `today`; a selected-system apply today incorporates a new fact or trip. `verify-findings` still re-derives yesterday's expected rows, so it reports a mismatch for a valid current row. The printed date is accurate for the old fleet run but doesn't account for the newer subset apply.
- Evidence: Read the selected-run guard around `write_job` in `insight/findings/run.js:242-243` and the verifier's date selection in `insight/cli.js:297-300`. No database query or probe run.
- Suggested fix: Track the as-of date for each system that is updated, or make `verify-findings` reject/require an explicit date when a selected-system apply has happened since the last fleet-wide run. A full fleet run before verification is another safe operational constraint, but the CLI should state and enforce it.

### F3 — The report can omit findings while presenting itself as a replay

- Severity: low
- Confidence: confirmed
- Location: `insight/cli.js:100-101, 278-281`
- What's wrong: `--report` is accepted for a default rehearsal without `--replay`, and it is also accepted with `--system` / `--systems`. The report is generated from `p1.results[].rows`; default-mode stale systems return before replay with `rows: []` (`insight/findings/run.js:111-114`). The report header only says “Findings replay as of …” and does not show selected systems or skipped stale systems (`insight/findings/report.js:19-22`). A report can therefore look like the full replay list while omitting findings.
- Failure scenario: A fleet rehearsal with `--report` but no `--replay` skips stale systems, and the generated report silently excludes their findings. A subset rehearsal similarly produces a partial list with no scope marker. If this file is used for the agreed evidence review, the review can be incomplete.
- Evidence: Read the CLI option validation and report write path cited above, plus the stale return in `run.js:112` and report heading in `report.js:19-22`. No database query or probe run.
- Suggested fix: Require `--replay` when `--report` is requested, and include the selected scope in the report header. If partial reports are intended, list skipped systems and label the output as partial.
