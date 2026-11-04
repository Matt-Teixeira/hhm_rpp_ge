# Review handoff: Phase 4 step 4 (findings write path, verify-findings, tuned rules)

Repo: `hhm_rpp_ge`, branch `dev`. The change is **uncommitted** in the
working tree, on top of `3420fcf` (step 3, already reviewed in
`REVIEW-PHASE4-RULES-CODEX.md`; F1-F3 fixed there). Nothing has been
written to the database: the owner wants this review **before** the first
`findings --apply`.

## What to review

```
git status --short
git diff                                  # cli.js, rules.js, context.js, verify_sql.js, test, fixtures
cat insight/findings/run.js insight/findings/report.js
```

| File | Change |
|---|---|
| `insight/findings/run.js` | new: reconcile one system, rehearse / apply, catalog sync, job_state `ge_ct_findings` |
| `insight/findings/report.js` | new: text list per rule with evidence (review aid, pure) |
| `insight/cli.js` | `findings --rehearse\|--apply [--replay] [--system S\|--systems A,B] [--report FILE]`, `verify-findings` |
| `insight/findings/rules.js`, `context.js`, `verify_sql.js` | two rules tuned (below), in JS and in the independent SQL |
| `insight/test/findings.test.js` | boundary tests for the tuning; CLI args; upsert shape; drift comparison |
| `insight/rules/__fixtures__/findings/expected.json` | rebuilt from the SQL (69 findings for the 13 fixture systems) |

Background: `PLAN-CT-INSIGHTS.md` §14.2 (design), §14.4 (exit criteria),
§10 (safeguards), §13.5 (the derive run path this mirrors:
`insight/derive/run.js`).

## What the change does

**Tuning (approved by the owner 2026-11-04, from the replay evidence).**
- `abort_rate_high`: the count is abort *log lines*, and one exam can carry
  100+ (SME21851: 322 lines in one exam in 43 min). Now a spike also needs
  >= 10 aborts in its 7 days, and both variants need aborts on >= 2
  distinct days of their window. 38 -> 24 findings; SME21867 still chronic.
- `safe_state_recurrent`: counts *incidents*, not lines: after the
  existing exclusions, the same code more than 30 min after its previous
  (kept) event starts a new incident; an incident's day is its first
  event's. >= 3 incidents of one code in 7 days. 19 -> 11.
- Still `rule_version` 1 (nothing was ever written).

**Write path (`run.js`).** Per system, every run loads the inputs, replays
the whole history (pure, `state.js`), and reconciles the system's rows in
`insight.findings` (key `(system_id, finding_key, opened_at)`):
- `--replay`: the table becomes exactly the replay (delete rows not
  produced, upsert the rest).
- default (the future Phase 5 path): systems with no data in the last 7
  device days are skipped. Stored **resolved** rows are never updated or
  deleted; if the replay disagrees on any column it is reported as drift.
  Open rows are updated or deleted, new rows inserted.
- Order: deletes, then one multi-row `INSERT ... ON CONFLICT DO UPDATE ...
  WHERE (cols) IS DISTINCT FROM (EXCLUDED cols)` with resolved rows first
  (so a finding closing frees the partial unique index `findings_one_open_idx`
  before a new open row for the same key is inserted).
- `today` = the UTC date of the run; data on later device days is ignored.

**Rehearse** (one transaction, rolled back): pass 1 (chosen mode); pass 2
(same again: 0 changes, identical fingerprint); after `--replay` a default
pass (0 changes, 0 drift); incremental consistency (delete, replay as of
today-28, default runs at -21/-14/-7/0: identical fingerprint, 0 drift);
`verify-findings` on the uncommitted rows. **Apply**: catalog sync, one
transaction per system, `job_state ge_ct_findings` (stats.today, used by
`verify-findings`) only on a fleet-wide run.

**verify-findings** (`verify.js`, read-only): every stored row vs
`FINDINGS_SQL` field by field; catalog = registry; invariants.

## Already verified by the author (against prod, rolled back)

`echo prod | node insight/cli.js findings --rehearse --replay`, as
`insight_writer`, after the last change:
- pass 1: 112 findings (29 open), 13 catalog rows; pass 2: 0 changes,
  identical; default after replay: 0 changes, 0 drift (6 stale systems
  skipped); incremental (as of 10-07, then weekly to 11-04): identical, 0
  drift at every step; verify-findings PASS (SQL 112 = table 112, 0
  missing/extra/differ; catalog 13/13; invariants ok); after ROLLBACK a
  fresh read shows 0 rows.
- The three §14.4 named problems are present (SME21859 rotor high,
  SME18531 restart loop 09-12 -> 09-23, SME21867 chronic aborts).
- Tests: `insight/test/findings.test.js` 27/27; all other
  `insight/test/*.test.js`, `test/*.test.js`,
  `migrations/test/sqlscan.test.js` pass.

## Where to look hardest

1. **Reconcile correctness** (`findings_system`):
   - Can the delete/upsert order ever violate `findings_one_open_idx` or
     the PK (e.g. a stored open row whose replacement has a different
     `opened_at`, a kept resolved row in default mode, two rows for one
     key)?
   - `inserted` / `updated` are derived from `rowCount` and the pre-read
     keys. Is that right for `INSERT ... ON CONFLICT DO UPDATE ... WHERE`?
   - Default mode: can a resolved row ever be modified or deleted? Can an
     open row that the replay now says resolved (or no longer produces) be
     left stale?
2. **Default vs replay semantics.** A stale system (no data in 7 days) is
   skipped in default mode. Is there a case where the default path and a
   replay would disagree permanently (outside the drift report)?
3. **Rehearsal checks**: do the fingerprint (every column) and the
   incremental steps (replay at -28, then default every 7 days) prove what
   they claim, given the 7-day staleness window? Could they pass while
   the apply would differ (the apply is per-system transactions)?
4. **Tuned rules, JS vs SQL**: the incident definition (gap measured from
   the previous kept event of the same code, exclusions applied first,
   strictly > 30 min), the abort day counts (`ind.abort_system` vs
   `(ab > 0)` window sums), and boundaries (>= 10, >= 2).
5. **`today` and `verify-findings`**: `today` is the UTC date; device
   clocks are local (UTC-4..-6) or run ahead (one by ~4.6 h). verify reads
   `stats.today` of the last fleet-wide run; a `--systems` apply doesn't
   update `job_state`. Any way verify checks against the wrong as-of day?
6. **Apply error path**: a failure mid-run leaves earlier systems committed
   and records `status error` keeping the previous watermark. Acceptable?
7. **CLI**: argument validation (`--report` only with `--rehearse`,
   `--replay` only for findings, value flags need values); the confirm
   prompt.
8. **Evidence**: still no raw message text anywhere (review F1)?

Out of scope: the rules and thresholds in §14.2 and the two tunings above
are settled; raise a concern only if the code contradicts them.

## Ground rules (this machine is also the production server)

- **Don't run anything that connects to the database**: anything under
  `insight/cli.js`, `insight/tools/*`, `migrations/run.js status|up|down|roundtrip`.
- DB-free commands are fine: the test files, `node migrations/run.js scan`,
  and `node -e` probes that only `require` pure modules over the fixtures.
- Don't open or print `.env`. Don't modify files. Report only.
- Don't touch `/home/prod/hhm_rpp_ge`.

## How to report

Write findings to `REVIEW-PHASE4-RUN-VERIFY-CODEX.md` in the repo root, in
the same format as `REVIEW-PHASE4-RULES-CODEX.md`: one `### F<n> — title`
section per finding, each with Severity (high / medium / low), Confidence
(confirmed / likely / possible), Location (`file:line`), What's wrong,
Failure scenario, Evidence (probe or code reading), Suggested fix. Order
most severe first. If you find nothing, say so explicitly.
