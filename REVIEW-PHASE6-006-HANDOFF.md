# Review handoff: Phase 6 step 1 (migration 006, viewer views)

Repo: `hhm_rpp_ge`, branch `dev`. The change is **uncommitted** in the
working tree, on top of `78e080a`. It has **not** been applied to the
database. The review happens before the owner applies it.

## What to review

```
git status --short          # 1 modified, 2 new (+ this file)
git diff                    # migrations/test/sqlscan.test.js
cat migrations/006_phase6_viewer_views.sql migrations/006_phase6_viewer_views.down.sql
```

| File | Change |
|---|---|
| `migrations/006_phase6_viewer_views.sql` | new: up migration, 2 views |
| `migrations/006_phase6_viewer_views.down.sql` | new: drops them |
| `migrations/test/sqlscan.test.js` | 2 new tests |

Background, if needed: `PLAN-CT-INSIGHTS.md` §16.1 (evidence, items 2
and 3 under "What §7 asks for"), §16.3 Q1 (the agreed view contents), §3
(the `api` views are the consumer contract), §10 (prod safeguards).
Migrations 001–005 are applied and must not change (the runner stores
their checksums). No runner or scanner code changed.

## What the change does

Views only. No table, column, grant or drop of an existing object, and
nothing the `ge_ct` stage reads. Both views read only `insight.*`.

1. **`api.ge_ct_days_v`**: one row per (system, device wall-clock day
   with at least one fact). Columns: `system_id`, `local_day`,
   `local_midnight` (instant of device-local midnight), `first_at`,
   `last_at` (min/max `host_datetime` that day).
   - The day and `local_midnight` copy the findings loader's definition
     exactly (`insight/findings/load.js` `DAYS_SQL`): day =
     `host_local::date`; `local_midnight` comes from the day's earliest
     fact by device clock, ties broken by earliest `host_datetime`.
   - The viewer needs it for the busy-hour heatmap: local hour of an exam
     = `started_at - local_midnight` (§16.1 item 2).
2. **`api.ge_ct_capabilities_v`**: `insight.system_capabilities` joined
   to `insight.metric_catalog` (label, unit, category, value_kind,
   model_specific, customer_visible). It separates "doesn't log it" from
   "zero events" (§16.1 item 3).

**Down 006** drops both views, with no CASCADE.

## Already verified (by the author, against prod, read-only)

- A probe ran the days-view `SELECT` body against `insight.*` on a
  `default_transaction_read_only=on` connection and compared it with
  `DAYS_SQL` for every system:
  - 34 systems, 5,057 device days, **0 differences** in day,
    `local_midnight` and `last_at`;
  - `first_at >= local_midnight` on every day;
  - fleet-wide read 3.0 s; `WHERE system_id = 'SME21859'` 50 ms. The plan
    shows the filter pushed into both branches as an index scan on each
    facts partition.
- `insight.system_capabilities` joined to the catalog: 660 rows, 34
  systems, 39 metrics; no row lost to the inner join.
- `api` has no default privileges (`pg_default_acl` empty for `api`); the
  5 existing `api.ge_ct_*` views are owned by `avantehs_admin` with no
  ACL. The new views get the same: owner = the applying role, no grants.
- `node migrations/run.js scan`: ok on all 12 files. 006: 4 statements,
  creates 2 objects; down: 2 statements.
- `node migrations/run.js status`: 001–005 applied, checksums ok; 006
  pending.
- Tests pass: `migrations/test/sqlscan.test.js` 16/16 (2 new); the
  `insight/test/*` and `test/*` suites are unchanged and pass.
- **Dry run of up 6** (run by the owner, 2026-11-05):
  - expected state: 5 of 6 applied, checksums ok; the 2 objects to create
    were absent;
  - 4 statements, 106 ms in total; locks taken on protected relations by
    the migration statements: none;
  - all 2,894 protected fingerprints unchanged;
  - in-scope changes +2 -0 ~0 (`api.ge_ct_days_v`,
    `api.ge_ct_capabilities_v`); declared objects created;
  - ROLLBACK; a fresh connection shows the catalog identical (3,154
    objects).
- **`roundtrip`** (up 6, then down 6 in one transaction): no locks on
  protected relations after up or after down; "down restored the catalog
  exactly (3154 objects identical, incl. insight/api)"; ROLLBACK, nothing
  persisted.

## Where to look hardest

1. **Equivalence with `DAYS_SQL`.** The view adds `system_id` to the
   `DISTINCT ON` key and `ORDER BY`, and joins its two branches on
   `(system_id, local_day)` instead of `USING (d)` under a per-system
   `WHERE`. Is there any input (duplicate `host_local` within a day,
   clock jumps, a day with one fact, NULLs) where a per-system filter on
   the view returns something different from `DAYS_SQL` for that system?
2. **`local_midnight` semantics.** It assumes one clock offset per device
   day. On a DST change or a clock step, hours after the change are off
   by the step. The view comment says so. Is that acceptable for a
   heatmap, or should the contract expose something better (for example
   per-exam local time)? Note that changing it would mean leaving the
   rules' definition.
3. **Contract shape.** Anything a consumer (viewer, frontend) would need
   that's missing, or columns that leak internals? `first_seen`/`last_seen`
   are instants (`timestamptz`), not device days.
4. **Performance.** The fleet-wide read sorts all facts (3.0 s today). Is
   that a problem for the planned on-demand build, or for the frontend
   later?
5. **Scope:** anything in 006 or its down file outside `api.ge_ct_*` /
   `insight.*`, or any lock stronger than AccessShare on a protected
   relation.

Out of scope: the decision to add these two views (§16.3 Q1) is settled.
Raise a concern only if the code contradicts it.

## Ground rules (this machine is also the production server)

- **Don't run anything that connects to the database.** That means
  `migrations/run.js status|up|down|roundtrip` and anything under
  `insight/cli.js`. The DB outputs are summarised above.
- DB-free commands are fine: `node migrations/run.js scan` and
  `node --test migrations/test`.
- Don't open or print `.env`.
- Don't modify files. Report only.
- Don't touch `/home/prod/hhm_rpp_ge`.

## How to report

Write findings to `REVIEW-PHASE6-006-CODEX.md` in the repo root, in the
same format as `REVIEW-CT-INSIGHTS-CODEX.md`: one `### F<n> — title`
section per finding, each with:
- Severity: high / medium / low
- Confidence: confirmed / likely / possible
- Location: `file:line`
- What's wrong
- Failure scenario
- Evidence (say whether you ran a probe or read the code)
- Suggested fix

Order findings most severe first. If you find nothing, say so explicitly.
