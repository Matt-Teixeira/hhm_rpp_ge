# Review handoff: CV C1 (scope the three CT verifiers to CT catalog rows)

Everything is **uncommitted**, in a scratch git worktree on branch
`c1-cv-aware` (from `dev` at 5ec391e). It is not in `~/hep3/hhm_rpp_ge`,
which stays unchanged until the GE CT Phase 5 close-out
(2026-11-12 13:00 UTC). Please write your findings to
`REVIEW-CV-C1-CODEX.md` next to this file.

```
cd /tmp/claude-1018/-home-matt-teixeira-hep3-hhm-rpp-ge/486c9073-87fc-4093-9ba7-e79fad5c0491/scratchpad/c1
git status --short                                   # what is new / changed
git diff insight/verify_facts.js insight/derive/verify.js insight/findings/verify.js   # the CT change
git diff insight/cv/test/cv.test.js insight/cv/test/findings.test.js                   # CV tests that asserted "C1 not done"
cat insight/test/cv_scope.test.js                    # new
export NODE_PATH=$HOME/hep3/hhm_rpp_ge/node_modules  # the worktree has no node_modules
node insight/test/cv_scope.test.js && node insight/cv/test/cv.test.js && node insight/cv/test/findings.test.js   # no DB needed
```

**Out of scope; don't edit:** `PLAN-CV-INSIGHTS.md`. The constraint is
§7.4 C1, and the build is in §11. Comment on design points in your
findings.

**Don't run** `insight/cli.js`, `insight/cv/cli.js` (any command) or
`migrations/run.js`. The worktree has no `.env`. The main checkout's
`.env` targets the production database.

## What this is

GE CV's first write (`insight/cv/cli.js backfill --apply`) adds 9 `cv.*`
rows to `insight.metric_catalog`. CV-4 adds 5 `cv_*` rows to
`insight.finding_catalog`. Three CT verifiers counted every catalog row,
so they would fail as soon as those rows exist. The CT stage rehearsal
(`insight/stage.js` ~188-194) gates on all three.

**The change: three files, catalog statements only.** Each module also
exports `CV_AWARE = true`. That opens GE CV's `--apply` interlock
(`insight/cv/load.js` `ct_verifiers_not_cv_aware`, also used by
`insight/cv/findings/run.js`).

| File | Before | After |
|---|---|---|
| `insight/verify_facts.js` | `count(*)` and derived count over all of `metric_catalog` | the same statement, now `CATALOG_SQL`, `WHERE metric_key NOT LIKE 'cv.%'` |
| `insight/derive/verify.js` `check_invariants` | `(SELECT count(*) FROM insight.metric_catalog)` | `... WHERE metric_key NOT LIKE 'cv.%'`; the statement is now `INVARIANTS_SQL`; `check_invariants` is exported (for the test) |
| `insight/findings/verify.js` "catalog = registry" | every `finding_catalog` row | `CATALOG_SQL` `... WHERE left(finding_key, 3) <> 'cv_'` (round 2; the first draft used `NOT LIKE 'cv\_%'`) |

Every other check, expected value and message is unchanged. The derived
count in `verify_facts` and `derived_in_catalog` in `check_invariants`
match by `= ANY(DERIVED_KEYS)`, so CV rows never reached them.

**Tests:**
- New `insight/test/cv_scope.test.js` (7). Its fake DB holds the catalogs
  in memory and applies every `col NOT LIKE '<pattern>'` found in the
  verifier's own SQL, with PostgreSQL's LIKE rules (`%`, `_`, backslash
  escape). It shows each verifier:
  - passes with and without CV rows;
  - fails on a missing CT row, an extra CT row, or a changed CT label;
  - fails on a CT-looking key `cvx.*` / `cvx_*`, which an unescaped
    `cv_%` would hide.

  It has no `require` of `insight/cv/`, because `cv.test.js` "isolation"
  forbids that outside `insight/cv`. So its CV rows are copies of the CV
  registry keys.
- `insight/cv/test/cv.test.js` (15 → 16):
  - "C1 interlock" now expects `[]` from the real modules and names the
    one module that is missing; only the boolean `true` counts.
  - New: every real CV registry row has the prefix the CT filters
    exclude, and no CT row does.
- `insight/cv/test/findings.test.js` (17): the preflight `--apply` case
  now passes the interlock instead of being refused on C1.

## How it was checked (plan §11)

- **Every suite**, Node 16 subtests:
  - CT: cv_scope 7 (new); derive 14, derived 12, findings 31, load 3,
    rules 16, scrub 3, stage 24 (23 pass + 1 skip:
    `F2: connect() …` needs `PG_SSL_PATH`, unset in the worktree, which
    has no `.env`).
  - CV: cv 16, derive 9, findings 17.
  - Parsers: 9 + 9 + 4 + 2 + 4 + 13.
  - Migrations: m008 2, sqlscan 20.
- **Mutation check.** Each of the following was broken in turn and made
  `cv_scope.test.js` fail, in a behaviour test as well as the text test;
  then the files were restored:
  - the findings filter unescaped (`'cv_%'`);
  - each of the three filters removed.
- **Local throwaway PostgreSQL 14** (`hhm_cvtest`, schema 8, CV facts,
  daily and 12 CV findings applied). Harness
  `~/cv_d3b_evidence/c1/c1_local.js`, log `c1_local.log`:
  - Original modules come from the unchanged checkout, patched ones from
    the worktree. `insight/db.js` is stubbed for both.
  - Everything ran in one transaction, rolled back. The DB after the run
    equals the DB before.
  - The CT catalogs were seeded with CT's own `catalog_statement(rules)`,
    `catalog_statement(derived_rules)` and `findings/rules catalog_rows()`:
    39 + 13 rows, next to 9 `cv.*` + 5 `cv_*`.
  - `log.ge_ct_gesys` does not exist locally, so only `verify_facts`'s
    reconcile query is answered with `[]`. There are no CT facts either.
  - The original `check_invariants` statement is taken verbatim from the
    5ec391e file (it was not exported).
  - **A, CV rows present:** the originals FAIL (metric catalog 48 vs 39,
    48 vs 39; findings catalog "18 rows, registry 13; differ: cv_…").
    C1 PASSES all three (39 = 39, 39 = 39, 13 = 13).
  - **B, a wrong CT catalog with CV rows present** (each in a
    savepoint). All are caught by C1:
    - a CT metric row missing, or an extra `cvx.not_cv`: verify_facts and
      the derive invariants FAIL;
    - a CT finding label changed, or an extra `cvx_unknown` or `cva`:
      the findings catalog FAILS. PostgreSQL itself confirms the escape:
      `cva` would be hidden by an unescaped `cv_%`.
  - **C, no CV rows** (catalogs truncated, CT re-seeded; savepoint): the
    original and C1 give identical results, correct and with a missing
    row.
  - **Interlock, real code with no emulation:**
    - `ct_verifiers_not_cv_aware()` gives all 3 from the original
      checkout and `[]` from the worktree;
    - the real `backfill` and `findings` preflights in `--apply` mode, as
      `insight_writer`: the original refuses on C1, the worktree passes.

## Other CT code checked (nothing else breaks; not changed)

- `insight/findings/run.js`:
  - `sync_catalog` only upserts registry rows and lists keys not in the
    registry. It never deletes. With CV rows, a CT `findings --rehearse`
    logs "not in the registry: cv_error_storm, …", which is cosmetic.
  - `COUNTS_SQL` counts all findings and all catalog rows. It is used for
    log lines only (findings rehearsal `before`, stage rehearsal
    `before`, `run_findings` `after`), never compared, so after CV-4 the
    totals include `ge_cv` rows.
  - The per-system `DELETE … WHERE system_id AND finding_key AND
    opened_at` is keyed by a stored `ge_ct` row (the primary key), so it
    can't reach a CV row. The replay delete filters `source = 'ge_ct'`.
- `insight/load.js`: `catalog_statement` upserts CT rules only. The
  extract rehearsal's `catalog_rows` count is a log line.
- `insight/derive/*`: `sync_catalog` upserts derived rules only.
  `all_systems` reads `ge_ct_facts`. `COUNTS_SQL` reads CT tables only.
- `insight/stage.js`: gates only on the three verifiers, plus
  fingerprints filtered to `ge_ct` and CT tables.
- `insight/cli.js`: has no `status` command. The stage's "after
  ROLLBACK, fresh read" counts all `insight.findings` (a log line).
- `~/hep3/reports/sme_reports/ct` (read only): reads `api.*` views only.
  Every findings query filters `source = 'ge_ct'`, and
  `api.ge_ct_system_summary_v` (004) filters `ge_ct` itself.

Recommendation: leave the log-only counts as they are. Changing them
would be another CT change with no gate behind it.

## Please look at

1. **The filters** (resolved in round 2, below):
   - `'cv\\_%'` inside a double-quoted JS string, which is `'cv\_%'` in
     SQL. This depends on `standard_conforming_strings = on` (the default
     since PG 9.1). If it were off, the literal would lose its backslash
     and the filter would become `cv_%`. That is still harmless today,
     because no CT key starts with `cv`. Is an explicit `ESCAPE` or
     `left(finding_key, 3) <> 'cv_'` worth it?
   - `'cv.%'`: `.` is literal in LIKE.
2. **Fail-open risk:** a CT key that ever starts with `cv.` or `cv_`
   would silently drop out of the CT checks. `cv_scope.test.js` and
   `cv.test.js` assert no CT key starts with `cv`; the metric key CHECK
   doesn't. Enough?
3. **No behaviour change without CV rows:** is any expected count or
   message different? Is the new export of `check_invariants`,
   `INVARIANTS_SQL` and `CATALOG_SQL` acceptable?
4. **The CV test edits:** they flip the "C1 not done" assertions. Is the
   refusal path still covered (`ct_verifiers_not_cv_aware` with an
   injected loader)?
5. **The test's LIKE emulation:** is it faithful enough to trust, given
   that the local PostgreSQL run covers the same cases?
6. **The other places listed above:** anything else that reads all of
   `metric_catalog`, `finding_catalog` or `insight.findings` and gates
   something?
7. Anything else.

## Round 2: after `REVIEW-CV-C1-CODEX.md` (2026-11-11)

**P2: the findings prefix filter depended on `standard_conforming_strings`.**
Fixed with a plain prefix test, so no SQL literal holds a backslash.

- **CT, `insight/findings/verify.js`:** `left(finding_key, 3) <> 'cv_'`.
- **CV, the same pattern in committed CV files.** These are outside the
  CT window, and nothing CT loads them. I changed them in this round
  because the dependency is the same:
  - `insight/cv/findings/run.js`: `OTHERS_SQL` uses `<> 'cv_'`;
    `COUNTS_SQL` and the `sync_catalog` extra-key query use `= 'cv_'`;
  - `insight/cv/findings/verify.js`: `FOREIGN_SQL` and `CATALOG_SQL` use
    `= 'cv_'`.
- **Unchanged:** the metric filters (`NOT LIKE 'cv.%'`) have no
  backslash; `.` is literal in LIKE, as the review notes.
- **Prod (read-only probe, `~/cv_d3b_evidence/c1/probe_scs.js`):**
  `standard_conforming_strings = on (default)`, with no role or database
  override. So this was not a live problem on prod.

**Tests:**
- `cv_scope.test.js` (7): the fake now also applies
  `left(col, n) <> '<prefix>'`. The prefix form drops `cv_error_storm`
  and keeps `cva`, `cvx_error` and `cv`. None of the three CT statements
  holds a backslash.
- `cv.test.js` (16): the same no-backslash check on the CT statements.
- `cv/findings.test.js` (17 → 18): new test. No `LIKE` with a backslash
  in `insight/cv/findings/*.js`, and `OTHERS_SQL` / `COUNTS_SQL` use the
  prefix form.
- **Every suite passes:** CT cv_scope 7, derive 14, derived 12, findings
  31, load 3, rules 16, scrub 3, stage 24 (one skip, as before); CV cv
  16, derive 9, findings 18; parsers 9 + 9 + 4 + 2 + 4 + 13; migrations
  m008 2, sqlscan 20.
- **Mutation check.** Each of these fails `cv_scope.test.js`:
  - `left(finding_key, 2) <> 'cv'` (hides `cva`);
  - going back to `NOT LIKE 'cv\_%'` (the no-backslash check);
  - no filter.

**Local PostgreSQL, new case D** (`c1_local.js`, log `c1_local_r2.log`;
`SET LOCAL standard_conforming_strings` in a savepoint; A-C unchanged):

| | `on` | `off` |
|---|---|---|
| C1 "catalog = registry" with CV rows | PASS | PASS |
| C1 with an extra `cva` row | FAILS (caught) | FAILS (caught) |
| first draft's `NOT LIKE 'cv\_%'` with `cva` | catches it | **hides it** (the review's case) |
| CV `COUNTS_SQL` catalog / CV `CATALOG_SQL` / `FOREIGN_SQL`, with and without `cva` | 5 / 5 / 0 | 5 / 5 / 0 |

The DB is unchanged after the rollback.

**Please look at (round 2):**
1. `left(finding_key, 3)` vs `starts_with` (PG 11+). Both avoid the
   setting; `left` is used because the expression reads plainly in all
   six places.
2. Is changing the committed CV statements in this round acceptable?
   They are new files outside the CT window, with the same reason as the
   P2.
