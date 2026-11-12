# Review handoff: CV-5 step 3 (the `index.js` hook for the GE CV stage)

Repo `hhm_rpp_ge`, branch `dev`, **uncommitted**, on top of steps 1–2
(`REVIEW-CV5-CORES-HANDOFF.md`, `REVIEW-CV5-STAGE-HANDOFF.md`, both
reviewed and closed: plan §12.7). This is the **only** CV-5 change outside
`insight/cv/`. It runs inside the production `GE_CV` ingest process
(`node index.js GE_CV`, cron at :18 and :48 UTC). Nothing is deployed.
Please write your findings to `REVIEW-CV5-HOOK-CODEX.md` next to this
file.

```
cd ~/hep3/hhm_rpp_ge
git diff index.js                       # the hook (16 lines)
git diff insight/cv/test/cv.test.js     # the isolation tests (tightened)
cat insight/cv/index.js                 # run_cv_insight, what the hook calls
node insight/cv/test/cv.test.js         # 17, no DB
cat ~/cv_d3b_evidence/cv5/hook_compare.log   # the harness result (below)
```

## The change

```js
    // GE CV insight stage (PLAN-CV-INSIGHTS.md §12): runs after every
    // system's ingest has finished; off unless INSIGHT_CV_ENABLED=true; logs
    // to run_log and never fails the run.
    if (shell_value[0] === "GE_CV") {
      try {
        const { run_cv_insight } = require("./insight/cv");
        await run_cv_insight(run_log, addLogEvent);
      } catch (error) {
        try {
          await addLogEvent(E, run_log, "run_cv_insight", cat, null, error);
        } catch (_) {
          // the run log below must still be written
        }
      }
    }
```

It sits directly after the CT hook (`GE_CT`, live since Phase 5, not
changed). It runs after the system loop and before
`console.log(run_log.log_events)` / `writeLogEvents`. The shape is CT's
hook as it is today, including the guarded catch.

**Isolation tests** (`insight/cv/test/cv.test.js`, 16 → 17). The old
pattern `require\([^)]*\bcv\/` did not match `require("./insight/cv")`
(there is no slash after `cv`), so the hook would have passed it
unnoticed. Now one pattern matches a require of `cv` in any form:
- **CT's `insight/` files:** none may require it.
- **Root `index.js`:** exactly one such require, `require("./insight/cv")`,
  inside the `GE_CV` branch. The CT block still requires only
  `./insight` and mentions nothing of CV.
- **Mutation check** (each failed the suite; files restored): the CT
  branch also loading `./insight/cv`; the require moved outside the
  `GE_CV` branch; `insight/stage.js` requiring `./cv`; the hook under
  `GE_CT`.

## The harness (DB-free)

`~/cv_d3b_evidence/cv5/hook_harness.js` and `hook_compare.sh`, adapted
from CT's Phase 5 harness:
- It loads the real `index.js`, both **HEAD's** (`git show HEAD:index.js`)
  and the new one, with recorders for `./jobs` (3 fake systems of the
  run's modality, 20 ms of "ingest" each), `./utils/db/pg-pool`,
  `./acquisition/on_boot_queries` and `./utils/logger/log`.
- It runs from a directory with no `.env`; the INSIGHT/PG variables are
  unset.
- `./insight/cv` is the **real** module only when the CV switch is off.
  Every "on" scenario stubs it (and `./insight`), and the harness throws
  if the real stage could run with a switch on. No connection can be
  opened.

| Scenario | vs HEAD |
|---|---|
| `GE_CV`, switch unset, CT's `INSIGHT_ENABLED=true` | ingest calls/order and run-log events identical; loads `insight/cv/index.js` only |
| `GE_CV`, `INSIGHT_CV_ENABLED=false` / `TRUE` | same |
| `GE_CV`, on (stage stubbed) | ingest identical; the stage starts after 3/3 systems ingested, before `writeLogEvents`; +1 event |
| `GE_CV`, on, the stage throws | +1 ERROR `run_cv_insight` (CATCH); the log is still written |
| `GE_CV`, on, `require("./insight/cv")` fails | +1 ERROR; the log is still written |
| `GE_CV`, on, the stage and the logger both throw | the log is still written (no event added) |
| `GE_CT`, both switches on (CT stage stubbed) | **identical** |
| `GE_CT`, CV switch on, CT's off | **identical** |
| `GE_MRI`, both switches on | **identical** |

No unhandled rejection in any scenario.

**Ingest is finished when the hook starts.** In `jobs/CV/index.js`
`ge_cv_parsers` and `jobs/CV/sysError_parser.js`, every ingest step is
awaited inside the loop: the `log.ge_cv_syserror` insert, the
`drop_already_ingested_cv` dedupe, the Redis offset and `.head` updates,
and `gzip_n_save`. `run_job` catches its own errors.

## Where to look hardest

1. Can the hook change the `GE_CV` ingest in any way, with the switch off
   or on? Think of timing, order, the main `pgPool`, the Redis client,
   `run_log` as ingest sees it, process exit (open handles), and
   unhandled rejections.
2. Can it fail the run or lose the run log?
3. **Overlap:**
   - with the next `GE_CV` run (30 min later; ingest ~1.5 s, the stage
     ~2–3 s, at most 5 min by its deadline);
   - with the `GE_CT` process that starts at the same minute and runs its
     own stage (a different advisory lock; shared tables on disjoint
     rows).
4. Prod differences: the gitignored `utils/` (logger, enums, pg-pool),
   and `.env` loading (`index.js` from the working directory;
   `insight/db.js` from the repo root, as for CT).

## Ground rules (this machine is also the production server)

- **Don't run anything that connects to the database:** `node index.js`,
  `npm run ge_*`, `insight/cli.js`, `insight/cv/cli.js`,
  `migrations/run.js`, or `run_cv_insight` / `run_ct_insight` with a
  switch on and a real connection.
- DB-free commands are fine: the test files, `node --check`, and the
  harness (run `hook_compare.sh` from its own directory; it refuses if a
  `.env` is there).
- Don't open or print `.env`. Don't modify files; report only.
- Don't touch `/home/prod/hhm_rpp_ge`, except reading
  `utils/logger/log.js` / `enums.js` there to compare the logger
  interface.
