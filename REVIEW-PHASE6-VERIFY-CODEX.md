# Code review — Phase 6 step 3 (independent verification)

### F1 — Historical `--as-of` state is verified against current tube/findings
- Severity: medium
- Confidence: confirmed
- Location: `sme_reports/ct/verify.js:110-120,245-253`
- What's wrong: the SQL verification compares the model's unfiltered current tube segment and current finding status against SQL that also selects the current segment and current finding rows without an `as_of` cutoff. The model filters day-based rows at the cutoff, but neither side reconstructs tube or finding state as of that date. The check can therefore pass while the model output includes state from after `--as-of`.
- Failure scenario: run `verify.js --as-of` for a date before a tube replacement or finding was created/resolved. The model and independent SQL both use the snapshot's later current tube/finding state, compare equal, and report success even though the historical report contains future state.
- Evidence: code inspection. `FLEET_SQL.cur` uses `WHERE is_current` and its open-finding aggregate has no date condition; `PANEL_SQL.segments` and `PANEL_SQL.findings` read the snapshot's full rows. The `as_of` value is only applied to daily date windows in these queries. No probe or test was run.
- Suggested fix: either restrict verification to the latest snapshot day and reject earlier `--as-of` values for these fields, or independently derive tube and finding state at the requested cutoff on both sides. For findings resolved after the cutoff, the expected state must reflect that they were still open then.

### F2 — Most finding evidence values are outside the verification comparison
- Severity: low
- Confidence: confirmed
- Location: `sme_reports/ct/verify.js:245-253,379-386,408-436`
- What's wrong: the panel SQL selects only finding key, status, severity, and opened time, and `check_panels` compares only those fields and their order. The rule check independently recomputes only the first/last trip-day evidence for `abort_rate_high` and `prep_noncompliance`. Other displayed finding values—such as observed/baseline values, windows, and evidence counts or codes—are not compared by this verifier.
- Failure scenario: a loader or payload change drops or mis-maps a finding's displayed evidence field, or a stored evidence value for another finding is wrong; the verification still reports zero differences because neither the panel comparison nor `check_rules` covers that field/type.
- Evidence: code inspection of the selected columns and comparison tuples. No probe or test was run.
- Suggested fix: include the viewer-visible finding fields in the panel comparison against independently selected API-view values; where the values represent computed rule evidence, add independent recomputations for the remaining finding types or clearly limit the verification claim to the fields it checks.
