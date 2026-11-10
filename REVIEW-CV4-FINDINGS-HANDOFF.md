# Review handoff: CV-4 findings (GE CV findings rules, run, verify) and migration 008

Everything is **uncommitted** on `dev`, on top of 4199864. Please write
your findings to `REVIEW-CV4-FINDINGS-CODEX.md` next to this file.

```
cd ~/hep3/hhm_rpp_ge
git status --short                                       # what is new / changed
cat insight/cv/findings/{context,rules,load,run,verify_sql,verify}.js   # new
git diff insight/cv/cli.js insight/cv/test/cv.test.js    # CLI: findings / verify-findings
cat insight/cv/test/findings.test.js insight/cv/tools/build_findings_fixtures.js   # new
cat migrations/008_ct_findings_view_source.sql migrations/008_ct_findings_view_source.down.sql migrations/test/m008.test.js   # new
node insight/cv/test/findings.test.js && node insight/cv/test/cv.test.js && node migrations/test/m008.test.js   # no DB needed
```

**Out of scope; don't edit:** `PLAN-CV-INSIGHTS.md`. The design and the
evidence are in §10, which covers the agreed rules (F1–F6) and the build
in §10.8. CT's findings method is in `PLAN-CT-INSIGHTS.md` §14. Comment
on design points in your findings.

**Don't run** `insight/cv/cli.js` (any command) or `migrations/run.js`.
The repo `.env` targets the production database.

## What this is

Five GE CV findings over `insight.ge_cv_daily`, with source `ge_cv` in
the shared `insight.findings`. All are windowed: 7 days = D−6..D. A
baseline is the median of the data days in D−28..D−1 and needs ≥ 7 of
them.

| Key | Trips when | Severity |
|---|---|---|
| `cv_error_storm` | A storm day is in the last 7 days. A storm day's **residual** is ≥ 300 and ≥ 10 × max(baseline, 1), with a baseline. Residual = `cv.error` − detector com − anticollision − table encoder − PIB − code 1200019 | high with ≥ 3 storm days in 28 |
| `cv_detector_com_errors` | A day with ≥ 50 in the last 7 | high with ≥ 3 such days in 28 |
| `cv_anticollision_burst` | A day with ≥ 50 and ≥ 5 × max(baseline, 1) in the last 7; the absolute threshold alone without a baseline | medium |
| `cv_table_encoder_fault` | ≥ 5 on each of ≥ 2 days in the last 7 | high with ≥ 10 such days in 28 |
| `cv_pib_com_loss` | ≥ 3 in the last 7 days | high on ≥ 3 days |

**Reuse of CT code** (none of it is changed; the GE CT Phase 5
monitoring window forbids that):
- the open/resolve fold `insight/findings/state.js` `replay_system(ctx,
  rules)`: 14 evaluated quiet days, and severity never falls;
- `reconcile` / `totals` / `UPSERT_SUFFIX` from `insight/findings/run.js`;
- `compare_findings` from `insight/findings/verify.js`;
- `validate_finding_rules` from `insight/findings/rules.js`.

CT's fold hard-codes `source: "ge_ct"`. CV relabels its rows in
`as_cv_rows` (`run.js`), which also refuses a key without the `cv_`
prefix.

**Interlocks (`run.js` `preflight`):**
- limited `insight_writer` only;
- schema ≥ 7 to rehearse, ≥ 8 to `--apply` (008 = C3);
- CV derive caught up (no pending days, no owed code labels);
- `--apply` needs C1 (the three CT verifiers export `CV_AWARE`).

**008:** drops and re-creates `api.ge_ct_findings_v` with 005's columns
plus `WHERE f.source = 'ge_ct'`; the down restores 005. 007 already made
`api.ge_cv_findings_v`. The view has no grants, dependants or default
privileges on prod (read-only check, 2026-11-10).

## How it was checked (plan §10.8)

- **Tests:** `findings.test.js` 17 (real-data fixture = independent SQL,
  the 12 named cases, every rule boundary, the fold, as-of purity,
  preflight, CLI), `cv.test.js` 15, `m008.test.js` 2. Every other suite
  still passes.
- **Local throwaway PostgreSQL 14** with prod rows through device day
  2026-11-10:
  - 008: runner dry run, roundtrip (in-scope ~1, the down restores all
    303 objects), apply;
  - interlocks refused;
  - `rehearse --replay`: 12 findings; pass 2 changed 0; the default pass
    after it changed 0 with 0 drift; incremental (today−28, then weekly)
    identical with 0 drift; CT rows and catalog unchanged; verify PASS;
    nothing persisted;
  - apply, then a read-only verify PASS; re-runs changed 0; the views
    are split by source.

## Please look at

1. **The SQL's independence and equality** (`verify_sql.js` vs
   `context.js` + `rules.js` + CT's fold):
   - `RANGE BETWEEN '6 days' PRECEDING` over data-day rows vs the JS dense
     arrays.
   - The baseline: `percentile_cont(0.5)` over `x` rows in
     `[d−28, d−1]` vs JS `median` of `data_days(D−28, D−1)`. Are these
     equal for an even count, and with gaps?
   - `observed` / `baseline`: the last storm/burst day in the window, on
     both sides.
   - Data days: JS from facts; SQL from `ge_cv_daily` joined to facts.
     The preflight refuses while derive is pending. Is that enough, or
     can they still differ? (Think of days with facts but only
     relay-ignored rows: none by construction?)
   - Could one shared mistake pass both?
2. **The residual:**
   - It assumes each counted row has exactly one `cv.error` fact and at
     most one named fact (CV-2's `MAX_FACTS_PER_ROW`), so subtracting the
     named counts is exact. Check against `insight/cv/rules.js`.
   - What if a future rule version maps a row to a named metric without
     `cv.error`?
3. **Reusing CT's run pieces:**
   - `reconcile` / `resolved_final` with CT's `STALE_DAYS`; the upsert;
     the default mode.
   - Any place where CT assumptions (source, keys, the job name in
     `record_as_of`) leak into CV rows?
   - `as_cv_rows` after the fold: does anything in the fold's output
     depend on `source`?
4. **Isolation:**
   - Every CV statement is limited to `source = 'ge_cv'` / `cv\_%`
     (deletes, fingerprints, catalog, verify).
   - The `LIKE 'cv\_%'` escapes inside JS strings.
   - Can a CV run touch CT rows or the CT catalog?
   - And the reverse: CT's findings run reconciles `source = 'ge_ct'`
     only, and its `sync_catalog` only reports extra keys.
5. **008:** safe on prod given no grants or dependants? Is the
   expectation for the CT viewer (`reports/sme_reports/ct`, which already
   filters `source = 'ge_ct'`) right?
6. **Rules:** off-by-one in the windows (7 / 28 / baseline); the
   anticollision "no baseline" branch; severities; evidence holding no
   debug text (codes, dims, counts only).
7. Anything else.
