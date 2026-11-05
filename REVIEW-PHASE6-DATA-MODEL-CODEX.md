# Code review — Phase 6 step 2 (viewer data and model)

### F1 — `as_of` is not applied to tube segments or findings
- Severity: medium
- Confidence: confirmed
- Location: `sme_reports/ct/model.js:98-99`
- What's wrong: `index_system` filters day-based data, exams, and boots at `T`, but copies every tube segment and finding from the snapshot unchanged. `current_tube` then selects the segment marked current in today's snapshot, while `open_findings` and the per-system payload use today's finding status and full finding list. Those values can be from after the requested `as_of` date, contrary to the model's documented rule that later device-day data is ignored.
- Failure scenario: a report is built as of a date before a tube replacement or finding was created/resolved. The day series stops at the requested date, but the header can show the later tube and the fleet rank and system view can show findings from the future (or omit a finding that was open on the requested date).
- Evidence: code inspection. `index_system` filters days, daily rows, exams, and boots at lines 83–97 but not `tube` or `findings`; `current_tube` and `open_findings` consume those unfiltered arrays at lines 177–195. No probe or test was run.
- Suggested fix: apply the cutoff consistently to time-bearing records and derive the tube and finding state as of the cutoff. For a finding resolved after the cutoff, preserve its as-of open state rather than simply dropping it. Alternatively, if historical as-of output is not supported, constrain and document the model's input contract accordingly.

### F2 — CT findings are not restricted to the `ge_ct` source
- Severity: low
- Confidence: likely
- Location: `sme_reports/ct/data.js:36-38`
- What's wrong: this query reads findings from `api.ge_ct_findings_v` without selecting or filtering `source`. The view exposes all rows in `insight.findings`, and the schema explicitly allows other sources (`MRI/CV later`). `index_system` therefore treats any source's rows as GE CT findings when it builds the open counts and per-system findings list.
- Failure scenario: another source writes a finding for a system ID also present in the CT summary. The CT report displays and ranks that finding as a GE CT issue, potentially changing its attention order and severity counts.
- Evidence: code inspection of the query, `migrations/005_phase4_findings.sql:41-62` (the view has no source filter), and `migrations/001_insight_schema.sql:245` (source is extensible). No probe or test was run; the handoff's current-data results do not establish behavior when another source is present.
- Suggested fix: restrict the query to `source = 'ge_ct'` (the view exposes `source`) or carry `source` through and filter it in the model.
