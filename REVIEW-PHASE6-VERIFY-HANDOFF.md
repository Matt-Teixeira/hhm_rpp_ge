# Review handoff: Phase 6 step 3 (`ct/verify.js`, independent numbers check)

The code is in the **reports** repo (`~/hep3/reports`, branch `DEV`):

| File | State | What |
|---|---|---|
| `sme_reports/ct/verify.js` | new, untracked | The independent check (plan §16.4, "Numbers are verified, not eyeballed") |
| `sme_reports/ct/data.js` | modified | Split: `read_ct(t, opts)` reads inside a given transaction; `load_ct` wraps it in the read-only REPEATABLE READ tx as before. Exports `TX_MODE` |
| `sme_reports/ct/model.js` | modified | Exports `EVENT_SERIES` and `GAUGE_VALUES` (display lists the check needs). No logic change |

```
cd ~/hep3/reports
git diff sme_reports/ct/data.js sme_reports/ct/model.js
```

Step 2 (data and model) is committed at reports `6f4f46e`; its review is
`REVIEW-PHASE6-DATA-MODEL-*.md`. **The reports repo has 5 other untracked
paths** (`AvanteConnected-NewMarketing.*`, `sme21284.html`) that aren't
part of this change. Don't open, modify, stage or revert them.

Background: `PLAN-CT-INSIGHTS.md` §16.4 (exit criteria) and §16.5 step 3;
step 2 handoff for the column definitions.

## What the check does

One read-only REPEATABLE READ transaction (the session also has
`default_transaction_read_only=on`; `run_checks` refuses unless
`transaction_read_only = on` and isolation is `repeatable read`). Inside
it:

1. `read_ct` + `build_model` (the same path the viewer will use), as of the
   snapshot's UTC day by default (`--as-of`).
2. Its own SQL over the `api.ge_ct_*` views, same snapshot, compared value
   by value with the model:

| Check | Scope | What the SQL recomputes |
|---|---|---|
| fleet columns | every system (34) | group, last day / last_at, exams/day (numerator, data days, rounded), mA·s/day (LAG increments, drop = 0), abort 28 d, prep 14 d, open findings by severity / attention / max severity, current tube (incl. "since data start" day), clock flag/offset, identity |
| fleet order | both lists | attention order and not-reporting order, via `row_number()` |
| inventory | fleet | GE CT + PET/CT systems not in the summary view |
| panels | `--systems` (default SME21859, SME18531, SME21867) | every per-day series in the payload (events, exams rows/series/images, error total and per code, restarts per process, boots clean/unclean, prep masks, data mask); the total of each per period (30 d / 90 d / 6 mo / all), summed from the payload arrays vs SQL sums; heatmap (168 cells × 4 periods); error top 10 + other + total per period; gauges per day (min/max/mean); tube counter and per-day increments; panel list, labels, segments, findings order |
| rules | every `abort_rate_high` / `prep_noncompliance` finding, fleet-wide | at the evidence `first` and `last` trip days: SQL value = stored evidence, and model function = SQL |

Exit 0 on zero differences, 1 otherwise (2 on error).

Choices to look at:
- Sums of `double precision` values (the tube counter increments) are taken
  in SQL with `sum(... ORDER BY local_day)`: the order the model adds them,
  so the float results are identical. Rounding of doubles to 3 decimals
  happens in `verify.js` with `Math.round` (the SQL returns the raw value);
  integer ratios are rounded in SQL `numeric`. Integer rounding of doubles
  uses `floor(x + 0.5)` (Postgres `round(float8)` rounds half to even).
- The SQL reads the same views as `data.js`. The check covers the model's
  computations and how `data.js` reads the views, not the views themselves
  (those were checked in Phases 2–5 and in the 006 equivalence probes).
- "Since data start" in SQL is `max(local_day)` with `local_midnight <=
  segment_start`; the model scans days in order and stops at the first
  midnight after the instant. They agree on today's data; they would
  differ only if `local_midnight` were not increasing with the day.

## Already verified (by the author)

Against prod, read-only, as of 2026-11-05 (snapshot 19:56:32Z):

```
fleet: 34 systems (28 reporting, 6 not reporting), inventory 88
panel systems: SME21859, SME18531, SME21867; rule trip days checked: 62

  fleet columns (every system)                             374 compared     0 diffs
  fleet order (attention; not reporting by last data)        2 compared     0 diffs
  inventory footer                                           1 compared     0 diffs
  panels: day range and data days                            9 compared     0 diffs
  panels: per-day event series                           17423 compared     0 diffs
  panels: period totals                                    196 compared     0 diffs
  panels: busy-hour heatmap per period                    2016 compared     0 diffs
  panels: error-code top 10 per period                      12 compared     0 diffs
  panels: gauges and tube counter                         1077 compared     0 diffs
  panels: panels, labels, segments, findings                21 compared     0 diffs
  rules: columns = rule evidence on trip days              124 compared     0 diffs

ALL CHECKS PASS: 0 differences in 21255 comparisons
(33.3 s)
```

**The check catches differences.** A mutation probe (scratchpad, not in the
repo) planted 15 errors in the built model, one per kind:
- a fleet abort rate, mA·s/day, tube "since" day;
- the not-reporting order and the inventory;
- an event day, a heatmap cell, an error top-10 "other";
- a gauge mean, a tube increment, the panel list;
- a prep mask day, an exam images day, an unclean boot day;
- a stored abort evidence count.

All 15 were reported. The other 14 differences were the period totals
containing the changed days, and nothing else. Model tests are still 13/13.

## Where to look hardest

1. **Independence.** Is any SQL value derived the way the model derives it
   in a way that would hide a shared mistake? For example the windows
   (D−29..D, D−27..D, D−13..D), the "drop = 0" increment rule, the reporting
   threshold, the attention order. Where the check uses a model export
   (`EVENT_SERIES`, `GAUGE_VALUES`, `PANELS`, `PERIODS`,
   `FAST_CAL_STEPS`, `WARMUP_STEPS`), is that list a display choice, or
   does it hide a computation?
2. **Coverage.** Is there a number the page will show (step 2 handoff,
   payload list) that no check compares? Period totals are compared for
   events, exams, errors, restarts, boots, tube increments, prep
   (scan / Fast Cal), data days; heatmap and error top 10 per period.
3. **False passes.** Comparison is `JSON.stringify` equality with
   `undefined → null`. Can a length mismatch or a missing key pass? (Per-day
   series compare `max(len)` elements.)
4. **SQL correctness.** The heatmap hour (`floor(extract(epoch …)/3600)`,
   clamped; ISO day of week − 1), error ranking ties (`n DESC, code COLLATE
   "C"`), the prep "without Fast Cal" `NOT EXISTS`, and LAG over all
   counter days up to `as_of`.
5. **Read-only.** Anything in `verify.js` or the `data.js` split that could
   write or hold a lock that matters.

## Ground rules (this machine is also the production server)

- **Don't run anything that connects to the database**: `verify.js`,
  `ct/tools/build_fixture.js`, anything requiring `ct/db.js`, anything in
  `hhm_rpp_ge` that connects.
- DB-free is fine: `node sme_reports/ct/test/model.test.js` (from
  `~/hep3/reports`).
- Don't open or print any `.env`.
- Don't modify files in either repo. Report only.
- Don't touch `/home/prod/hhm_rpp_ge`.

## How to report

Write findings to `hhm_rpp_ge/REVIEW-PHASE6-VERIFY-CODEX.md`, in the same
format as `REVIEW-PHASE6-DATA-MODEL-CODEX.md`: one `### F<n> — title`
section per finding, each with:
- Severity: high / medium / low
- Confidence: confirmed / likely / possible
- Location: `file:line`
- What's wrong
- Failure scenario
- Evidence (say whether you ran a probe or read the code)
- Suggested fix

Order findings most severe first. If you find nothing, say so explicitly.

## Fixes after review (2026-11-05)

- **F1 (historical `--as-of`): refused.** `run_checks` throws before the
  model is built when `--as-of` is earlier than the snapshot's UTC day
  (exit 2), the same contract as `build_model` (review PHASE6-DATA-MODEL
  F1). Tube segments and findings are current state, so a historical
  check would compare future state on both sides. Run against prod with
  `--as-of 2026-10-01`: refused, exit 2.
- **F2 (finding evidence): the page carries only checked values, and all
  of them are compared.**
  - `model.js` `finding_view` replaces the raw finding rows in each system
    payload with:
    - status, severity, opened/resolved, `data_through`, window, observed,
      baseline, opened day, last trip day and trip days. hhm_rpp_ge
      `cli.js verify-findings` recomputes these with independent SQL;
    - `trip`: the abort-rate / prep numbers on the first and last trip day,
      recomputed here by the rules check;
    - label, category, description, `customer_visible` (catalog text).

    The rest of the stored evidence (weekly rotor counts, code lists,
    boot times, ...) is recomputed nowhere, so it is no longer in the
    payload. The panels show the verified series behind it.
  - `verify.js` adds the check **findings shown (every system, every
    field)**: every finding of every system against `api.ge_ct_findings_v`
    read with its own SQL. That covers each field (evidence values
    extracted in SQL with `#>>`), the order, and no finding of a system
    not shown. It replaces the 3-system findings tuple in the panel check.
  - The comparison now uses JSON with sorted keys, so key order never
    matters and a missing or extra key always does.
- **Results.** Run again against prod, read-only: **0 differences in
  23,321 comparisons**, including 2,069 on 113 findings; 32.6 s.
  - Mutation probe: 18 planted errors, all caught. The 3 new ones are a
    finding's `observed`, an abort trip `per_100`, and a leaked
    `evidence` key. The other 14 differences were the period totals of the
    changed days, as before.
  - Model tests 14/14. New test: the payload's finding keys are exactly
    the checked set, and the trip numbers come from the evidence.
