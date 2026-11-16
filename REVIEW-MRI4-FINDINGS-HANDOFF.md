# Review handoff: MRI-4 findings (`insight/mri/findings/`, GE MRI findings)

Please review the commit named by the user (MRI-4 on `dev`, on top of
271c884, the agreed MRI-4a plan), and write your findings to
`REVIEW-MRI4-FINDINGS-CODEX.md` next to this file.

```
cd ~/hep3/hhm_rpp_ge
git show --stat HEAD                                         # the MRI-4 commit
node insight/mri/test/findings.test.js && node insight/mri/test/mri.test.js && node insight/mri/test/derive.test.js   # no DB needed
```

**For comparison:** `insight/cv/findings/*` (CV-4, reviewed as
CV4-FINDINGS with its P2 fix, and CV-C1 P2 on prefix filters), which this
copies; CT's `insight/findings/state.js`, `run.js` (`reconcile`, `totals`,
the upsert) and `verify.js` (`compare_findings`), reused unchanged; the MRI
derive (`insight/mri/derive.js`, `derived_sql.js`, reviewed as
MRI3-DERIVE), whose tables and restart mark the rules read.

**Out of scope; don't edit:** `PLAN-MRI-INSIGHTS.md` (this phase is §9: the
agreed rules in §9.2, decisions F1–F12 in §9.5, the build and evidence in
§9.7; §10 plans C1-MRI, a separate CT change with its own review). Comment
on any of it in your findings.

**Don't run** `insight/mri/cli.js` or anything that connects with the repo
`.env`: it targets the production database, and GE CV's stage is in a
monitoring window until 2026-11-19. Nothing of MRI is on prod yet.

## What MRI-4 does

From `insight.ge_mri_daily`, `ge_mri_facts` and `ge_mri_codes` (MRI-2 / 3),
11 windowed rules per system and device day (plan §9.2), folded by CT's
open / resolve state machine (14 evaluated quiet days, severity never
falls, one open finding per key), written to the shared
`insight.findings` with `source = 'ge_mri'` and `mri_*` keys, plus the
`mri_*` rows of `insight.finding_catalog`:

| # | Key | Trips |
|---|---|---|
| 1 | `mri_failed_scans_high` | 7-day failed share ≥ 5%, ≥ 3× the share of D−34..D−7 (≥ 100 scans), ≥ 10 failed |
| 2 | `mri_cooling_fault` | alarms on ≥ 3 days of 7 or ≥ 50 in a day; high on a burst or a `hec_cryo*` kind |
| 3 | `mri_tps_reset_failures` | a failure (2227556 or 2256925) on ≥ 2 days of 7; high with ≥ 4 in 28 |
| 4 | `mri_process_crash_loop` | one process ≥ 5 deaths not at a restart in 7 days; high at 20 |
| 5 | `mri_prescan_failures` | a day ≥ 15 (operator reasons out) and ≥ 5× max(baseline, 1) |
| 6 | `mri_coil_fault` | coil faults on ≥ 4 days of 7; high with ≥ 14 in 28 |
| 7 | `mri_table_fault` | spike (≥ 10, ≥ 5× baseline) or persistent (≥ 10 on ≥ 5 days of 7) |
| 8 | `mri_image_quality_warning` | GE's 2218672 on ≥ 2 days of 7 |
| 9 | `mri_pm_overdue` | GE's PM-overdue on ≥ 3 days of 7 (low, compliance) |
| 10 | `mri_error_storm` | residual ≥ 300 and ≥ 10× baseline; residual = reliability / hardware / unreviewed codes minus the codes of rules 2–9 and the restart signatures |
| 11 | `mri_unclean_restarts` | ≥ 3 sessions ended by a new start with no stop, in 7 days (low) |

- **Files:** `context.js` (pure series), `rules.js`, `load.js`, `run.js`
  (rehearse / apply / replay, from CV's), `verify_sql.js` (independent
  SQL), `verify.js`; `cli.js` `findings` / `verify-findings`;
  `tools/build_findings_fixtures.js` + `__fixtures__/findings/`;
  `test/findings.test.js`.
- **Interlocks:** insight_writer only; schema ≥ 9; derive caught up
  (success on record, nothing pending, no owed codes, fact days = daily
  days); `--apply` refused until C1-MRI.

## How it was checked (plan §9.7)

- **Tests:** findings 26 (incl. JS = independent SQL on a real-data fixture
  of all 17 systems, and as-of purity on that data: 2,095 trip days); every
  suite 314 of 314.
- **Local throwaway DB (PG 14), a read-only copy of prod's MRI rows to
  2026-11-16:** JS = SQL at five as-of dates; rehearse `--replay` (69
  findings, 26 open; pass 2 0; default after replay 0 / 0 drift;
  incremental = replay, 0 drift; CT / CV rows unchanged; verify PASS);
  every interlock refused; apply (C1-MRI simulated in memory), read-only
  verify PASS, re-runs 0 changes, seeded CT / CV findings byte-identical.

## Please look at

1. **As-of purity, especially rule 4.** A death on the as-of day D is "at a
   restart" only by events on a day ≤ D; earlier days use every event (their
   ±10 min window can't pass D). Is `context.js` (strict / full counts,
   `crashes`) exactly that, and is the SQL (`dth` / `cr`) the same
   definition? Rule 11 counts on the new start's day: pure?
2. **The residual (rule 10).** JS uses `codes_reviewed.js` categories, the
   SQL `ge_mri_codes.category`; the excluded codes come from the registry
   in JS and are written out in SQL (a test pins them equal). Any code the
   two could classify differently (codes missing from `ge_mri_codes`, a
   negative code, a dim that is not a code)?
3. **Rule 1's integer comparisons** (`100 f ≥ 5 all`, `f · ball ≥ 3 · bf ·
   all`) vs the SQL, and the pooled baseline window D−34..D−7 (calendar
   days, RANGE over data days in SQL).
4. **Rule 7's observed / baseline** when a spike and the persistent variant
   both hold, or only the persistent one (JS `evaluate` vs the SQL's
   `LEFT JOIN f l` on `tbl_last`).
5. **`run.js` scoping:** every read, write and delete is limited to
   `source = 'ge_mri'` or `left(finding_key, 4) = 'mri_'`; the
   "others unchanged" fingerprint; deletes keyed by a stored `ge_mri`
   row; the shared `findings_one_open_idx (system_id, finding_key)` and
   the PK `(system_id, finding_key, opened_at)`, which don't include
   `source` (safe only because keys are prefixed).
6. **Reuse of CT code:** `replay_system` writes `source 'ge_ct'`, relabelled
   by `as_mri_rows`; `reconcile` / `resolved_final` with MRI rows; nothing
   loaded from `insight/cv/`.
7. **Preflight:** anything that could pass with derive behind or missing
   (the CV4-FINDINGS P2 class), or as a superuser.
8. **Fixture privacy:** `inputs.json` holds days, instants, codes, dims,
   counts, scan sums, event kinds and process names only; no message text.
9. **Plan §9.2 / F1–F12:** anything in the rules you would not ship, e.g.
   the image-quality warning permanently open on one system, PM overdue
   open on stopped systems, the cooling severity.
10. **§10 C1-MRI plan:** whether extending the exclusion (vs selecting CT
    prefixes) is the right call, and whether the test list is complete.
