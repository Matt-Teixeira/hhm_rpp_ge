# Review handoff: Phase 5 step 5 (the `index.js` hook for the insight stage)

Repo: `hhm_rpp_ge`, branch `dev`. The change is **uncommitted** in the
working tree, on top of `45c2ab2` (the stage itself, already reviewed in
`REVIEW-PHASE5-STAGE-CODEX.md`; F1–F2 fixed there). This is the **only**
Phase 5 change outside `insight/`, and it runs inside the production
`ge_ct` ingest process (`npm run ge_ct` = `node index.js GE_CT`, every
30 min). Nothing is deployed.

## What to review

```
git diff index.js
cat insight/index.js            # run_ct_insight, the function the hook calls
```

The whole change (13 lines added to `on_boot()`, after the system loop,
before the run log is printed and written):

```js
    // GE CT insight stage (PLAN-CT-INSIGHTS.md §15): runs after every
    // system's ingest has finished; off unless INSIGHT_ENABLED=true; logs to
    // run_log and never fails the run.
    if (shell_value[0] === "GE_CT") {
      try {
        const { run_ct_insight } = require("./insight");
        await run_ct_insight(run_log, addLogEvent);
      } catch (error) {
        await addLogEvent(E, run_log, "run_ct_insight", cat, null, error);
      }
    }
```

Background: `PLAN-CT-INSIGHTS.md` §2 (stage at the end of `ge_ct`, no new
cron line), §10 (existing behaviour stays byte-for-byte: `log.ge_ct_gesys`
inserts, Redis, `offline_hhm_conn`, `extract_tube_usage`), §15.2 item 1
(called from `on_boot()` after the system loop, `GE_CT` only, its own
try/catch, logs to `run_log`, never fails the run), §15.3 Q1 (off unless
`INSIGHT_ENABLED=true`), §15.4 (ingest unaffected with the switch off and on).

## Contract the hook relies on (`insight/index.js`)

- `run_ct_insight(run_log, addLogEvent)` returns `{ skipped: "disabled" }`
  at once unless `process.env.INSIGHT_ENABLED === "true"`; the module has no
  top-level `require`, so with the switch off nothing else is loaded and no
  connection is opened.
- It never rejects: every failure is an `addLogEvent(ERROR, ...)` call; its
  own pool (insight_writer, connect timeout 10 s, statement 120 s, lock 5 s,
  client query backstop 135 s) is closed in `finally`.
- `addLogEvent` is the repo's `utils/logger/log.js` (gitignored; the prod
  copy at `/home/prod/hhm_rpp_ge` has the same signature
  `(type, run_log, func, tag, note, err)`; for type `ERROR` it reads
  `err.stack`). `utils/logger/enums.js` is identical in dev and prod.

## Already verified by the author

- **Ingest is finished when the hook starts.** In `jobs/CT/index.js` and
  `jobs/CT/gesys_parser.js` every ingest step is awaited inside the loop:
  the `log.ge_ct_gesys` insert, `extract_tube_usage`, the Redis updates
  (file size, header key), the `alert.offline_hhm_conn` upsert, and
  `gzip_n_save`. `run_job` catches its own errors.
- **Harness** (DB-free; loads the real `index.js` with recorders for
  `./jobs`, `./utils/db/pg-pool`, `./acquisition/on_boot_queries` and
  `./utils/logger/log`; three fake CT systems). Compared to the committed
  `index.js` (`git show HEAD:index.js`):

  | Scenario | Ingest calls/order | Run-log events | Other difference |
  |---|---|---|---|
  | new, switch unset | identical | identical | loads `insight/index.js` only |
  | new, `INSIGHT_ENABLED=false` | identical | identical | same |
  | new, on (stage stubbed) | identical | +1 stage event | stage starts after 3/3 systems ingested, before `writeLogEvents` |
  | new, on, stage throws | identical | +1 ERROR `run_ct_insight` | log still written |
  | new, on, `require("./insight")` fails | identical | +1 ERROR | log still written |
  | new, `GE_MRI`, on | identical | identical | stage not called, nothing loaded |

  Harness: `/tmp/claude-1018/-home-matt-teixeira-hep3-hhm-rpp-ge/b4b83226-7f89-4475-9f92-d261a5a6f61a/scratchpad/hook_harness.js`
  (usage at its top: `INSIGHT_ENABLED=... node hook_harness.js <index file> <scenario>`;
  scenarios `off`, `on_stub`, `on_throws`, `on_require_fails`, `mri_on`).
  It never opens a DB connection: every scenario with the switch on stubs
  `./insight`. It loads `.env` through `dotenv` into the process
  environment (not printed).
- The real stage was rehearsed against prod in one rolled-back transaction
  (all checks OK; a typical run ~9 s) and has 22 unit tests
  (`insight/test/stage.test.js`). `node --check index.js` and every test file
  pass.

## Where to look hardest

1. **Can the hook change ingest in any way**, with the switch off or on:
   timing or order of anything ingest does, the Redis client, the main
   `pgPool`, `run_log` contents seen by ingest, the process exit (open
   handles: the insight pool, timers), unhandled rejections?
2. **Can it fail the run or lose the run log?** E.g. `addLogEvent` throwing
   inside the hook's catch, `require("./insight")` failing, a synchronous
   throw, the stage taking long: the log is only written after the stage.
3. **Placement:** after the loop and inside `on_boot()`'s try, before
   `console.log(run_log.log_events)` / `writeLogEvents`. If the systems query
   or the loop throws, the stage doesn't run: acceptable? Is
   `shell_value[0] === "GE_CT"` the right guard (`shell_value =
   [process.argv[2]]`)?
4. **Overlap with the next `ge_ct` run** (every 30 min; a run's ingest is
   ~20–40 s, the stage ~9 s, at most ~minutes under its timeouts): any
   interaction between this run's stage and the next run's ingest (locks on
   `log.ge_ct_gesys`, the advisory lock, connection limits)?
5. **Prod differences:** anything in the prod checkout's environment that
   would make the hook behave differently (gitignored `utils/`, `.env`
   loading order: `index.js` loads `.env` from the working directory,
   `insight/db.js` from the repo root)?

Out of scope: the stage's internals (reviewed in `REVIEW-PHASE5-STAGE-CODEX.md`)
unless the hook's use of them is wrong.

## Ground rules (this machine is also the production server)

- **Don't run anything that connects to the database**: `node index.js`
  (it would ingest into prod), `npm run ge_*`, anything under
  `insight/cli.js`, `insight/tools/*`, `migrations/run.js
  status|up|down|roundtrip`, or `run_ct_insight` with
  `INSIGHT_ENABLED=true` and a real connection.
- DB-free commands are fine: the test files, `node --check`, the harness
  above (with `./insight` stubbed whenever the switch is on), and `node -e`
  probes over pure modules.
- Don't open or print `.env`. Don't modify files. Report only.
- Don't touch `/home/prod/hhm_rpp_ge`, except reading
  `utils/logger/log.js` / `utils/logger/enums.js` there to compare the
  logger interface.

## How to report

Write findings to `REVIEW-PHASE5-HOOK-CODEX.md` in the repo root, in the
same format as `REVIEW-PHASE5-STAGE-CODEX.md`: one `### F<n> — title`
section per finding, each with Severity (high / medium / low), Confidence
(confirmed / likely / possible), Location (`file:line`), What's wrong,
Failure scenario, Evidence (probe or code reading), Suggested fix. Order
most severe first. If you find nothing, say so explicitly.
