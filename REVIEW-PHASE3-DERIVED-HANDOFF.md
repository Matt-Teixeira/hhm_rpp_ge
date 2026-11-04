# Review handoff: Phase 3 checkpoint 2 (derived-fact rules)

Repo: `hhm_rpp_ge`, branch `dev`. The change is **uncommitted** in the
working tree, on top of `61fdfe1`. Nothing has been written to the
database: these rules haven't run against it except read-only.

## What to review

```
git status --short    # 1 modified, 5 new paths
git diff              # insight/cli.js
```

| File | What |
|---|---|
| `insight/rules/ge_ct_derived.js` | new: the two derived rules (pure; no DB, no clock) |
| `insight/derive/verify_sql.js` | new: independent SQL for the same rules |
| `insight/tools/build_derived_fixtures.js` | new: builds fixtures from prod facts (read-only) |
| `insight/rules/__fixtures__/ge_ct_derived/{tube,boots}.json` | new: generated fixtures (data; skim only) |
| `insight/test/derived.test.js` | new: 12 tests |
| `insight/cli.js` | `verify` excludes derived metrics and allows for their catalog rows |

Background: `PLAN-CT-INSIGHTS.md` §13.1 (evidence, including the
tube-reset table), §13.2 items 1 and 4 (the agreed rules), and §13.3
(exit criteria). Read these first; the rules must implement them. For
context, `insight/rules/engine.js` and `insight/load.js` hold the Phase 2
per-row engine and write path. This module is deliberately separate from
them.

## The rules (as agreed; §13.2)

**`system.boot`.** Derived from a `system.sw_init_complete` fact that has:
- no `process.restart` in the 5 minutes before it, inclusive;
- at least 10 minutes since the previous init of any kind.

It is `clean` if a `system.shutdown` happened in (previous boot, this
init], otherwise `unclean`. It is keyed on the init record.

**`tube.replacement`.** Derived from a `tube.mas_total` reading below 50%
of the previous reading, where the previous reading is above 100,000. The
counter must stay low: at least 2 later readings exist, and the next (up
to) 3 are all below 50% of the previous reading. With fewer later readings
the reset is "pending" and not emitted. It is keyed on the reset reading.
- **Confidence:** `confirmed` if there are at least 3 `service.calibration`
  facts in [reset − 7 d, reset + 1 d], inclusive; else `counter_only`.
- **`install_date`:** the date of the first calibration in that window,
  else the reset reading's date. Both come from the device wall clock
  (`host_local`), not UTC.
- **Tube source,** from `tube.identity`, over [reset, min(reset + 30 d,
  next reset)):
  - the more frequent of `verified` / `unrecognized`;
  - an exact tie goes to whichever was seen first;
  - `no_smart_id` only when neither appears (it is a companion line
    logged at every boot);
  - else null.

Derived output per system is meant to be complete. Checkpoint 3, not built
yet, will replace a system's derived facts with it.

## Already verified (by the author)

- **Tube replacements, from the fixtures of real facts:** the
  `derived.test.js` §13.1 test reproduces the table exactly: 7
  `confirmed`, 1 `counter_only` (SME21873 2025-09-02), with the same
  calibration counts and old mA·s values. There are none on the control
  system SME21859.
- **Read-only, fleet-wide, all history:** the JS rules and
  `verify_sql.js` agree exactly. 3,385 boots, with the same clean/unclean
  on every one, and 8 resets with the same calibration counts. Zero
  differences.
- **`node insight/cli.js verify` (read-only):** 621/621 cells equal; 37
  catalog rows.
- **All test files pass:** `insight/test/*.test.js`, `test/*.test.js`,
  `migrations/test/sqlscan.test.js`.

## Where to look hardest

1. **Fidelity to §13.2.** Does each rule implement the agreed text? Check
   boundary inclusivity, "previous init" vs "previous boot", and the
   window ends.
   - The "stays low" test (≥ 2 later readings, next 3 all low) is an
     implementation choice; the plan says only "stays low".
   - Is the "pending" behaviour sound for an incremental run, where a
     reset is the newest reading?
2. **Is `verify_sql.js` really independent of the JS?** It is meant to
   check the JS, not transcribe it.
   - Do they share a blind spot? Ordering ties: both sort by
     (`host_datetime`, `epoch`, `record_number_concurrent`). Facts of
     different metrics in the same second.
   - Do they differ in a way the fleet comparison wouldn't reveal on
     today's data? Null and non-finite counter values: the SQL filters
     `value_num IS NOT NULL`, the JS filters non-finite. PostgreSQL
     `double precision` can store `NaN`.
3. **Time handling.**
   - Windows use absolute `host_datetime`; `install_date` uses the device
     wall clock (`host_local`, passed as text; a non-text value now
     throws).
   - Any place where the process time zone, DST, or a `Date` vs string
     mix-up could shift a result?
4. **Fixture boot windows.** The builder takes each window plus a context
   margin before it. The expected boots come from SQL over **all** facts.
   - Can the margin make the JS (which sees only the slice) legitimately
     disagree for the first boot(s) in a window?
   - If so, is the test fragile, or does it hide a real difference?
5. **Tube source.** Window bounds, tie-break, and the precedence of
   `no_smart_id`.
6. **`cli.js verify` change.**
   - The derived keys are excluded from per-row reconciliation.
   - Expected catalog rows = 37, or 37 + 2 once any derived row exists.
     A state with only one derived row present would pass on neither
     count. Is that the intended failure?
7. **Robustness.** Anything that throws on real-world input (missing
   attrs, empty systems, a system with readings but no calibrations) or
   is quadratic on large systems. SME18531 has about 38k inits in two
   days; the boot scan uses a two-pointer for restarts but `.some()` for
   shutdowns.

Out of scope: the decisions in plan §9, §12 and §13.2, and the user's
2026-11-04 tube-source rule, are settled. Raise a concern only if the
code contradicts them or the data clearly breaks them.

## Ground rules (this machine is also the production server)

- **Don't run anything that connects to the database.** That includes
  `insight/tools/build_derived_fixtures.js`, `insight/cli.js` (all
  commands) and `migrations/run.js` except `scan`. The DB results are
  summarised above.
- DB-free commands are fine: `node insight/test/derived.test.js` and the
  other test files.
- Don't open or print `.env`.
- Don't modify files. Report only.
- Don't touch `/home/prod/hhm_rpp_ge`.

## How to report

Write findings to `REVIEW-PHASE3-DERIVED-CODEX.md` in the repo root, in
the format of `REVIEW-CT-INSIGHTS-CODEX.md`: one `### F<n> — title`
section per finding, each with:
- Severity: high / medium / low
- Confidence: confirmed / likely / possible
- Location: `file:line`
- What's wrong
- Failure scenario
- Evidence (say whether you ran a probe or read the code)
- Suggested fix

Order findings most severe first. If you find nothing, say so explicitly.
