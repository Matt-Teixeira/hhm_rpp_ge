# Review handoff: Phase 3 checkpoint 4 (derive run, verify-derive, CLI)

Repo: `hhm_rpp_ge`, branch `dev`.

**Range to review: `5bf5098..bb8cedd`.** The checkpoint 3 stages were
reviewed separately (`REVIEW-PHASE3-DERIVE-STAGES-CODEX.md`) and are not
in this range.

**Unlike earlier reviews, this code has already run against the prod
database:**
- `node insight/cli.js derive --apply` committed the derived tables on
  2026-11-04 13:56 UTC.
- `node insight/cli.js verify-derive` passed every check.

A finding here may mean the data needs rebuilding. That is cheap: derive
rebuilds the tables idempotently, and the fix would go through a rolled-
back rehearsal, then `--apply`, then verify. Please say for each finding
whether you think the **data already written** is affected, or only
future runs.

```
git diff 5bf5098..bb8cedd --stat
git diff 5bf5098..bb8cedd -- insight/
git show bb8cedd -- PLAN-CT-INSIGHTS.md     # plan update (§13.5 and Status)
```

| File | What |
|---|---|
| `insight/derive/run.js` | new: `run_derive`, rehearse / apply orchestration |
| `insight/derive/verify.js` | new: the §13.3 exit checks against independent SQL |
| `insight/cli.js` | `derive --rehearse \| --apply [--system S \| --systems A,B]`, `verify-derive` |
| `insight/derive/derived_facts.js` | insert vs update now told from the pre-upsert key set (see below) |
| `insight/test/derive.test.js` | updated tests |
| `PLAN-CT-INSIGHTS.md` | Status entry and new §13.5 (as built, results, follow-ups) |

Background:
- `PLAN-CT-INSIGHTS.md` §13.2 (decisions), §13.3 (exit criteria), §13.5
  (what was built and why), §10 (prod safeguards).
- `insight/load.js` holds the Phase 2 extract path and the shared
  advisory-lock key.
- `insight/derive/index.js` is the stage orchestrator from checkpoint 3,
  already reviewed.

## Intended behaviour

**`run_derive(db, { mode, systems, now, run_id, log })`**, connected as
`insight_writer`:
- Takes a **session-level** `pg_try_advisory_lock` on the same key as the
  extract (`load.js` `LOCK_KEY`). If the lock is held, it skips. It
  unlocks in `finally`.
- **Preflight:** connected as the limited user; schema version ≥ 4.
- **Rehearse:** one transaction, ended by throwing so it rolls back:
  1. sync the catalog;
  2. **pass 1:** full rebuild of every selected system, then the clock;
  3. **pass 2:** the identical rebuild again. It must report 0 derived-fact
     inserts, updates or deletes, and the table fingerprint
     (`FINGERPRINT_SQL`: md5 over ordered row text, excluding
     `updated_at`) must be unchanged;
  4. **pass 3:** a touched-days rebuild over the days touched by the last
     150,000 gesys ids (`touched_from_source_range`). The fingerprint
     must equal pass 1's;
  5. `run_verify` inside the transaction;
  6. rollback.

  The CLI then reads the table counts on a fresh connection, to show
  they're back to their prior state.
- **Apply:**
  - sync the catalog in its own transaction;
  - one transaction per system, then the clock in its own transaction;
  - after a fleet-wide run, upsert `insight.job_state` `ge_ct_derive` with
    `watermark_id` = the extract watermark read at the start. That is the
    point the Phase 5 stage will compute touched days from.
  - A run limited with `--system` / `--systems` doesn't write
    `job_state`.
  - On an error: earlier systems stay committed, and `job_state` records
    status `error` while keeping the previous watermark.

**`run_verify(db)`** works on any connection or transaction. Each check
returns pass/fail and detail lines:
- **Tube:**
  - `tube.replacement` facts vs the independent `RESETS_SQL`: keys,
    calibration count, confidence;
  - acceptance against the hard-coded §13.1 list (UTC reset day,
    confidence);
  - every replacement has a tube source;
  - segments agree with the replacement facts: per-system count, one
    current segment, confidence / install_date / tube_source, none
    negative.
- **Boots:**
  - `system.boot` facts vs `BOOTS_SQL`: keys and clean/unclean;
  - the SME18531 restart-loop window has 0 boots and at least 1,000
    inits;
  - boots/shutdowns ratios outside 0.8–1.25 are **listed, not failed**
    (the user accepted this tolerance).
- **Exams:** re-derived set-based. A running count of starts assigns
  every event to its exam; a window count gives `reopened`; DISTINCT ON
  picks the last series. Compared with `ge_ct_exams` on every column;
  at least 95% must have a series summary.
- **Daily:** re-aggregated with a separately written `dim` expression
  (LIKE `xfer.%` / `ipc.%`, `numeric::text` for ermes codes) and DISTINCT
  ON for "last". Compared on n / sum / min / max / last / last_at.
- **Capabilities:** a plain GROUP BY, compared.
- **Clock:** the `ahead` set must equal the §13.3 list.
- **Invariants:** no fact more than 14 h between `host_datetime` and
  `host_local`; catalog rows = 37 per-row + 2 derived.

**`derived_facts.js` change.** The first rehearsal failed with "cannot
retrieve a system column in this context": PostgreSQL won't return
`xmax` from `INSERT ... ON CONFLICT` on a partitioned table. Insert vs
update is now classified by `classify_upserts`, against the system's
derived-fact keys loaded before the upsert. Only the counts and the
changed days depend on it.

## Results already obtained (by the author)

| Run | Result |
|---|---|
| Rehearsal pass 1 | 3,393 derived facts, 103,985 daily, 41,826 exams, 42 segments, 659 capabilities, 28 clock |
| Rehearsal pass 2 | 0/0/0 derived changes; no table changed |
| Rehearsal pass 3 | 28 systems, 439 days, identical to the full rebuild |
| Rehearsal verify | all PASS; after rollback, every derived table read 0 |
| Apply | the same counts; 35 transactions committed (34 systems + clock) |
| `verify-derive` | ALL CHECKS PASS |
| Phase 2 `verify` | 621/621 |
| Tests | all files pass, including `derive.test.js` (12) |

## Where to look hardest

1. **Locking and transactions (`run.js`).**
   - Is the session-level advisory lock really held for the whole run, on
     the same connection as the work (`db.task`)?
   - Is it always released, including on errors inside `conn.tx`, and
     when the rehearsal ends by throwing?
   - Could the rehearsal commit anything (catalog sync, clock) outside
     its single transaction?
   - Apply: is the partial-failure state consistent, and is the
     `job_state` handling right? Should a failed run leave `watermark_id`
     at its previous value?
2. **Watermark semantics for Phase 5.** `ge_ct_derive.watermark_id` is
   the extract watermark read at the start of a fleet-wide apply.
   - Is that a correct "derive has covered facts up to here" marker, given
     that extract holds the same lock?
   - Any way facts below it could be left un-derived?
3. **What the rehearsal actually proves.**
   - Pass 3 re-derives the touched days of existing facts. It does not
     simulate new facts arriving. Is that a meaningful check of the
     incremental path? What would a stronger one be, still DB-only,
     rolled back, and as `insight_writer`?
   - `FINGERPRINT_SQL` covers derived facts, daily, exams, segments and
     capabilities, but **not `system_clock`**. Does that matter?
   - Is md5 over `x::text` stable for doubles and `jsonb` within one
     session?
4. **Is `verify.js` independent and strict enough?**
   - Any check that would pass on wrong data?
   - Any shared blind spot with the derive code? Same ordering keys, the
     `dim` mapping, `images` falling back to `value_num`, `numeric::text`
     vs `::bigint::text` for ermes codes, NULL handling in the
     `IS DISTINCT FROM` comparisons.
   - The exams SQL's running-count assignment vs the JS window logic,
     including events before the first start and same-second records.
   - Pass criteria: the boot ratio is deliberately not a failure; the
     clock compares only the `ahead` set; the restart-loop guard is
     `inits < 1000`.
   - The hard-coded acceptance lists, `EXPECTED_REPLACEMENTS` and
     `EXPECTED_CLOCK_AHEAD`. They make verify fail when the fleet changes
     (intended, and documented in §13.5). Is that the right design, or
     should acceptance be separate from the ongoing consistency checks?
5. **`classify_upserts`.** Is it correct? Key format: `host_datetime` as
   a `Date` vs an ISO string, epoch / rnc types from `pg`. Could it
   misreport, and does anything other than stats and changed days depend
   on it?
6. **CLI.**
   - Argument parsing: `--system` vs `--systems`, and a missing value
     after the flag.
   - The confirmation flow and exit codes.
   - `verify-derive` is read-only: `connect("readonly")` plus the explicit
     `default_transaction_read_only` check.
7. **Plan accuracy.** Does `PLAN-CT-INSIGHTS.md` §13.5 and the Status
   entry describe what the code does? Flag any claim the code doesn't
   support.

Out of scope: the decisions in plan §9, §12 and §13.2; the user's
tube-source rule; and the user's acceptance of the boot tolerance
(2026-11-04). Raise a concern only if the code contradicts them.

## Ground rules (this machine is also the production server)

- **Don't run anything that connects to the database.** That includes
  `insight/cli.js` (every command, including `verify-derive`),
  `insight/tools/*` and `migrations/run.js` except `scan`.
- DB-free commands are fine: the test files (`node insight/test/*.test.js`,
  `node test/*.test.js`, `node migrations/test/sqlscan.test.js`).
- Don't open or print `.env`.
- Don't modify files. Report only.
- Don't touch `/home/prod/hhm_rpp_ge`.

## How to report

Write findings to `REVIEW-PHASE3-RUN-VERIFY-CODEX.md` in the repo root,
in the format of `REVIEW-CT-INSIGHTS-CODEX.md`: one `### F<n> — title`
section per finding, each with:
- Severity: high / medium / low
- Confidence: confirmed / likely / possible
- Location: `file:line`
- What's wrong
- Failure scenario
- Evidence (say whether you ran a probe or read the code)
- Suggested fix
- **Data impact:** written data affected / future runs only / none

Order findings most severe first. If you find nothing, say so explicitly.
