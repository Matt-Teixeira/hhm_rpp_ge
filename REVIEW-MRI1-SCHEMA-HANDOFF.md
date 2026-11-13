# Review handoff: MRI-1 schema (migration 009, GE MRI insight tables)

Everything is **uncommitted** on `dev` (on top of 42a2f92). Please write
your findings to `REVIEW-MRI1-SCHEMA-CODEX.md` next to this file.

```
cd ~/hep3/hhm_rpp_ge
cat migrations/009_mri_schema.sql migrations/009_mri_schema.down.sql    # new
cat migrations/test/m009.test.js                                       # new
node --test migrations/test                                            # no DB needed
node migrations/run.js scan                                            # static scan only, no DB
```

**For comparison:** `migrations/001_insight_schema.sql` and `003_*.sql`
(the partitioned CT facts) and `007_cv_schema.sql` (the CV tables).

**Out of scope; don't edit:**
- `PLAN-MRI-INSIGHTS.md`. The design is in §2, the agreed mapping in §5,
  and 009 in §6. Read them for context, and comment on design points in
  your findings.
- `PLAN-MRI-INSIGHTS-CODES.md` (generated evidence).

**Don't run** `migrations/run.js status|up|down|roundtrip`. The repo `.env`
targets the production database, and the user runs the runner on prod.
Don't run anything else that connects with the repo `.env` either: GE CV's
stage is in a monitoring window until 2026-11-19.

## What 009 is for

GE MRI gets its own insight tables, following CT (001–006) and CV (007).
The source is `log.ge_mri_gesys`: the same gesys format and natural key as
CT, `(system_id, epoch, record_number_concurrent)`, where `epoch` is the
device wall clock in seconds, not UTC. It has 17 systems with data, 6 of
them current, and about 330k deduped records since 2025-05.

**Agreed with the user** (plan §3, §5.3):
- own MRI tables in one new migration;
- MRI uses the shared `insight.metric_catalog` (keys `mri.*`),
  `finding_catalog` and `findings` (`source = 'ge_mri'`), and `job_state`
  (jobs `ge_mri_*`);
- **no CT or CV change**;
- a CV-style code mapping: every record gives `mri.error` (dim = message
  code), plus 22 named metrics (at most two per record);
- the facts key on the CT natural key + metric, so the 45k old duplicate
  source rows dedupe;
- **009 writes no rows:** the catalog comes from the registry, as CV;
- **no `api` views yet:** they come with the viewer, with a runner scope
  change.

## The change

1. **`migrations/009_mri_schema.sql` / `.down.sql`**, new objects only:
   - `insight.ge_mri_facts` (+ id sequence, 2 indexes), **partitioned by
     range on `host_local`** (device wall clock), with 44 monthly
     partitions 2025-05 … 2028-12 and no default partition;
   - unique key `(system_id, epoch, record_number_concurrent, metric_key,
     host_local)`, with `CHECK (host_local = timestamp '1970-01-01' +
     epoch * interval '1 second')`;
   - `CHECK (metric_key LIKE 'mri.%')` on facts and on daily;
   - `insight.ge_mri_daily` (device day; CHECK that `first_at` / `last_at`
     fall on `local_day`);
   - `insight.ge_mri_codes` (masked labels; `category` in the six reviewed
     groups or NULL);
   - grants to `insight_writer`.

   The down file revokes, then drops the three tables (partitions and
   sequence go with them).
2. **Tests:** `migrations/test/m009.test.js`, 7 new:
   - the exact create set: no drop, no other ALTER, grants and comments
     only on `ge_mri_*`, no CT / CV / `log` / `public` / `alert` / `api`
     name, no row writes;
   - partitions contiguous and zone-less;
   - keys and CHECKs pinned;
   - grants and revokes exact;
   - down drops exactly three tables;
   - 001–008 sha256 equal prod's `schema_migrations`;
   - the runner scope is unchanged.
3. **Nothing else.** The runner (`migrations/lib`, `run.js`) and 001–008
   are untouched.

## How it was checked (plan §6.2–6.3)

- **Tests and scan:** `node --test migrations/test` gives 29 of 29.
  `run.js scan` is ok for all 18 files. The CT and CV suites still pass.
- **Local throwaway database** (PostgreSQL 14.11; prod is 16.15), socket
  only, with the **real runner**:
  - 001–008 applied;
  - `roundtrip` of 009: no locks on protected relations; after up,
    in-scope `+231 -0 ~0`; after down, all 292 catalog objects identical;
  - `up` dry run and `up --apply`: clean.
- **As `insight_writer`:**
  - **Refused:** CT and CV keys in facts and daily, a `host_local` that
    doesn't match `epoch`, a daily row on the wrong day, an unknown
    category, and months outside 2025-05 … 2028-12;
  - **Can't:** TRUNCATE, ALTER, DROP, create a partition, or read `api`.
- **The real data:**
  - all 374,355 source rows (copied read-only from prod) loaded through
    the agreed mapping: 438,145 facts, 59,007 duplicates deduped, a second
    pass 0;
  - `mri.error` per (system, code) = plain SQL on 2,667 of 2,667 cells;
  - a daily build sums to every fact;
  - 168 MB with indexes.

## Please look at

1. **"No CT or CV change."** Does 009 change any existing object, its
   fingerprint or its behaviour?
   - Each of the 44 partitions gets the FK to `insight.metric_catalog`.
     The apply takes SHARE ROW EXCLUSIVE on the catalog until COMMIT. Is
     `lock_timeout` 5 s enough against the CT and CV stages' catalog
     upserts (runs at :18 / :48)?
2. **The key.**
   - `host_local` is in the unique key only because a partitioned table's
     unique key must contain the partition column. The CHECK makes it a
     function of `epoch`. Is the key then exactly the natural key +
     metric?
   - Is the CHECK expression right for how GE writes `epoch`? The plan
     §1.2 says `to_timestamp(epoch)` equals `host_date` / `host_time` on
     every system.
   - Any type or edge hazard: `integer` epoch, a leap second, the PG 14 vs
     16 interval arithmetic?
   - CV's review (CV1-SCHEMA P2) moved CV to the source-row key because
     the device-time key can repeat in a DST fall-back hour. MRI keeps the
     natural key on purpose, so that duplicate source rows dedupe (plan
     §5.3 Q-M9). It held on all 329,502 records; MRI-2's verify will
     report any key that holds two different records. Is that the right
     trade-off, or is there a realistic case where a real event is
     silently dropped?
3. **Partitioning on the device wall clock.**
   - Is range partitioning on a `timestamp` (no zone) column sound for
     pruning and for `ON CONFLICT ON CONSTRAINT`?
   - Is "no default partition, skip and count in the extract" right (as
     CT)?
   - Is 2028-12 far enough, given the writer can't add partitions?
   - The data goes back to 2025-05-02, because the first capture read
     each device's whole log (plan §5.1).
4. **`ge_mri_daily`:** `first_at` / `last_at` are device times
   (`timestamp`), unlike CV's `timestamptz`. Is the CHECK that they fall
   on `local_day` safe for every rollup the derive will write?
5. **`ge_mri_codes`:** is a nullable `category` (NULL = unreviewed) with
   six values the right shape? The labels are masked templates; there is
   no raw text column anywhere (messages carry host names, AE titles and
   operator free text).
6. **Down file:** does a roundtrip restore exactly? Is anything left
   behind?
7. **Shared-table interactions** (plan §6.4). Found while building, not
   part of 009:
   - **C1-MRI:** the three CT verifiers exclude `cv.*` / `cv_` instead of
     selecting CT keys, so MRI catalog and finding rows would fail them;
   - **C2-MRI:** `insight_writer` can't read `log.ge_mri_gesys` yet;
   - **Capabilities:** MRI must not use `insight.system_capabilities`.
     CT's `derive/verify.js` `check_capabilities` and the CT views in
     002 / 004 / 006 read it unfiltered.

   Is that the complete list of places where MRI rows in shared tables
   (`metric_catalog`, `finding_catalog`, `findings`, `job_state`) would
   affect CT or CV code, views or the stage rehearsals? Did I miss any?
