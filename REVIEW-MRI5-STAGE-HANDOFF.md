# Review handoff: MRI-5 step 1 (the GE MRI stage and the shared stage wrapper)

Please review the commit named by the user (MRI-5 step 1 on `dev`, on top
of b307573, the agreed plan), and write your findings to
`REVIEW-MRI5-STAGE-CODEX.md` next to this file.

```
cd ~/hep3/hhm_rpp_ge
git show --stat HEAD                                         # the MRI-5 step 1 commit
node insight/mri/test/stage.test.js && node insight/mri/test/findings.test.js && node insight/mri/test/mri.test.js && node insight/test/stage.test.js && node insight/cv/test/stage.test.js && node insight/cv/test/cv.test.js   # no DB needed
```

**Don't run** `insight/cli.js`, `insight/cv/cli.js`, `insight/mri/cli.js`
(any command) or `migrations/run.js`, or anything that connects with the
repo `.env`: it targets the production database, and GE CV's stage is in a
monitoring window until 2026-11-19 20:18 UTC. Nothing of MRI is on prod yet.

**Out of scope; don't edit:** `PLAN-MRI-INSIGHTS.md`. The phase is §11:
the evidence is §11.1, the design §11.2, the agreed answers §11.3, the exit
criteria §11.4, the order §11.5 and this build §11.6. Comment on any of it
in your findings.

## What this step is

The stage that keeps the MRI tables current after each `GE_MRI` ingest:
extract (at most one batch) → derive (pending days, code labels if owed)
→ findings (all systems, default mode). It is behind its own switch
`INSIGHT_MRI_ENABLED` and never fails the run. It is the third stage, so
the wrapper that CT and CV each carry as a copy is now one shared helper.
MRI uses it from the start; CT and CV move onto it later, in MRI-5b
(§11.3 Q1).

**Not in this step:** the root `index.js` hook (after the CV-5
close-out, with its own review), and any change to CT's or CV's wrappers.
Nothing in the GE CT or GE CV run loads any file of this commit.

| File | What |
|---|---|
| `insight/stage_wrapper.js` (new) | `run_insight_stage(cfg, run_log, addLogEvent, deps)`: the CT / CV wrapper body; the differences are `cfg` (`func`, `app_name`, `label`, `load_stage`, `run_args`, `preflight_warnings`) |
| `insight/mri/index.js` (new) | `run_mri_insight`: the switch check before any load, then the wrapper with MRI's `cfg` |
| `insight/mri/stage.js` (new) | CV's `stage.js` shape: `STEPS`, `run_stage`, summaries and warnings, `stage_preflight`, `rehearse_stage` |
| `insight/mri/load.js` | `extract_step` (`apply_range` from the watermark, one batch, `behind_ids`) |
| `insight/mri/cli.js` | `stage --rehearse` (asks for the database name) |
| `insight/mri/findings/run.js` | `findings --rehearse` in REPEATABLE READ |
| `insight/mri/test/stage.test.js` (new) | 25 tests |

**For comparison:** `insight/index.js` (`run_ct_insight`) and
`insight/cv/index.js` (`run_cv_insight`), which the wrapper factors; CV's
`insight/cv/stage.js` and `insight/cv/test/stage.test.js` (reviewed as
CV5-CORES / CV5-STAGE / CV5-HOOK, live since 2026-11-12), which MRI's
copies.

## How it was checked (plan §11.6)

- **Every suite: 340 of 340.** 22 mutations of the new code each fail at
  least one test.
- **Equivalence harness** (`~/cv_d3b_evidence/mri/mri5/equiv.js`,
  DB-free): the live CT and CV wrappers vs the shared one configured as
  each. 12 scenarios × 2, identical in return values, run-log events,
  connection calls and `run_stage` options.
- **Local throwaway DB** (PG 14, prod's MRI rows copied read-only, with
  1,340 new rows):
  - the stage rehearsal: OK, with a concurrent CT-side commit hidden by
    REPEATABLE READ;
  - the live path (wrapper → stage, committing): catch-up 10.1 s, no
    rows 2.1 s, then the three verifiers pass, and non-MRI rows are
    unchanged;
  - a held lock: a skip;
  - a control: READ COMMITTED would have reported that commit as a
    change.

## Please look at

1. **The wrapper is the CT / CV body, unchanged in behaviour.** Diff
   `insight/stage_wrapper.js` against `insight/index.js`. Is anything
   lost when CT moves onto it in MRI-5b? Check `run_args` (CT's rules,
   loaded before connecting), the partition WARN, the message texts, the
   key order of the `run_stage` options, the deadline, and that it never
   rejects. Is the `cfg` check right to be an ERROR rather than a throw?
2. **"Off loads nothing":** `insight/mri/index.js` loads neither the
   wrapper nor `./stage` when the switch is off. Its catch covers only a
   failed require of the wrapper. Does the test with the module cache
   prove that?
3. **`stage_preflight`:** the extract apply preflight (the writer role,
   not a superuser; schema ≥ 9; C2-MRI; C1-MRI), plus an extract
   watermark. Can the live stage start a backfill, or write with derive
   behind? Findings has its own MRI-4 preflight at the findings step.
4. **`extract_step`, one batch:** the late re-read, the conflict refusal
   (review MRI2-EXTRACT P2-1) and the watermark per batch come from
   `apply_range` unchanged. Is `behind_ids` (source max − watermark)
   right when the rehearsal passes `to_id`?
5. **The rehearsal:** REPEATABLE READ, the three runs, and the checks.
   Does `OTHERS_SQL` cover every non-MRI row of the shared tables
   (findings, both catalogs, job state), by prefix and with no backslash?
   Is the `ge_mri_` 7-character prefix right for job names?
6. **The code-label cost** (§11.1, §11.3 Q3): a rebuild on every run with
   new rows (about 7.5 s now, growing about 8% a month), with a WARN
   above 30 s. Would you ship that, or need something cheaper first?
7. **Fixtures and privacy:** the test strings use made-up system ids and
   host names; nothing is copied from prod rows.
