# Review handoff: Phase 3 checkpoint 1 (migration 004 and a runner fix)

Repo: `hhm_rpp_ge`, branch `dev`. The change is **uncommitted** in the
working tree, on top of `cb3cc5e`. It has **not** been applied to the
database. The review happens before the owner applies it.

## What to review

```
git status --short          # 3 modified, 2 new
git diff                    # modified files
cat migrations/004_phase3_derive.sql migrations/004_phase3_derive.down.sql
```

| File | Change |
|---|---|
| `migrations/004_phase3_derive.sql` | new: up migration |
| `migrations/004_phase3_derive.down.sql` | new: down migration |
| `migrations/lib/sqlscan.js` | `scanSql` also returns `freshCreates` and `netDrops` |
| `migrations/run.js` | 3 lines: expected-state checks use those lists |
| `migrations/test/sqlscan.test.js` | 2 new tests |

Background, if needed: `PLAN-CT-INSIGHTS.md` §13.2 (agreed decisions) and
§13.4 (build order), §10 (prod safeguards), §3 (data model). Migrations
001–003 are already applied and must not change: the runner stores their
checksums.

## What the change does

**Migration 004** (scope `insight.*` and `api.ge_ct_*` only):
- `insight.ge_ct_daily`: adds `dim text NOT NULL DEFAULT ''`. The primary
  key changes from `(system_id, local_day, metric_key)` to include `dim`.
  The table is empty.
- `insight.ge_ct_tube_segments`: adds `tube_source text`, checked against
  `verified` / `unrecognized` / `no_smart_id`. Empty table.
- New table `insight.system_clock`, one row per system: a clock-lag
  estimate and a flag (`ok` / `ahead` / `lagging` / `jumps`). It is
  informational only and never used to correct timestamps.
- `GRANT SELECT, INSERT, UPDATE, DELETE` on `system_clock` to
  `insight_writer`, matching what the other pipeline tables already have.
- Drops and re-creates 4 views. New columns can't be inserted mid-view
  with `CREATE OR REPLACE`:
  - `api.ge_ct_daily_v`: adds `dim`
  - `api.ge_ct_tube_v`: adds `tube_source`
  - `api.ge_ct_exams_v`: adds `reopened`, from `attrs->>'reopened'`
  - `api.ge_ct_system_summary_v`: adds `current_tube_source`,
    `clock_flag`, `clock_est_offset_min`, and includes `system_clock`
    systems in its system list

  The views had no grants and no dependent objects (checked against the
  catalog).

**Down 004** restores the 002 view definitions, drops `system_clock` and
`tube_source`, and puts back the 3-column key. The `local_day` column
comment is set back to NULL, because 001 had only an inline SQL comment.

**Runner fix.** Before this change, the up pre-check required every object
a file creates to be absent beforehand. That refuses a view the same file
drops and re-creates. `scanSql` now also returns:
- `freshCreates`: created objects that no earlier statement in the same
  file drops. The runner requires these to be absent before the run
  (previously: all creates).
- `netDrops`: dropped objects that no later statement in the same file
  re-creates. After a real `down --apply`, the runner requires these to be
  gone (previously: all drops).

Nothing else in the runner changed: static scan, catalog fingerprint of
protected objects, lock check, dry run by default, fresh-connection
re-check.

## Already verified (by the author, against prod, all rolled back)

- `node migrations/run.js scan`: ok on all 8 files. 004: 22 statements;
  down: 19.
- Dry run of up 4:
  - no locks taken on protected relations
  - all 2,894 protected fingerprints unchanged
  - in-scope changes: +2 (`system_clock` and its primary-key index), ~7
  - ROLLBACK; a fresh connection shows the catalog identical (3,150
    objects)
- `roundtrip` (up 4, then down 4 in one transaction): "down restored the
  catalog exactly (3150 objects identical, incl. insight/api)", then
  ROLLBACK.
- Tests pass:
  - `insight/test/*.test.js`: 3 + 16 + 3
  - `test/*.test.js`: 9 + 4 + 2
  - `migrations/test/sqlscan.test.js`: 12

The catalog fingerprint (`migrations/lib/catalog.js`) covers columns,
constraints, indexes, view definitions, ACLs and owners. It does **not**
cover comments.

## Where to look hardest

1. **`freshCreates` / `netDrops` matching** (`sqlscan.js`, end of
   `scanSql`). Objects are matched on `kind:name`; function arguments are
   ignored, and tables, views and indexes all have kind `relation`.
   - Can a file use the exemption to bypass the "must be absent"
     pre-check in a way that matters? Example: `DROP VIEW x; CREATE TABLE x`,
     or a function overload.
   - Does name normalisation (quotes, case, whitespace) make matching miss
     or over-match?
2. **Paths the roundtrip doesn't exercise.**
   - The `netDrops` post-check only runs on a real `down --apply`.
   - The up `--apply` post-check ("declared objects created") still uses
     all `creates`.

   Are both correct for a file that drops and re-creates the same object?
3. **Down 004 preconditions.**
   - Restoring the 3-column key fails once `ge_ct_daily` has rows that
     differ only in `dim`.
   - Dropping `tube_source` and `system_clock` discards their data.

   The header documents both. Is that enough, or should the down file
   refuse more explicitly?
4. **View runtime safety.** `(e.attrs ->> 'reopened')::boolean` makes the
   whole `api.ge_ct_exams_v` query fail if any row's `attrs.reopened` is
   not a valid boolean string. Is that acceptable, given the pipeline is
   the only writer?
5. **`system_clock` constraints:** `est_offset_min` is nullable while the
   other numeric columns are NOT NULL; there's a window CHECK; the flag
   CHECK has no `insufficient` value (systems with too few captures will
   get no row). Is anything missing or inconsistent?
6. **Summary view:** do the added `LEFT JOIN insight.system_clock` and the
   new `UNION` branch change its row count or semantics in an unintended
   way?
7. **Scope:** anything in 004 or its down file outside `insight.*` /
   `api.ge_ct_*`, or any lock the migration could take on a protected
   relation.

Out of scope: the design decisions in plan §9, §12 and §13.2 are settled.
Raise a concern only if the code contradicts them. The three columns
beyond the plan's 004 list (`tube_source`, `reopened`, the summary clock
columns) are open for comment.

## Ground rules (this machine is also the production server)

- **Don't run anything that connects to the database.** That means
  `migrations/run.js status|up|down|roundtrip` and anything under
  `insight/cli.js`. The DB outputs are summarised above.
- DB-free commands are fine: `node migrations/run.js scan` and the test
  files above.
- Don't open or print `.env`.
- Don't modify files. Report only.
- Don't touch `/home/prod/hhm_rpp_ge`.

## How to report

Write findings to `REVIEW-PHASE3-004-CODEX.md` in the repo root, in the
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
