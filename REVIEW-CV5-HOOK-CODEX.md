# CV-5 step 3 review: the `index.js` hook

*Codex's report as relayed by the user on 2026-11-12. The handoff told the
reviewer both to write this file and to modify no files, so the reviewer
reported only. Recorded here verbatim in substance.*

## Findings

No hook-specific findings.

## Review notes

- The switch-off path loads the lightweight `insight/cv/index.js`
  wrapper, but not the stage or DB modules, and it opens no connection.
- With the switch on, the hook runs after ingest and before
  `writeLogEvents`. Its outer catch keeps the log write if loading or
  running the wrapper fails.

## Verification

- The CV isolation test passed (17 tests), and both `node --check`
  commands passed.
- The DB-free harness confirmed unchanged ingest traces and unchanged
  CT/MRI scenarios. Its directory (`~/cv_d3b_evidence/cv5`) was
  read-only for the reviewer, so it reran a copy under `/tmp`.
- No database commands were run.
