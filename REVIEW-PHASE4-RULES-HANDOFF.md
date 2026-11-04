# Review handoff: Phase 4 step 3 (findings rules, state machine, verify SQL)

Repo: `hhm_rpp_ge`, branch `dev`. The change is **uncommitted** in the
working tree, on top of `7b96535`. Nothing in it writes to the database
yet: the write path (`cli.js findings`, `verify-findings`) is step 4 and
not built.

## What to review

```
git status --short
cat insight/findings/*.js insight/tools/build_findings_fixtures.js insight/test/findings.test.js
git diff migrations/test/sqlscan.test.js
cat migrations/005_phase4_findings.sql migrations/005_phase4_findings.down.sql
```

| File | What |
|---|---|
| `insight/findings/rules.js` | registry: rules 1-10 as 13 finding keys, pure `evaluate(ctx, D)`; catalog rows |
| `insight/findings/context.js` | per-system inputs as dense day arrays (prefix sums), exclusions for rules 4 and 9 |
| `insight/findings/state.js` | open/resolve state machine (a fold over data days), replay of one system |
| `insight/findings/load.js` | reads one system's inputs (read-only SQL) |
| `insight/findings/verify_sql.js` | independent SQL that re-derives every finding |
| `insight/findings/verify.js` | compares stored (or given) findings with that SQL; catalog and invariant checks |
| `insight/tools/build_findings_fixtures.js` | builds the fixtures from prod (read-only) |
| `insight/rules/__fixtures__/findings/` | `inputs.json` (13 systems), `expected.json` (76 findings from the SQL) |
| `insight/test/findings.test.js` | 22 tests, no DB |
| `migrations/005_phase4_findings*.sql` | **already applied** by the owner 2026-11-04 14:43 UTC (checksummed; must not change). Comment only |
| `migrations/test/sqlscan.test.js` | one new test for 005 |

Background: `PLAN-CT-INSIGHTS.md` §14.1 (evidence), §14.2 (agreed rules
and design), §14.4 (exit criteria), §13.5 (Phase 3 patterns), §10
(safeguards). The rules and thresholds in §14.2 are **settled**: raise a
concern only where the code contradicts them, or where the code's reading
of an ambiguous phrase is unsafe.

## What the code does

**Evaluation model (§14.2 items 1-3).**
- A rule is a pure function of (system, as-of device day D). Windows are
  device days: 7 d = D-6..D. Device day = date of `host_local`.
- Evaluated days are the system's **data days** (days with any fact) up to
  `today`. Data on later device days (a clock running ahead) is ignored.
- State machine, per (system, finding_key), day by day: a trip with nothing
  open opens a finding; a trip while open extends it (severity = max, never
  falls); a non-trip day `quiet_days` evaluated days after the last trip
  resolves it (14; 7 for `process_restart_loop`). A later trip opens a new
  row.
- `tube_replaced` is event-driven: one finding per `tube.replacement` fact,
  opened on its install date, resolved on the first data day >= install +
  30, or at the next replacement's install day if sooner.
- Times: `opened_at` / `resolved_at` = the instant of the device day's
  local midnight (clock offset of the day's first fact; offsets are whole
  hours on every system). `window_start/end` bound the last trip's window.
  `last_evaluated` = newest fact on `data_through`. Nothing depends on the
  run's wall-clock time, so replay is idempotent.
- Planned for step 4 (not in this change): every run replays each system
  from history and reconciles the table; without `--replay` only systems
  with data in the last 7 days are evaluated and resolved rows are never
  rewritten (drift is reported).

**Rules** (`rules.js`): `tube_rotor_instability` (sustained high / spike
medium), `process_restart_loop`, `abort_rate_high` (chronic / spike),
`safe_state_recurrent`, `prep_noncompliance`, `tube_replaced`,
`env_plenum`, `env_detector_temp`, `env_humidity`, `env_psu`,
`warmup_bypass_habit`, `powered_off_without_shutdown`,
`air_calibration_overdue`. Thresholds are in each rule's `thresholds` and
the file header.

Readings of ambiguous §14.2 phrases (the author's choices):
- Rule 1: "weeks" are rolling 7-day blocks ending at D; the 8-week median
  uses only prior weeks that contain a data day and needs >= 4 of them.
- Rule 3: spike needs baseline exams > 0; thresholds compared in integers.
- Rule 4: "within 30 min of a boot or shutdown" = either side.
- Rule 5: only `Fast Calibration` and `Cold Tube Warmup (Fast
  Calibration)` count (not `GSI Fast Calibration`).
- Rule 8: capability = the system logged a bypass metric on or before D;
  no minimum scan days.
- Rule 9: service mode `enter` in [boot - 12 h, boot).

## Already verified by the author (read-only against prod)

- JS replay of all 34 systems (as of 2026-11-04): 134 findings, in 4 s.
- `FINDINGS_SQL` over the same data: 134 findings; `compare_findings`:
  0 missing, 0 extra, 0 differ; invariants clean. Same result as of
  2026-09-15 (116), 2026-06-10 (70) and 2025-10-01 (8).
- History stability: every finding resolved as of an earlier day reappears
  byte-identical in the later replay; no open finding disappears.
- The three §14.4 named problems appear (SME21859 rotor high, SME18531
  restart loop 09-12, SME21867 chronic aborts).
- Comparator sensitivity: planted changes to severity, observed,
  resolved_at, trip_days and a dropped row are each detected.
- Tests: `insight/test/findings.test.js` 22/22; `insight/test/*.test.js`,
  `test/*.test.js`, `migrations/test/sqlscan.test.js` (14) all pass.

## Where to look hardest

1. **Independence of the SQL.** Both sides were written by the same author
   from the same reading of §14.2. Where could they agree and both be
   wrong (window edges, the D-62..D-7 baseline, the rotor week lags and
   "weeks with data", the median, rounding, the island boundary `i - prev_i
   > q` vs the fold's `i - last_i >= quiet_days`)? Where do they read
   different sources (data days: JS from facts, SQL from `ge_ct_daily`)
   and could that diverge on real data?
2. **State machine edge cases** (`state.js`): resolution exactly on the
   quiet boundary, a trip on the day it would resolve, the last data day,
   `tube_replaced` replacements closer than 30 days, an install date that
   isn't a data day (`day_start` falls back to the nearest data day's
   offset), a system with one data day.
3. **As-of purity.** Is anything in `context.js` a function of data after
   `today`? (Boots/shutdowns and service-mode entries are not filtered by
   `today` in either JS or SQL, by design: they only exclude events near
   them. Is that a real leak?)
4. **Timestamps.** `day_start` and the SQL's `array_agg(... ORDER BY
   host_local, host_datetime)[1]`: DST days, a clock jump within a day, a
   day whose first fact is a derived fact. `shift()` adds 24 h multiples,
   SQL uses `interval '24 hours'` (not `'1 day'`), so a session time zone
   with DST can't change the result. Correct?
5. **Rule logic vs §14.2 text**, rule by rule (especially rule 1's
   sustained/spike combination, rule 3's chronic/spike `observed` and
   `from`, rule 4's per-code count, rule 7's family split and the exclusion
   of `env.plenum_recovered`).
6. **Evidence content.** `safe_state_recurrent` evidence carries the first
   120 characters of the safe-state message (fixed GE text such as
   "Emergency Off button has been pressed"). Customers see findings (§7);
   raw log text is supposed to stay internal. Is this a problem, or is a
   fixed vendor message fine?
7. **Fixtures:** expected findings come from the SQL over all data, inputs
   from `load.js`. Does `compact`/`expand` lose anything a rule reads (the
   prep filter keeps only Fast Cal steps; safe-state messages dropped)?
8. **Migration 005 (applied, comment only):** the `findings_finding_key_fkey`
   FK, `data_through date NOT NULL`, the view join (inner join to the
   catalog: a finding whose key is missing from the catalog can't exist
   because of the FK).
9. **Cost:** `FINDINGS_SQL` sorts all facts (2.17M rows) and runs two
   correlated `NOT EXISTS` probes; ~4 s now. Anything that grows badly?
   `load.js` issues 4 queries with `Promise.all` on one task/transaction
   connection: safe with pg-promise?

## Ground rules (this machine is also the production server)

- **Don't run anything that connects to the database.** That means
  `migrations/run.js status|up|down|roundtrip`, anything under
  `insight/cli.js`, and `insight/tools/build_findings_fixtures.js`.
- DB-free commands are fine: `node migrations/run.js scan`, the test files,
  and ad-hoc `node -e` probes that only `require` the pure modules
  (`insight/findings/context.js`, `rules.js`, `state.js`, `verify.js`'s
  `compare_findings`) over the fixtures.
- Don't open or print `.env`.
- Don't modify files. Report only.
- Don't touch `/home/prod/hhm_rpp_ge`.

## How to report

Write findings to `REVIEW-PHASE4-RULES-CODEX.md` in the repo root, in the
same format as `REVIEW-CT-INSIGHTS-CODEX.md`: one `### F<n> — title`
section per finding, each with:
- Severity: high / medium / low
- Confidence: confirmed / likely / possible
- Location: `file:line`
- What's wrong
- Failure scenario
- Evidence (say whether you ran a probe or read the code)
- Suggested fix

Order findings most severe first. If you find nothing, say so explicitly.
