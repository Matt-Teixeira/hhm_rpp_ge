# Review handoff: Phase 5 steps 1–3 (the ge_ct insight stage)

Repo: `hhm_rpp_ge`, branch `dev`. The change is **uncommitted** in the
working tree, on top of `defca24`. Nothing has been written to the database
by this code, and the repo's `index.js` (the `ge_ct` entry point) is **not**
changed yet: the hook is a later, separate step. The owner wants this review
**before** the stage rehearsal against prod.

## What to review

```
git status --short
git diff                      # cli.js, derive/daily.js, derive/index.js, derive/run.js, extract.js, findings/run.js, load.js, test/load.test.js
cat insight/index.js insight/stage.js insight/pending.js insight/verify_facts.js insight/test/stage.test.js
```

| File | Change |
|---|---|
| `insight/index.js` | new: `run_ct_insight(run_log, addLogEvent)`, the entry point the hook will call: kill switch, own pool, one lock, preflight, run_log events, never rejects |
| `insight/stage.js` | new: `run_stage` (extract → derive → findings), `stage_preflight`, step summaries/warnings, `rehearse_stage` |
| `insight/pending.js` | new: pending touched days (derive) and pending systems (findings) in `insight.job_state`, the daily-pass date, the facts-upsert `RETURNING` CTE |
| `insight/load.js` | lock-free `apply_batches` / `process_batch`; upsert now via the CTE and records touched days; late-commit re-read (`LATE_SQL`, `reread_late`); the stage's `extract_step`; `run_extract` (CLI) rebuilt on the cores |
| `insight/derive/run.js` | lock-free `derive_apply_core` (per system: derive, clear its pending days, mark it for findings); the stage's `derive_step` (touched scope from pending); `write_job` keeps `pending` |
| `insight/findings/run.js` | lock-free `findings_apply_core` (per system: findings, clear its pending mark); the stage's `findings_step` (pending systems, or all systems on a new UTC date); `write_job` keeps `as_of_by_system`, `pending_systems`, `fleet_today`; CLI fleet runs set `fleet_today` |
| `insight/verify_facts.js` | new: the `cli.js verify` computation, moved so the rehearsal can run it in its transaction |
| `insight/cli.js` | `stage --rehearse` (no `--apply`); `verify` uses `verify_facts` |
| `insight/extract.js`, `derive/daily.js`, `derive/index.js` | `ROW_COLUMNS` and `offset_breaks_sql(alias)` exported; comments |
| `insight/test/stage.test.js` | new, 18 tests; `load.test.js` updated for the CTE shape |

Background: `PLAN-CT-INSIGHTS.md` §15.2 (agreed design), §15.3 (agreed
answers: switch off by default; build the late-commit re-read; daily
all-systems pass on the first run of a new UTC date; at most one 50k batch
per run), §15.4 (exit criteria), §2 and §10 (stage contract, safeguards),
§13.5 / §14.7 (the derive and findings run paths this refactors).

## What the change does

**Stage** (`insight/index.js` → `stage.run_stage`), to be called once per
`ge_ct` run after the system loop:
- Returns at once, loading no module and logging nothing, unless
  `process.env.INSIGHT_ENABLED === "true"`.
- Connects as `insight_writer` (own pool, `statement_timeout` 120 s,
  `lock_timeout` 5 s), takes `pg_try_advisory_lock(hashtext('insight_ge_ct'))`
  for the whole stage (same key as the CLI); if held, logs and skips.
- Preflight: role is `INSIGHT_PG_USER` and not superuser, schema version
  >= 5, partition runway (warn < 6 months). Failure: WARN, skip.
- Steps, each only if the previous succeeded; a step failure is returned,
  logged as an ERROR event with the error, and the rest skipped:
  1. **extract**: catalog sync; the late-commit re-read; then at most one
     50k batch from the `ge_ct_extract` watermark (one transaction: facts,
     watermark, touched days).
  2. **derive**: scope = `ge_ct_derive.last_run_stats.pending`; one
     transaction per system (derive the touched days, delete the system's
     pending entry, add it to `ge_ct_findings.last_run_stats.pending_systems`);
     then the clock; then `ge_ct_derive` = the extract watermark.
  3. **findings** (default mode, never `--replay`): the pending systems; or,
     if the UTC date differs from `fleet_today` (the last fleet run's date),
     all systems, setting `fleet_today`. One transaction per system (findings,
     delete its pending mark); then `ge_ct_findings` = the derive watermark.
- One run_log event per step (counts, ms), WARN for a late commit caught,
  rule errors or findings drift; a summary event with the three watermarks.
- `job_state.last_run_id` = the `ge_ct` run log's `run_id` (a uuid).

**Touched days from the inserted keys** (§15.2 item 3). Each facts upsert is
`WITH up AS (INSERT ... ON CONFLICT ... DO UPDATE ... WHERE new version >
old RETURNING system_id, host_datetime, host_local) SELECT system_id,
device day, bool_or(offset breaks the 14 h invariant), count(*) GROUP BY`.
The rows are merged into `ge_ct_derive.last_run_stats.pending`
(`{system: [days] | "full"}`; offset break, a malformed day or > 31 days →
`"full"`) in the same transaction. The CLI `backfill --apply` records them
too; `derive --apply` (full) clears them per system.

**Late-commit re-read** (§15.3 Q2): every stage run, before the new batch,
re-reads gesys rows with `id <= watermark`, `capture_datetime >=
watermark_capture_datetime - 2 h`, and no fact with that `source_id`; runs
the rules; upserts (existing keys are no-ops); records touched days from
what was actually inserted. No watermark change.

**Rehearsal** (`cli.js stage --rehearse`): one transaction, rolled back,
under the lock. Run 1 (catch-up: the pending range before the last `ge_ct`
run, if any), run 2 (the last `ge_ct` run's rows: "typical"), run 3 (no new
rows, forced daily pass). Then on the uncommitted data: `verify_facts`,
`verify-derive`, `verify-findings`; derive content fingerprint after the
touched runs vs after a full rebuild of every system; findings fingerprint
after the default runs vs after a replay of every system as of the same
day. Each step's transactions are savepoints inside the outer one.

## Already verified by the author

- Tests, each file on its own: `insight/test/*.test.js` (stage 18, derive
  14, derived 12, findings 30, load 3, rules 16, scrub 3), `test/*.test.js`,
  `migrations/test/sqlscan.test.js`: all pass (Node v16.20.2, the prod
  runtime).
- Against prod, **read-only session only** (`default_transaction_read_only
  = on`, as `insight_writer`):
  - `EXPLAIN` (no ANALYZE: planned, not executed) of the upsert CTE, the
    pending-days upsert, both new `write_job` statements, and the three
    pending update/insert statements: all plan.
  - The actual `last_run_stats` merge expressions, evaluated on sample
    old/new values: `pending`, `as_of_by_system` and `pending_systems` are
    kept by every job write; `fleet_today` changes only when the run sets it;
    an error write keeps it (so the daily pass retries).
  - `LATE_SQL` at the current watermark: 945 rows without facts in
    60–140 ms; the rules produce 0 facts from them.
- **Not yet done:** any write-mode run (the rehearsal is the next step,
  after this review).

## Where to look hardest

1. **Never-throw / never-hang contract** (`insight/index.js`): can
   `run_ct_insight` reject, or leave the `ge_ct` process waiting (open pool,
   held lock, a statement with no timeout, `addLogEvent` rejecting,
   `connect` throwing synchronously, `$pool.end()` twice)? Is anything
   loaded or done when the switch is off?
2. **Touched-day completeness.** Is every fact the stage or the CLI can
   insert or replace recorded as pending in the same transaction? Is any
   path left that writes facts without it? Does `RETURNING` on `ON CONFLICT
   DO UPDATE ... WHERE` return exactly the inserted/replaced rows here
   (partitioned table)? Are derived facts' changed days still handled
   (`derive_system` → `add_days`)?
3. **Late-commit re-read** (`load.js` `LATE_SQL`, `reread_late`): can it
   miss a late-committed row it is meant to catch (window anchor, `id <=`,
   duplicates whose facts sit under another `source_id`)? Can it insert
   anything it shouldn't? Rows that `build_facts` skips are re-read every
   run: any cost or correctness issue?
4. **Failure and self-healing.** For a failure at each point (mid-batch,
   mid-derive after some systems committed, the clock, mid-findings, the
   daily pass, a job_state write), does the next run redo exactly the
   missing work, and do the three watermarks end equal after it? Can a
   watermark advance past work that wasn't done (e.g. derive's watermark
   written while a system's pending entry is still there)?
5. **job_state merges** (`WRITE_JOB_SQL` in derive and findings,
   `pending.js`): ordering of the `||` merges; the read-merge-write of
   `pending` (relies on the lock plus `FOR UPDATE`); the fallback for the
   pre-Phase-5 row in `fleet_today_of`; any CLI path that could now erase
   or corrupt pending state.
6. **Daily trigger**: `today` is the UTC date of the stage start. Behaviour
   around 00:00 UTC, a skipped or failed daily run, and a `cli.js findings
   --apply` (fleet) run on the same day.
7. **CLI unchanged**: `run_extract`, `run_derive`, `run_findings` were
   rebuilt on the cores. Any change in what they write or print, beyond the
   documented bookkeeping (pending days, pending systems, `fleet_today`)?
   (`derive --apply` used `scope_full([s])` per system, now one shared
   `scope_full(list)`.)
8. **Rehearsal proofs** (`stage.js` `rehearse_stage`): do "derive touched =
   full rebuild" and "findings default = replay" prove what they claim?
   Could the rehearsal pass while the live per-run behaviour differs
   (savepoints vs real per-system commits, the forced daily run, the
   `caught_up` check, the "last ge_ct run" split by a 15-minute capture
   gap)?
9. **Per-run ceiling**: `apply_batches` with `max_batches = 1` stops after
   one committed batch; anything that can loop or read further?

Out of scope: the §15.2 design and §15.3 answers are settled (switch off by
default; re-read 2 h; daily pass on a new UTC date; one batch per run;
digest deferred). Raise a concern only if the code contradicts them. The
`index.js` hook itself is not written yet.

## Ground rules (this machine is also the production server)

- **Don't run anything that connects to the database**: anything under
  `insight/cli.js`, `insight/tools/*`, `migrations/run.js
  status|up|down|roundtrip`, and don't call `run_ct_insight` with
  `INSIGHT_ENABLED=true` outside the tests' fakes.
- DB-free commands are fine: the test files, `node migrations/run.js scan`,
  and `node -e` probes that only `require` modules and call pure functions
  (or the stage with fake `connect` / `stage`, as `stage.test.js` does).
- Don't open or print `.env`. Don't modify files. Report only.
- Don't touch `/home/prod/hhm_rpp_ge`.

## How to report

Write findings to `REVIEW-PHASE5-STAGE-CODEX.md` in the repo root, in the
same format as `REVIEW-PHASE4-RUN-VERIFY-CODEX.md`: one `### F<n> — title`
section per finding, each with Severity (high / medium / low), Confidence
(confirmed / likely / possible), Location (`file:line`), What's wrong,
Failure scenario, Evidence (probe or code reading), Suggested fix. Order
most severe first. If you find nothing, say so explicitly.
