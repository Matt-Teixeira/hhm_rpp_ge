# Review handoff: MRI-5 step 2 (the `index.js` hook for the GE MRI stage)

Everything is **uncommitted**, in a scratch git worktree on branch
`mri5-hook` (from `dev` at 95797ea, which holds MRI-5 step 1, reviewed as
MRI5-STAGE and closed: plan §11.7). It is not in `~/hep3/hhm_rpp_ge`,
which stays unchanged until the GE CV-5 close-out (2026-11-19 20:18 UTC).
This is the **only** MRI-5 change outside `insight/`: it runs inside the
production `GE_MRI` ingest process (`node index.js GE_MRI`, cron at :18
and :48 UTC, started together with `GE_CT` and `GE_CV`). Nothing is
deployed. Please write your findings to `REVIEW-MRI5-HOOK-CODEX.md` next
to this file.

```
cd /tmp/claude-1018/-home-matt-teixeira-hep3-hhm-rpp-ge/55e9ee15-2148-40b1-8e6c-cee8680b1d44/scratchpad/mri5hook
git status --short                          # 2 changed files, nothing new
git diff index.js                           # the hook (16 lines)
git diff insight/mri/test/mri.test.js       # the isolation tests
cat insight/mri/index.js                    # run_mri_insight, what the hook calls
cat insight/stage_wrapper.js                # the shared wrapper it calls when on
export NODE_PATH=$HOME/hep3/hhm_rpp_ge/node_modules   # the worktree has no node_modules
node insight/mri/test/mri.test.js && node insight/mri/test/stage.test.js && node insight/cv/test/cv.test.js && node insight/test/stage.test.js   # no DB needed
cat ~/cv_d3b_evidence/mri/mri5/hook/hook_compare.log  # the harness result (below)
```

`insight/test/stage.test.js` skips one test in the worktree (CT's
`connect()` timeouts need `PG_SSL_PATH`, which comes from `.env`; the
worktree has none). That is expected.

**Out of scope; don't edit:** `PLAN-MRI-INSIGHTS.md` in the main checkout.
The design is §11.2 item 5, the order §11.5 step 2, and this build §11.8.
Comment on any of it in your findings.

## The change

```js
    // GE MRI insight stage (PLAN-MRI-INSIGHTS.md §11): runs after every
    // system's ingest has finished; off unless INSIGHT_MRI_ENABLED=true; logs
    // to run_log and never fails the run.
    if (shell_value[0] === "GE_MRI") {
      try {
        const { run_mri_insight } = require("./insight/mri");
        await run_mri_insight(run_log, addLogEvent);
      } catch (error) {
        try {
          await addLogEvent(E, run_log, "run_mri_insight", cat, null, error);
        } catch (_) {
          // the run log below must still be written
        }
      }
    }
```

It sits directly after the CV hook (`GE_CV`, live since 2026-11-12, not
changed). It runs after the system loop and before
`console.log(run_log.log_events)` / `writeLogEvents`. The shape is the CV
hook's, which is CT's.

With the switch off, `run_mri_insight` returns `{ skipped: "disabled" }`
before loading anything: not the shared wrapper, not `./stage`, no
connection, no log event (`insight/mri/index.js`; a fresh-process test in
`stage.test.js` checks it with `Module._load`).

**Isolation tests** (`insight/mri/test/mri.test.js`, 23 → 24):
- The walk "nothing outside `insight/mri` loads it" now covers CT's and
  CV's `insight/` files only. The root `index.js` has its own test:
  - exactly one require of `insight/mri`, `require("./insight/mri")`,
    inside the one `GE_MRI` branch, awaited, with the guarded ERROR log;
  - the order: the ingest loop, CT's hook, CV's hook, MRI's hook, then
    `writeLogEvents`;
  - the CT and CV blocks keep their requires and mention nothing of MRI;
  - nothing else in `index.js` mentions `insight/mri`,
    `run_mri_insight`, `stage_wrapper` or `INSIGHT_MRI`.
- **Mutation check:** 12 breaks of the hook, each failing the test (plan
  §11.8 lists them).
- CV's own test (`cv.test.js`, "the root index.js loads insight/cv exactly
  once") still passes unchanged.

## The harness (DB-free)

`~/cv_d3b_evidence/mri/mri5/hook/hook_harness.js` and `hook_compare.sh`,
adapted from CV-5's:
- It loads the real `index.js`, both **`dev`'s** (`index_head.js`, from
  `git show dev:index.js`) and the hook's (`index_new.js`), with recorders
  for `./jobs` (3 fake systems of the run's modality, 20 ms of "ingest"
  each), `./utils/db/pg-pool`, `./acquisition/on_boot_queries` and
  `./utils/logger/log`.
- It runs from a directory with no `.env`; the INSIGHT / PG variables are
  unset except the switches each scenario sets.
- `./insight`, `./insight/cv` and `./insight/mri` are the **real**
  modules only while their switch is off. Every "on" scenario stubs them,
  and the harness throws if a real stage could run with its switch on. No
  connection can be opened.
- It also records open handles when the log is written.

| Scenario | vs `dev` |
|---|---|
| `GE_MRI`, switch unset (CT's and CV's on), `false`, `TRUE` | ingest calls, order and run-log events identical; loads `insight/mri/index.js` only; no open handles |
| `GE_MRI`, on (stage stubbed) | ingest identical; the stage starts after 3 / 3 systems are ingested, before `writeLogEvents`; +1 event |
| `GE_MRI`, on, the stage throws | +1 ERROR `run_mri_insight` (CATCH); the log is still written |
| `GE_MRI`, on, `require("./insight/mri")` fails | +1 ERROR; the log is still written |
| `GE_MRI`, on, the stage and the logger both throw | the log is still written (no event added) |
| `GE_CT`, all switches on (stages stubbed) / MRI's on, CT's off | **identical** |
| `GE_CV`, all switches on (stages stubbed) / MRI's on, CV's off | **identical** |

No unhandled rejection in any scenario. **Self-check:** a hook that isn't
awaited loses the stage's event from the written log, and a hook under
`GE_CV` makes `GE_CV` differ from `dev`; the harness shows both.

**Ingest is finished when the hook starts.** In `jobs/MRI/index.js`
`ge_mri_parsers` and `jobs/MRI/gesys_parser.js`, every ingest step is
awaited inside the loop: the `log.ge_mri_gesys` insert and upsert, the
Redis offset update, and `gzip_n_save`. Both functions and `run_job`
catch their own errors.

## Where to look hardest

1. Can the hook change the `GE_MRI` ingest in any way, with the switch
   off or on? Think of timing, order, the main `pgPool`, the Redis client,
   `run_log` as ingest sees it, process exit (open handles: the stage's
   pool is its own and is closed in the wrapper's `finally`), and
   unhandled rejections.
2. Can it fail the run or lose the run log?
3. **Overlap:**
   - with the next `GE_MRI` run (30 min later; ingest 18 s p50, 46 s max;
     the stage about 10 s with rows, 2 s without, at most 5 min by its
     deadline; one MRI advisory lock, so an overlapping stage skips);
   - with the `GE_CT` and `GE_CV` processes that start at the same minute
     and run their own stages (their own locks; shared tables on disjoint
     rows, plan §11.1 and §11.3 Q2).
4. Prod differences: the gitignored `utils/` (logger, enums, pg-pool),
   and `.env` loading (`index.js` from the working directory;
   `insight/db.js` from the repo root, as for CT and CV).
5. **With C1-MRI** (reviewed as C1-MRI, closed; its own worktree): the two
   diffs both touch `mri.test.js`, in different tests, and apply cleanly
   together. Combined, the only failure is the `stage.test.js` case that
   flips with C1-MRI; its flip is
   `~/cv_d3b_evidence/mri/c1mri/c1-mri-stage-test-flip.patch` (plan
   §11.8). Is that flip right?

## Ground rules (this machine is also the production server)

- **Don't run anything that connects to the database:** `node index.js`,
  `npm run ge_*`, `insight/cli.js`, `insight/cv/cli.js`,
  `insight/mri/cli.js` (any command), `migrations/run.js`, or
  `run_mri_insight` / `run_cv_insight` / `run_ct_insight` with a switch on
  and a real connection.
- DB-free commands are fine: the test files, `node --check`, and the
  harness. Run `hook_compare.sh` from its own directory (it refuses if a
  `.env` is there); if that directory is read-only for you, run a copy
  (it reads the real modules from `~/hep3/hhm_rpp_ge` by absolute path).
- Don't open or print `.env`. Don't modify files other than your findings
  file; report only.
- Don't touch `/home/prod/hhm_rpp_ge`, except reading
  `utils/logger/log.js` / `enums.js` there to compare the logger
  interface.
