# Review handoff: MRI-5b (CT and CV onto the shared stage wrapper)

Everything is **uncommitted** in `~/hep3/hhm_rpp_ge` on `dev` (HEAD
63e25fc, which is what prod runs). This change replaces the live GE CT and
GE CV stage wrappers, which run inside the production ingest processes
(`node index.js GE_CT` / `GE_CV`, cron at :18 and :48 UTC), with thin callers
of `insight/stage_wrapper.js`. That wrapper has run GE MRI's stage on prod
since 2026-11-18 (234 clean runs, plan §11.11). Nothing is deployed. Please
write your findings to `REVIEW-MRI5B-CODEX.md` next to this file.

```
cd ~/hep3/hhm_rpp_ge
git status --short                     # 6 changed files + this handoff + the plan
git diff insight/index.js insight/cv/index.js     # the thin callers
git diff insight/stage_wrapper.js                 # a header comment only
git diff insight/stage.js insight/cv/stage.js     # the rehearsal fix
git diff insight/test/stage.test.js insight/cv/test/stage.test.js   # two regression tests, appended
git show 886c0e5:insight/index.js                 # the old CT wrapper (the CV one was its copy)
node insight/test/stage.test.js && node insight/cv/test/stage.test.js && node insight/mri/test/stage.test.js && node insight/mri/test/mri.test.js && node insight/cv/test/cv.test.js   # no DB
cat ~/cv_d3b_evidence/mri/mri5b/equiv/equiv_final.log   # old vs new, 26 scenarios + mutations
cat ~/cv_d3b_evidence/mri/mri5b/hook/hook_compare.log   # the root index.js harness, old vs new tree
```

**Out of scope; don't edit:** `PLAN-MRI-INSIGHTS.md`. The design is §12.2,
the agreed answers §12.3 (one change for CT and CV; the rehearsal fix in
both; a 3-day watch; the monitor first), the exit criteria §12.4, the build
§12.6. Comment on any of it in your findings.

## The change

1. **`insight/index.js` (CT) and `insight/cv/index.js` (CV): thin callers.**
   Each keeps its switch check first (`INSIGHT_ENABLED` /
   `INSIGHT_CV_ENABLED`; off returns `{ skipped: "disabled" }` before any
   `require`), then calls `run_insight_stage(cfg, run_log, addLogEvent,
   deps)`, as `insight/mri/index.js` does:
   - CT: `func "run_ct_insight"`, `app_name "insight_stage"`, `label
     "insight"` (the wrapper's lock and deadline texts are built from it,
     giving CT's exact old texts), `load_stage: () => require("./stage")`,
     `run_args` (CT's rules registry, `deps.rules` first, loaded before the
     connection), and `preflight_warnings` with CT's exact partition text;
   - CV: `func "run_cv_insight"`, `app_name "insight_cv_stage"`, `label
     "GE CV insight"`, `load_stage`; no `run_args`, no preflight warning.
   - A failed `require` of the wrapper is caught and logged as `ERROR`
     `step: "stage"` (as MRI's caller).
   - **Exports kept:** the function, `enabled`, and the four timeout
     constants. The constants are lazy getters that read the wrapper, so
     requiring the file still loads nothing. Only the CT and CV tests read
     them; the root `index.js` destructures only the function.
   - `run_args` sits below `run_ct_insight` in the file: the existing test
     "loads no module at require time" scans the text above the function
     for `require(`.
2. **`insight/stage_wrapper.js`:** the header now says CT, CV and MRI use
   it. No code change.
3. **The rehearsal fix, CT and CV** (`rehearse_stage` in `insight/stage.js`
   and `insight/cv/stage.js`), as MRI's fix for review MRI5-STAGE P3 (plan
   §11.7):
   - The bug: after a failed run the loop `break`s, but `runs` held every
     planned run, so `findings_drift` read `r.steps` of a run never reached
     and the rehearsal rejected with "Cannot read properties of undefined
     (reading 'findings')" instead of returning its failed result. CT also
     ran `verify_facts` with the never-reached run's watermarks. §11.7
     named only CV; CT had the same bug.
   - The fix: `planned` and the executed `runs` are kept apart; `runs_ok`
     requires every planned run; `checks.not_run` lists the runs not
     reached. In CT, every verification (verify, verify-derive,
     verify-findings, derive touched = full, findings default = replay) is
     now inside `if (all_ok)`, as CV and MRI already had it, and `ok`
     short-circuits on `all_ok`. The re-indent of that block is the bulk of
     CT's diff.
   - Only `cli.js stage --rehearse` runs this code; `run_stage` (the live
     path) is untouched.
   - **Regression tests** (DB-free, appended to each `stage.test.js`;
     MRI's case: watermark 100, pending max 120, the last run from 111):
     extract fails in run 1, then in run 2 → a structured failed result,
     rolled back and unlocked, only the executed runs, `not_run` listed,
     no verify. Both **fail on the old code** with the TypeError (run on a
     scratch copy with the old `stage.js`).

## The proof (all DB-free)

- **Existing tests unchanged:** `insight/test/stage.test.js` (CT, 24) and
  `insight/cv/test/stage.test.js` (CV, 27) inject `connect`, `stage`,
  `rules` and `deadline_ms`, which the shared wrapper reads too. They pass
  unchanged against the thin callers. With the two new tests, every suite:
  346 / 346 in 25 files.
- **Old vs new wrappers** (`~/cv_d3b_evidence/mri/mri5b/equiv/`; `run.sh`
  copies the old CT and CV wrappers from git 886c0e5): the 24 scenarios of
  §11.6 plus "off", for CT and CV. That is ok, a WARN step, lock held,
  preflight failure, partition warning, a failed step, a watermark read
  failure, the stage and the unlock both throwing, connect throwing, the
  logger throwing, no run id, the deadline, and the switch off. Return
  values, run-log events (ms normalised), connection calls and `run_stage`
  options: **IDENTICAL in all 26.** Six mutations of the new `cfg` (CT and
  CV label, CT and CV `app_name`, CT's partition text, CT's `run_args`
  ignoring `deps.rules`) each make it DIFFER.
- **The root `index.js` harness** (`~/cv_d3b_evidence/mri/mri5b/hook/`,
  MRI-5's with the repo root as a parameter; old tree = `git archive
  HEAD`): `GE_CT` and `GE_CV` with their switch off (the real callers) and
  on (stubbed), and `GE_MRI` off: **identical.** With the switch off, a
  `GE_CT` run loads only `insight/index.js` (not the wrapper), and no handle
  is left open.

## Where to look hardest

1. Is any behaviour of the old CT or CV wrapper lost or changed? Think of
   the texts, the order of loading (rules before the connection), the
   options passed to `run_stage`, the deadline, the logger throwing, the
   exports, and "off loads nothing".
2. The lazy getters for the constants: are they safe? Could anything
   enumerate or spread the exports at require time in prod?
3. The rehearsal fix: anything still reading a run not reached? Is the CT
   `ok` right when every run passes (each check exactly as before)?
4. Prod differences: the gitignored `utils/` (logger, enums), and `.env`
   loading (`insight/db.js` from the repo root).
5. The deploy (§12.5): the move is live with the pull, without a switch,
   and rollback is `git revert` + pull. Is that acceptable for the CT and
   CV paths?

## Ground rules (this machine is also the production server)

- **Don't run anything that connects to the database:** `node index.js`,
  `npm run ge_*`, `insight/cli.js`, `insight/cv/cli.js`,
  `insight/mri/cli.js` (any command), `migrations/run.js`, or
  `run_ct_insight` / `run_cv_insight` / `run_mri_insight` with a switch on
  and a real connection.
- DB-free commands are fine: the test files, `node --check`, `equiv/run.sh`
  and the hook harness (run it from its own directory, which has no
  `.env`).
- Don't open or print `.env`. Don't modify files other than your findings
  file; report only.
- Don't touch `/home/prod/hhm_rpp_ge`.
