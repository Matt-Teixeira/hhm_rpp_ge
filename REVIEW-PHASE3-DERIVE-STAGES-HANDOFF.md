# Review handoff: Phase 3 checkpoint 3 (the `insight/derive/` stages)

Repo: `hhm_rpp_ge`, branch `dev`. The change is **uncommitted** in the
working tree, on top of `46362ea`. Nothing has been written to the
database. **None of the write paths here has run yet**: that first
happens in the checkpoint 4 rehearsal (one transaction as
`insight_writer`, rolled back). This review is the main check on the
write code before then.

## What to review

```
git status --short    # 3 modified, 9 new files
git diff              # modified files
```

| File | What |
|---|---|
| `insight/derive/index.js` | orchestrator: preflight, scope builders, `derive_system` (stages 1–5 per system) |
| `insight/derive/common.js` | fact loader, ordering, chunked insert, scope helpers |
| `insight/derive/derived_facts.js` | stage 1: write `system.boot` / `tube.replacement` facts |
| `insight/derive/daily.js` | stage 2: `insight.ge_ct_daily` (SQL), including `dim` |
| `insight/derive/exams.js` | stage 3: `insight.ge_ct_exams` (pure builder + write) |
| `insight/derive/tube_segments.js` | stage 4: `insight.ge_ct_tube_segments` |
| `insight/derive/capabilities.js` | stage 5: `insight.system_capabilities` |
| `insight/derive/clock.js` | stage 6: `insight.system_clock` (fleet-wide, reads `log.ge_ct_gesys`) |
| `insight/test/derive.test.js` | new: 9 tests (pure parts) |
| `insight/rules/ge_ct_derived.js` | `find_resets` also returns a trailing `pending` reset |
| `insight/test/derived.test.js` | tests for `pending` |
| `insight/load.js` | exports `FACT_CS` (no behaviour change) |

**Not built yet (checkpoint 4):** the CLI that calls this. The planned
caller is `cli.js derive --rehearse` (all systems in one rolled-back
transaction) and `--apply` (one transaction per system, under the same
advisory lock as extract). Review the functions as if called that way.

Background: `PLAN-CT-INSIGHTS.md`:
- §13.2 (agreed decisions: items 1, 3, 4, 5)
- §13.3 (exit criteria)
- §13.4 step 3
- §6 (stage order, upsert semantics)
- §10 (prod safeguards)

Schema: `migrations/001_insight_schema.sql`, `003_*.sql`,
`004_phase3_derive.sql` (all applied). The derived-fact rules themselves
(`insight/rules/ge_ct_derived.js`) were reviewed at checkpoint 2
(`REVIEW-PHASE3-DERIVED-CODEX.md`). Only the `pending` change there is
new.

## Intended behaviour

Scope is a Map from `system_id` to either `{ full: true }` or
`{ days: Set<'YYYY-MM-DD'> }`, where days are device wall-clock days
(`host_local`). The Phase 5 stage will build it from the gesys id range
an extract run covered (`touched_from_source_range`).

Per system, in order:
1. **Derived facts.** Recomputed over the system's whole history, then
   written as a replacement set:
   - upsert on the facts natural key, updating only when a column differs
     (`IS DISTINCT FROM`);
   - delete the system's derived facts that are no longer derived
     (`NOT IN (unnest(...))`);
   - return the device days that changed, which are added to the
     system's touched days.
2. **Daily.**
   - Full: delete the system's rows and re-aggregate.
   - Touched: delete and re-aggregate those days only, with a
     `host_datetime` ± 2–3 day bound so the scan can use the index and
     partition pruning.
   - Aggregates: `n`; sum over `numeric` (exact, independent of order);
     min; max; last by (`host_datetime`, `epoch`, `rnc`) descending;
     `last_at`.
   - `dim` per §13.2 item 3. `ipc.sigpipe` has no status, so its `dim` is
     always `''`.
3. **Exams.**
   - One row per `exam.start`; the window runs to the next start in
     (time, epoch, rnc) order, and the last exam's window is open.
   - Counts come from the last `exam.series` in the window; aborts are
     counted in the window.
   - `reopened` = this `exam_no` was started before (looked up across all
     of the system's starts).
   - Touched: rebuild from the last start whose device day is before the
     earliest touched day.
4. **Tube segments.** Whole history. Split at the confirmed resets.
   - The first segment is `initial`; later ones copy confidence /
     install_date / tube_source from the replacement fact that opened
     them.
   - A trailing pending reset is excluded from the current segment and
     noted in its evidence.
5. **Capabilities.** Whole history, one GROUP BY; derived metrics
   included.

Once per run:

6. **Clock.**
   - 30-day trailing window ending at the `now` passed in.
   - Per capture, lag = `capture_datetime` − the newest `host_datetime`
     in it.
   - Flags: `ahead` if p10 < 0 (estimate = −p10); `lagging` if p10 > 45;
     `jumps` if min < −5; else `ok`.
   - Fewer than 5 captures: no row. Rows are upserted; a system with no
     captures keeps its old row.

## Already verified (by the author, read-only)

Every stage's computation was run over the whole fleet without writing.
The SQL stages were run as SELECT only.

| Check | Result |
|---|---|
| Exams | 41,826 rows = distinct starts in facts; 99.91% have a series summary |
| Tube segments | 42: 34 `initial` + 7 `confirmed` + 1 `counter_only`; none negative |
| Clock `ahead` | exactly SME16618, SME21873, SME21929, SME11229 (the §13.3 list) |
| Daily | 101,277 rows from per-row facts |
| Derived rules | JS vs independent SQL: 3,385 boots and 8 resets, 0 differences |

Also:
- **Timestamps:** all `host_datetime` values of the derived-fact sources
  are whole seconds. That matters because derived facts carry
  `host_datetime` through a JS `Date`, which keeps milliseconds.
- **Tests:** all pass, including the new `derive.test.js` (9) and
  `derived.test.js` (12).

## Where to look hardest

1. **The derived-fact write (stage 1).** This is the riskiest part.
   - Is the replacement-set logic right? Upsert, then
     `DELETE ... NOT IN (SELECT * FROM unnest($3::integer[],
     $4::integer[], $5::text[], $6::timestamptz[]))`.
   - Could it ever delete a per-row fact? It is limited to
     `metric_key = ANY(DERIVED_KEYS)` and the system.
   - Is it correct when the new set is empty? Arrays and `NOT IN`
     behaviour.
   - Does `RETURNING (xmax = 0) AS inserted` work for
     `INSERT ... ON CONFLICT` on a **partitioned** table in PostgreSQL 16?
     If not, what fails, and how?
   - Can a timestamp lose precision anywhere between load and write
     (`Date`, ISO strings, `pgp` formatting)? That would make the key
     differ.
2. **Incremental correctness.** For each stage, does a touched rebuild
   give the same table contents as a full rebuild would, given the facts?
   - Daily: does a day that now has no facts lose its rows? Are the
     ±2/3-day `host_datetime` bounds safe for every device-clock offset?
   - Exams: anchor choice, `DELETE ... started_at >= anchor`, and events
     loaded from the anchor time (same-second events belonging to the
     previous exam).
   - Derived facts' changed days, including deletes, are folded into the
     daily scope.
3. **Exams vs §13.2 item 5.** Are "last `exam.series` before the next
   start" and "aborts in that window" implemented exactly? Check the
   pointer logic in `build_exams` and the `local_day` source.
4. **Tube segments.**
   - Segment boundaries vs the `tube.replacement` facts.
   - `segment_end` / `ended_reason` against the table's CHECK constraint.
   - The unique index allowing one current segment per system.
   - `mas_per_day` when the span is under a day.
   - The initial segment's tube-source window.
5. **Clock.**
   - Percentile and NULL handling.
   - Keeping stale rows for systems that stop reporting: right, or
     misleading?
   - Is the `log.ge_ct_gesys` query bounded enough? It is partitioned on
     `capture_datetime` and the stage runs once per run.
6. **Constraints and types.** Will any insert violate a CHECK, NOT NULL
   or PK on real data?
   - Exams: `last_activity_at >= started_at`, counts ≥ 0, and the PK
     (system, exam_no, started_at).
   - Segments: `readings > 0`, `start_mas` NOT NULL.
   - Daily: the key with `dim`.
   - `local_day` / `install_date` cast as text dates.
7. **Scale.** SME01434 has about 905k facts, and one daily group of 419k
   facts (`array_agg ORDER BY`). SME18531 has about 38k inits. Anything
   quadratic or memory-heavy?
8. **Safety.** Every write targets `insight.*` only. No statement can
   touch `log.*` or `public.*` beyond the clock's SELECT. All SQL is
   parameterised (`dim_sql` builds literals with `pgp.as.format`).

Out of scope: the decisions in plan §9, §12 and §13.2, and the user's
2026-11-04 tube-source rule, are settled. Raise a concern only if the
code contradicts them.

## Ground rules (this machine is also the production server)

- **Don't run anything that connects to the database.** That includes
  `insight/cli.js` (all commands), `insight/tools/*` and
  `migrations/run.js` except `scan`.
- DB-free commands are fine: `node insight/test/derive.test.js`,
  `node insight/test/derived.test.js` and the other test files.
- Don't open or print `.env`.
- Don't modify files. Report only.
- Don't touch `/home/prod/hhm_rpp_ge`.

## How to report

Write findings to `REVIEW-PHASE3-DERIVE-STAGES-CODEX.md` in the repo
root, in the format of `REVIEW-CT-INSIGHTS-CODEX.md`: one
`### F<n> — title` section per finding, each with:
- Severity: high / medium / low
- Confidence: confirmed / likely / possible
- Location: `file:line`
- What's wrong
- Failure scenario
- Evidence (say whether you ran a probe or read the code)
- Suggested fix

Order findings most severe first. If you find nothing, say so explicitly.
