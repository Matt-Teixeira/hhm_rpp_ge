# Review handoff: CV-5 step 1 (lock-free cores for the GE CV extract, derive and findings)

Everything is **uncommitted** on `dev` in `~/hep3/hhm_rpp_ge` (from
cab58d9). Please write your findings to `REVIEW-CV5-CORES-CODEX.md` next
to this file. Step 2 (the stage that uses these cores) has its own
handoff, `REVIEW-CV5-STAGE-HANDOFF.md`; review this one first.

```
cd ~/hep3/hhm_rpp_ge
git status --short
git diff insight/cv/load.js insight/cv/derive.js insight/cv/findings/run.js   # this step
git diff insight/cv/codes_reviewed.js insight/cv/test/cv.test.js PLAN-CV-INSIGHTS-CODES.md   # two codes reviewed (below)
node insight/cv/test/stage.test.js     # the "cores" tests are the first 8; no DB needed
node insight/cv/test/cv.test.js && node insight/cv/test/derive.test.js && node insight/cv/test/findings.test.js
```

**Out of scope; don't edit:** `PLAN-CV-INSIGHTS.md` (the design is §12,
agreed by the user 2026-11-12). Comment on design points in your findings.

**Don't run** `insight/cli.js`, `insight/cv/cli.js` (any command) or
`migrations/run.js`: this checkout's `.env` targets the production
database. The tests need no database.

## What this is

GE CV's apply paths each took the CV advisory lock (`insight_ge_cv`) on
their own connection. The CV-5 stage (plan §12.2) holds one lock for the
whole stage, so it needs the apply bodies without the lock, as CT §15.5
step 1 did for CT. The CLI keeps its behaviour by calling the same
bodies under its lock.

| File | New lock-free core | The CLI path now |
|---|---|---|
| `insight/cv/load.js` | `apply_range(conn, { job, start, end, max_batches, run_id, started_at, stats, log })`: the old apply body verbatim (catalog sync, late re-read, batches; watermark and stats advanced only after COMMIT). `extract_step(conn, …)`: the stage's extract: registry check, needs a watermark, from the watermark, **one batch by default**, returns `behind_ids` against the source max. | `run_extract` apply = lock, preflight, `apply_range` |
| `insight/cv/derive.js` | `derive_step(conn, pgp, { full, run_id, started_at, rebuild })`: the old apply body. **New:** reads the `ge_cv_extract` watermark first and, on success, writes it as the `ge_cv_derive` `watermark_id`. | `run_derive` apply = lock, preflight, `derive_step` |
| `insight/cv/findings/run.js` | `findings_step(conn, { replay, systems, list, today, run_id, started_at, log })`: the old apply body (catalog, one tx per system, job state on fleet-wide runs). **New:** on a successful fleet-wide run, the `ge_cv_findings` `watermark_id` = the `ge_cv_derive` watermark read first. The caller runs `preflight(conn, { mode: "apply" })`. | `run_findings` apply = lock, preflight, `findings_step` |

**Watermarks (§12.3 Q5).** CT keeps `ge_ct_extract` = `ge_ct_derive` =
`ge_ct_findings` after each run. CV had only the extract watermark
(derive works from a pending map; findings from the date). Now:
- `write_last_run` (derive): `watermark_id = coalesce($6::bigint, watermark_id)`,
  given only on success; an error keeps the old value.
- findings `WRITE_JOB_SQL`: `VALUES (…, coalesce($6::bigint, 0), …)` and
  `SET watermark_id = coalesce($6::bigint, job_state.watermark_id)`; given
  only on a successful fleet-wide run.
- Why reading the upstream watermark first is sound: all three hold the
  same advisory lock, so the extract can't advance during a derive, and
  extract records the touched days in the same transaction as each batch
  (`record_derive_pending`). When `derive_step` succeeds, every pending
  system has been derived, so derive covers that watermark. Findings'
  preflight refuses unless derive is caught up.
- No migration: `insight.job_state.watermark_id` exists (`NOT NULL DEFAULT 0`).

**Also in this step (data review, not code logic):** the local rehearsal
found two codes never seen before in the newest prod rows: 4800007 ("Empty
FOV List error", DL, WR, 2 rows) and 4800008 ("CORBA::NO_RESPONSE", DL,
AR, 1 row), SME02412, 2026-11-12. They are added to `codes_reviewed.js`
(counted in `cv.error` only, as 4800010 / 4800011). The list only drives
the "unreviewed codes" report; no fact changes. `cv.test.js` pins its size
(204 → 206).

## How it was checked

- **Tests** (no DB), `insight/cv/test/stage.test.js` (new, 25; the first
  8 are this step):
  - `apply_range`: a committed batch advances the watermark and stats,
    with the catalog sync as its own first transaction; a batch whose
    COMMIT fails leaves the error row and stats at the last committed
    batch.
  - `extract_step`: reads from the watermark to the source max (the batch
    query parameters are checked), one batch, `behind_ids`; refuses
    without a watermark.
  - `derive_step`: success writes the extract watermark; an error writes
    `null` (keep); nothing pending still records the run and the
    watermark; owed code labels are rebuilt.
  - `findings_step`: fleet-wide writes the derive watermark; a system
    selection writes no job state; a bad `today` is refused.
- **Every suite passes:** CV cv 16, derive 9, findings 18, stage 25; CT
  cv_scope 7, derive 14, derived 12, findings 31, load 3, rules 16, scrub
  3, stage 24; migrations m008 2, sqlscan 20; parsers 9 + 9 + 4 + 2 + 4 +
  13.
- **Mutation check** (each broken in turn, the stage suite failed, the
  file restored): derive watermark not written; findings watermark not
  written; stats shared before COMMIT; `extract_step` starting from 0.
- **Old vs new CLI, local throwaway PostgreSQL 14** (harness
  `~/cv_d3b_evidence/cv5/cmp_cli.js`; logs `cmp_old.json`,
  `cmp_new.json`):
  - Two clones of the same database (prod rows to 474223; CV state as of
    472938; one synthetic test row, id 472077, from an earlier session).
  - The CLI apply paths of HEAD (`git archive HEAD`) and of this change,
    each with `insight/db.js` stubbed to its clone: `run_extract` apply
    (1,285 rows), `run_derive` apply, `run_findings` default, `run_derive
    --full`, `run_findings --system SME08640`.
  - **The only difference** is the two new watermarks (`ge_cv_derive` and
    `ge_cv_findings`: 0 → 474223). The return values (timings removed),
    every fact, daily row, code, finding and catalog row, and every job
    stat are identical. 13 findings, 2 open: the same as prod.

## Questions for the review

1. Is anything in the old apply bodies changed beyond the lock removal
   and the two watermarks?
2. Can a derive or findings watermark ever claim more than was really
   derived or evaluated (CLI runs, errors, `--full`, `--system`, a run
   killed between transactions)?
3. `extract_step` needs an existing watermark, while `run_extract` apply
   starts from 0 without one. Is that the right split?
