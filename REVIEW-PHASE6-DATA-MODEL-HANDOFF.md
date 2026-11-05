# Review handoff: Phase 6 step 2 (viewer data and model)

The code is in the **reports** repo (`~/hep3/reports`, branch `DEV`), in
the new directory `sme_reports/ct/`. It is **untracked and uncommitted**.
This handoff and your findings file live in `hhm_rpp_ge`, next to the
plan.

**The reports repo has 45 other uncommitted paths** (in-progress work
that isn't part of this change). Don't open them for review, and don't
modify, stage or revert anything there.

## What to review

```
cd ~/hep3/reports
ls -R sme_reports/ct
```

| File | What |
|---|---|
| `sme_reports/ct/db.js` | Own read-only connection (same `PG_*` credentials as `utils/db/pg-pool`) |
| `sme_reports/ct/data.js` | `load_ct(db, { systems })`: all reads, one read-only REPEATABLE READ transaction |
| `sme_reports/ct/model.js` | Pure: `build_model(raw, { as_of })` → fleet rows, one payload per system |
| `sme_reports/ct/tools/build_fixture.js` | Builds the test fixture from prod, read-only |
| `sme_reports/ct/test/model.test.js` | 12 tests on the fixture |
| `sme_reports/ct/test/fixtures/ct_fixture.json.gz` | Fixture: 6 systems, last 240 device days to 2026-11-05, gzip (387 kB) |

Background: `hhm_rpp_ge/PLAN-CT-INSIGHTS.md` §16.2 (design, items 3–6),
§16.4 (exit criteria), §3 and §7. The rules these columns must agree
with: `hhm_rpp_ge/insight/findings/rules.js` (`abort_rate_high`,
`prep_noncompliance`) and `context.js` (series, `FAST_CAL_STEPS`).
Migration 006 (`api.ge_ct_days_v`, `api.ge_ct_capabilities_v`,
`api.ge_ct_boots_v`) was applied 2026-11-05 at `883bad7`. Steps 3–6
(independent verification, render/client, the real build, team review)
come later. There's no HTML yet.

## What the change does

**`db.js`**: a separate pg-promise instance. Every session has
`default_transaction_read_only=on`, `statement_timeout` 120 s and
`lock_timeout` 5 s. `open()` reads the setting back and refuses to return
a connection that isn't read-only.

**`data.js`** reads only:
- the `api.ge_ct_*` views;
- identity from `public.systems` → `sites` → `customers`;
- the inventory footer: GE systems with `modality IN ('CT','PET/CT')`
  that aren't in insight (88 today, matching plan §16.1).

All of it runs in one read-only REPEATABLE READ transaction, so the
datasets are a consistent snapshot while the `ge_ct` stage writes every
30 min. Every query has an `ORDER BY`. It doesn't select `exam_no` or
`protocol` (raw material, §7).

**`model.js`**: pure, with no DB and no clock. Data after `as_of` (a
device day) is ignored, as the rules do. Per system, with
D = its last data day:

| Column | Definition |
|---|---|
| group | *reporting* if D ≥ as_of − 6 (findings' 7-day window, `run.js` `STALE_DAYS`), else *not reporting* |
| exams/day | Σ `exam.start` n over D−29..D ÷ data days in D−29..D, 2 decimals |
| mA·s/day | Σ tube-counter increments over D−29..D ÷ the same data days. Increment = a reading day's `value_last` − the previous reading day's; a drop (replacement reset) counts 0 |
| abort rate (28 d) | `abort_rate_high` `d28`: 100 · Σ `scan.abort.system` ÷ Σ `exam.start` over D−27..D, the rule's `pct()` |
| prep (14 d) | `prep_noncompliance`: scan days (`exam.start` n > 0) in D−13..D without a `FAST_CAL_STEPS` dim of `prep.tube_temp` (n > 0); share = `pct()` |
| current tube | `ge_ct_tube_v` current segment; "since data start <day>" when `install_confidence = 'initial'` and no install date |
| open findings | by severity; `max_severity` and `attention` ignore `info` |

Attention order (reporting): highest open severity without `info`, then
open count without `info`, then exams/day, then system id. Not
reporting: most recent last data day first.

Per-system payload (`views[system_id]`):
- dense day arrays from the first data day to D, plus a data-day mask;
- event series only for metrics in capabilities;
- gauge min/max/mean (not the PSU gauges: their values include
  2147483647, an integer-max placeholder);
- the tube counter and its daily increments, and the segments;
- exams, series and images per day (from `ge_ct_exams_v`);
- the busy-hour heatmap per period (30d / 90d / 6mo = 183 d / all). The
  local hour is `started_at − local_midnight`, clamped 0..23. Day of week
  0 = Monday;
- error codes: the top 10 per period plus "other", with a daily series
  for each code that is in any period's top 10, and the daily total;
- process restarts per process;
- clean/unclean boots per day (`ge_ct_boots_v`);
- prep calendar masks: scan day, Fast Cal, warm-up. Warm-up = `Cold Tube
  Warmup` / `WarmupI` / `WarmupII`, a recommendation for field service to
  confirm in Phase 7;
- the panel list: a panel is shown iff the system has one of its metrics
  in capabilities;
- findings, open first (highest severity first), then resolved (newest
  first).

## Already verified (by the author)

- **Tests:** `node sme_reports/ct/test/model.test.js`: 12/12. The expected
  values are recomputed from the fixture rows with plain loops, not
  through the model's helpers.
  - **Rule agreement:** the abort-rate and prep functions equal the
    stored finding evidence (`first` and `last` trip days: aborts, exams,
    `per_100`; scan days, days without Fast Cal, share) on all 14 trip
    days in the fixture (5 systems, including SME01430 2026-09-25 and an
    abort finding opened 2026-11-05 on SME20608).
  - Fleet columns for all 6 fixture systems; the reporting boundary at
    exactly D+6 / D+7.
  - Heatmap totals per period and the hour computation.
  - Error top 10 + other = all `error.ermes` per period.
  - Panels and series only for logged metrics.
  - Dense series sums; boots clean/unclean.
  - Deterministic output, including with every input array reversed.
  - mA·s increments on a synthetic replacement.
- **Fleet load against prod**, read-only, with no writes possible:
  - `load_ct` 3.7 s (105,098 daily rows, 42,155 exams, 5,057 days,
    3,417 boots, 113 findings); `build_model` 0.9 s;
  - 28 reporting, 6 not reporting (exactly the six of §16.1, with the
    same last-data dates), 88 in the inventory footer;
  - all 34 payloads 0.87 MB of JSON, largest 0.07 MB (budget for the
    file: 10 MB).
- The fixture holds no customer or site names (placeholders), no exam
  numbers, no protocols, and no DICOM destination names (none of the 6
  systems log `xfer.*`).

## Where to look hardest

1. **Rule agreement beyond the fixture.** Is there an input where
   `abort_28d` / `prep_14d` differ from `rules.js` + `context.js`? For
   example: dims with n = 0, days after `as_of`, a `prep.tube_temp` day
   that has only non-Fast-Cal dims, or exams on a day with no data-day
   row.
2. **mA·s/day definition.** Increments are taken between consecutive
   *reading* days, so a multi-day gap credits the whole gap to the day
   readings resume. Is "÷ data days" the right denominator? Does dropping
   negative increments lose anything that matters besides replacements?
3. **Heatmap hour.** It uses one `local_midnight` per device day (the day
   view's offset). Exams after a DST change or clock step land an hour
   off, clamped at 0/23. Acceptable for a busy-hour map?
4. **Snapshot and determinism.** One REPEATABLE READ transaction; the
   `ORDER BY` clauses; any remaining source of non-determinism in the
   model (Map iteration order, float sums in a different order).
5. **Read-only guarantee.** Can anything in `db.js` / `data.js` write or
   take a lock that matters (REPEATABLE READ read-only vs the stage's
   writes)?
6. **Grouping and order.** Do the reporting test, the attention order and
   the not-reporting order match §16.2 item 5? Note that `max_severity`
   ignores `info`, but a `low` `tube_replaced` (counter_only) still
   counts toward attention.
7. **Payload completeness** for the §16.2 item 6 panels: anything a panel
   will need that isn't in the payload.

Out of scope: the §16.2/§16.3 decisions (agreed); rendering (step 4).

## Ground rules (this machine is also the production server)

- **Don't run anything that connects to the database**:
  `ct/tools/build_fixture.js`, anything requiring `ct/db.js`, and
  anything in `hhm_rpp_ge` that connects.
- DB-free is fine: `node sme_reports/ct/test/model.test.js` (from
  `~/hep3/reports`).
- Don't open or print any `.env`.
- Don't modify files in either repo. Report only.
- Don't touch `/home/prod/hhm_rpp_ge`.

## How to report

Write findings to `hhm_rpp_ge/REVIEW-PHASE6-DATA-MODEL-CODEX.md`, in the
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

## Fixes after review (2026-11-05)

- **F1 (as_of vs tube segments and findings): the input contract is constrained.**
  `build_model` now refuses an `as_of` earlier than the snapshot's UTC day
  (`raw.snapshot_day`, from `data.js`; also required in the fixture).
  Findings and tube segments are stored as their latest state (severity,
  observed, evidence, `latest_mas`). A past-date build could drop
  not-yet-opened rows, but it could not restore the values they had on
  that date. A later `as_of` stays allowed. `build_fixture.js` refuses
  the same case. Not chosen: rewinding findings and tubes to an earlier
  date.
- **F2 (findings source):** the findings query selects `source` and
  filters `source = 'ge_ct'`; the model also keeps only `ge_ct` rows.
- Tests 13/13 on a rebuilt fixture. The `as_of` test now covers: refusal
  before the snapshot day, a missing `snapshot_day`, a device day after
  `as_of` being ignored, and the D+6/D+7 boundary. New test: a non-ge_ct
  finding changes nothing.
- Fleet load re-run against prod, read-only: 113 findings, all `ge_ct`;
  28 / 6 / 88 unchanged; 3.7 s load, 0.8 s model, 0.88 MB payload.
