# Review handoff: CV-1 schema (migration 007, GE CV insight tables and views)

Everything is **uncommitted** on `dev` (on top of 3d639db). Please write
your findings to `REVIEW-CV1-SCHEMA-CODEX.md` next to this file.

```
cd ~/hep3/hhm_rpp_ge
cat migrations/007_cv_schema.sql migrations/007_cv_schema.down.sql      # new
git diff -- migrations/lib/sqlscan.js migrations/lib/catalog.js migrations/run.js migrations/test/sqlscan.test.js
node --test migrations/test                                            # no DB needed
node migrations/run.js scan                                            # static scan only, no DB
```

**Out of scope; don't edit:**
- `PLAN-CV-INSIGHTS.md`. The design is in §6 and §7: read them for
  context, and comment on design points in your findings.
- `PLAN-CV-INSIGHTS-CODES.md` (generated evidence).

**Don't run** `migrations/run.js status|up|down|roundtrip`. The repo `.env`
targets the production database. The user runs the runner on prod.

## What 007 is for

GE CV (angio, INNOVA) gets its own insight tables, following GE CT
(001–006). The source is `log.ge_cv_syserror`, an error log with no exams
and no counters, from 2 live systems.

The user agreed the design (plan §2 item 2):
- own CV tables, one new migration;
- CV uses the shared `insight.metric_catalog` (keys `cv.*`),
  `finding_catalog` and `findings` (`source = 'ge_cv'`);
- **no CT table changes.**

The proposed metric mapping is in plan §6.2:
- every counted row gives a `cv.error` fact (dim = error code);
- at most one named metric;
- RTA relay rows are skipped.

The mapping is not decided yet. The schema has to hold it whatever the
user decides about the named metrics.

## The change

1. **`migrations/007_cv_schema.sql` / `.down.sql`**, new objects only:
   - `insight.ge_cv_facts` (+ id sequence, 3 indexes), not partitioned;
   - `insight.ge_cv_daily`;
   - `insight.ge_cv_codes`;
   - grants to `insight_writer`;
   - views `api.ge_cv_daily_v`, `api.ge_cv_capabilities_v` (computed
     from the facts, no table), `api.ge_cv_codes_v`, `api.ge_cv_findings_v`
     and `api.ge_cv_system_summary_v`.

   The down file drops the views, revokes, and drops the tables.
2. **Runner scope** (`migrations/lib/sqlscan.js`, `lib/catalog.js`, the
   messages in `run.js`): the allowed write scope and the catalog
   fingerprint's "in scope" set widen from `insight.*` + `api.ge_ct_*`
   to also include `api.ge_cv_*`. The regex is `^ge_c[tv]_`. Nothing else
   in the runner changes.
3. **Tests** (`migrations/test/sqlscan.test.js`), 3 new:
   - the scope (allowed and refused names, `inScope`);
   - 007's exact create set and the down file's exact drop set: no CT
     name, no row writes, shared tables only as FK targets or view
     sources;
   - the CV views filter `source = 'ge_cv'`; the cv.* CHECKs and the
     natural key are pinned.

## How it was checked (plan §7.2–7.3)

- **Tests and scan:** `node --test migrations/test` gives 20 of 20.
  `run.js scan` is ok for all 14 files, and 001–006 have the same
  checksums as applied on prod.
- **Local throwaway database** (PostgreSQL 14.11; prod is 16.15),
  socket only, run with the **real runner**:
  - 001–006 applied;
  - `roundtrip` of 007: after up, in-scope `+17 -0 ~0` (no existing
    object changed); after down, all 267 catalog objects identical;
  - dry run and `--apply`: clean.
- **The §6.2 mapping loaded as `insight_writer`:**
  - all 96,204 real rows gave 140,182 facts;
  - re-inserting a batch adds 0;
  - `api.ge_cv_capabilities_v` and `api.ge_cv_daily_v` (cv.error per
    system and code) equal independent counts on 17 of 17 and 297 of 297
    cells;
  - the CHECKs refuse a CT key and an untrimmed subsystem;
  - the writer cannot run DDL or TRUNCATE.

## Please look at

1. **Safety of the runner scope change.**
   - Can `^ge_c[tv]_` let a migration touch anything in `api` it
     shouldn't?
   - Is anything protected now treated as in scope? On prod today, `api`
     has only the 8 `ge_ct_*` views plus non-insight objects, and no
     `ge_cv*` object (checked read-only).
2. **"No CT change."** Does 007 change any existing object, its
   fingerprint or its behaviour?
   - The foreign keys to `insight.metric_catalog` add no constraint to
     that table's own fingerprint. They take a short SHARE ROW EXCLUSIVE
     lock at apply time. Is `lock_timeout` 5 s enough against the CT
     stage's catalog upsert?
3. **Natural key** `(system_id, host_datetime, sequencenumber,
   metric_key)`.
   - It is unique over all 96,204 rows. Sequence numbers reset per file;
     `host_datetime` comes from local date/time + the site zone
     (`America/Los_Angeles`).
   - Is there a realistic collision, such as the DST fall-back hour
     combined with a sequence reset? Should `errorcode` join the key
     instead?
4. **Unpartitioned facts.** About 140k rows for 6 months on 2 systems.
   CV joins as more systems' collection is restored (18 configured). Fine
   for years?
5. **Views:**
   - `api.ge_cv_daily_v` joins code labels with `k.errorcode::text =
     d.dim` and `d.metric_key = 'cv.error'`. Is that correct, and is
     there any cast hazard?
   - `api.ge_cv_capabilities_v` is a GROUP BY over the facts. Does a
     `WHERE system_id = …` push down? Checked locally (PG 14, 140k
     facts): yes, as an Index Cond on the natural key. The full view takes
     51 ms and the summary view 128 ms.
   - In `api.ge_cv_system_summary_v`, is the union and correlated-subquery
     shape fine?
6. **Down file:** does a roundtrip restore exactly? Is anything left
   behind? Sequence ownership goes with the table.
7. **Plan §7.4 C1–C3:** are these all the places where CV rows in shared
   tables (`metric_catalog`, `finding_catalog`, `findings`, `job_state`)
   would affect CT code or views? Did I miss any?
