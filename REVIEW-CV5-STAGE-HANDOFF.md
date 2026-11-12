# Review handoff: CV-5 step 2 (the GE CV stage, its kill switch and its rehearsal)

Everything is **uncommitted** on `dev` in `~/hep3/hhm_rpp_ge` (from
cab58d9), on top of step 1 (`REVIEW-CV5-CORES-HANDOFF.md`). Please write
your findings to `REVIEW-CV5-STAGE-CODEX.md` next to this file.

```
cd ~/hep3/hhm_rpp_ge
git status --short
cat insight/cv/stage.js insight/cv/index.js       # new
git diff insight/cv/cli.js                        # stage --rehearse and its prompt
diff <(sed -n '/^async function run_ct_insight/,/^}/p' insight/index.js) <(sed -n '/^async function run_cv_insight/,/^}/p' insight/cv/index.js)   # the wrapper is CT's copy
node insight/cv/test/stage.test.js                # 25, no DB
```

**Not in this step:** the root `index.js` hook (step 3, a checkpoint for
the user). Nothing calls `run_cv_insight` yet. **Out of scope; don't
edit:** `PLAN-CV-INSIGHTS.md` (design §12, agreed 2026-11-12).

**Don't run** `insight/cli.js`, `insight/cv/cli.js` (any command) or
`migrations/run.js`: this checkout's `.env` targets the production
database.

## What this is (plan §12.2, all of §12.3 Q1–Q7 agreed)

- **`insight/cv/index.js` `run_cv_insight(run_log, addLogEvent)`**: a copy
  of CT's `run_ct_insight` (§12.3 Q2: CT's stage, just closed out, is not
  touched). The differences:
  - the switch is `INSIGHT_CV_ENABLED === "true"` (Q1). CT's
    `INSIGHT_ENABLED`, already `true` on prod, does not turn it on;
  - `require("../db")`, `require("./stage")`; no `rules` dependency; no
    partition warning (CV facts are not partitioned);
  - `applicationName: "insight_cv_stage"`, `func` `run_cv_insight`.

  Same as CT: off = returns at once with no require, connection or log;
  never rejects; own pool as `insight_writer`; connect 10 s, statement
  120 s, client backstop 135 s; a 5-minute deadline that kills the
  connection; one advisory lock (`insight_ge_cv`) for the whole stage,
  skip if held; preflight failure = WARN and skip.
- **`insight/cv/stage.js`**:
  - `stage_preflight`: `load.preflight(conn, { mode: "apply" })` (role,
    schema ≥ 7, C2 SELECT on `log.ge_cv_syserror`, C1 `CV_AWARE`) plus
    schema ≥ 8.
  - `run_stage`: extract (`extract_step`, at most one 50k batch, Q4) →
    derive (`derive_step`) → findings (`findings/run.js` `preflight`
    apply, then `findings_step`, default mode, all systems, every run,
    Q3). A step runs only if the one before succeeded; failures are
    returned, not thrown; the three watermarks are read at the end.
  - `summarize` / `step_warnings`: the run-log notes. WARN for: late
    re-read inserted facts, unreviewed codes, extract behind the source,
    derive pending left, findings drift.
  - `rehearse_stage`: as CT's. ONE transaction, rolled back, under the
    lock: run 1 catch-up (pending range before the last `GE_CV` run),
    run 2 typical (the last run's rows), run 3 no new rows; then on the
    uncommitted data `verify`, `verify-derive`, `verify-findings`; derive
    touched = full rebuild (content fingerprint); findings default =
    replay; **CT rows unchanged** (`CT_SQL`: non-CV findings, both
    catalogs' non-CV rows, non-CV job state); the watermarks are read
    again after the rollback.
- **`insight/cv/cli.js stage --rehearse`**: the only stage command (the
  live stage runs only from `index.js`). It asks for the database name
  before anything runs (Q6), as CT's `cli.js`.

## How it was checked

- **Tests** (`insight/cv/test/stage.test.js`, 25, no DB), the stage part:
  `run_stage` order, one batch, UTC `today`, one run id; a failure at
  each step stops the chain and is returned; watermark equality; the
  summaries and every warning; `stage_preflight`; the CT check covers
  every shared table by prefix with no backslash; the real `STEPS` (the
  findings step runs the apply preflight first and writes nothing if it
  refuses); the kill switch for 7 values, with CT's switch on; one CV
  lock, an event per step and a summary; a WARN step; lock held;
  preflight refusal; a failed step; never rejects (connect, stage,
  unlock and logger throwing); the bounds; the deadline; no top-level
  require; the CLI flags and the prompt order.
- **Mutation check** (each made the suite fail; restored): the switch
  read from `INSIGHT_ENABLED` (9 tests fail); the findings preflight
  removed; no per-run batch ceiling; watermark equality ignoring
  findings.
- **Local throwaway PostgreSQL 14** (`~/cv_d3b_evidence/cv5/`, one clone
  per scenario, `insight/db.js` stubbed; `.env` never read):
  - `stage_live.js` → `stage_live.log`: the real `run_cv_insight` with a
    fake logger.
    - Run A, catch-up 1,223 rows: 2.9 s.
    - Run B, the last prod run's 62 rows: 2.0 s. It WARNs on the two
      new codes; they are reviewed since (step 1 handoff).
    - Run C, no rows: 0.65 s.
    - All `ok`, with the three watermarks equal after each run.
    - The content is identical to the CLI apply result (`cmp_cli.js`
      clone), and the read-only `verify`, `verify-derive` and
      `verify-findings` pass.
    - Lock held by another session: an INFO skip, 7 ms. Switch off: no
      event, no connection.
    - 0 sessions and 0 advisory locks are left.
  - `stage_kill.js` → `stage_kill.log`: deadlines of 400, 900 and
    1,600 ms killed three runs:
    - extract committed; derive part-done with the code labels owed;
      findings killed;
    - each time, 0 sessions and 0 locks were left;
    - the next run caught up: watermarks equal, content identical to the
      CLI result, then a repeat run with 0 changes.
  - The real CLI, `node -r preload_local.js insight/cv/cli.js stage
    --rehearse` → `stage_rehearse.log`:
    - a wrong database name aborts before anything runs;
    - the right one gives **overall: OK** in 13.2 s: 3 runs ok,
      watermarks equal, `verify`/`verify-derive`/`verify-findings` pass,
      touched = full, default = replay (13 = 13), CT rows unchanged;
    - the watermarks are unchanged after the rollback.
- Every suite passes (see the step 1 handoff).

## Questions for the review

1. Is the wrapper a faithful copy of `run_ct_insight` apart from the
   listed differences? Does anything CT's reviews fixed (PHASE5-STAGE F1,
   F2; PHASE5-HOOK F2) not carry over?
2. Running findings on every run: any risk in rewriting the
   `ge_cv_findings` job state (and its `as_of_by_system`) every 30
   minutes?
3. The rehearsal's `CT_SQL` check runs in READ COMMITTED, so a CT stage
   commit during the rehearsal (the GE_CT run at :18/:48) would show as
   "CT changed". Is "avoid :18/:48", as for CT's rehearsal, enough?
4. Both stages run in separate processes at :18/:48. Do you see any
   cross-stage lock wait or deadlock? They share `insight.job_state`,
   `findings`, `finding_catalog` and `metric_catalog`, on disjoint rows.
