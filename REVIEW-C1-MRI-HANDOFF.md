# Review handoff: C1-MRI (scope the three CT verifiers to CT catalog rows, MRI edition)

Everything is **uncommitted**, in a scratch git worktree on branch
`c1-mri-aware` (from `dev` at d563c75). It is not in `~/hep3/hhm_rpp_ge`,
which stays unchanged until the GE CV-5 close-out (2026-11-19 20:18 UTC).
Please write your findings to `REVIEW-C1-MRI-CODEX.md` next to this file.

```
cd /tmp/claude-1018/-home-matt-teixeira-hep3-hhm-rpp-ge/55e9ee15-2148-40b1-8e6c-cee8680b1d44/scratchpad/c1mri
git status --short                                   # 6 changed files, nothing new
git diff insight/verify_facts.js insight/derive/verify.js insight/findings/verify.js   # the CT change
git diff insight/test/cv_scope.test.js insight/mri/test/mri.test.js insight/mri/test/findings.test.js
export NODE_PATH=$HOME/hep3/hhm_rpp_ge/node_modules  # the worktree has no node_modules
node insight/test/cv_scope.test.js && node insight/mri/test/mri.test.js && node insight/mri/test/findings.test.js && node insight/cv/test/cv.test.js   # no DB needed
```

**Out of scope; don't edit:** `PLAN-MRI-INSIGHTS.md` in the main checkout.
The constraint is §6.4 (C1-MRI); the plan is §10.1–§10.4 and the build is
§10.5. Comment on design points in your findings.

**Don't run** `insight/cli.js`, `insight/cv/cli.js`, `insight/mri/cli.js`
(any command) or `migrations/run.js`. The worktree has no `.env`; the main
checkout's `.env` targets the production database.

## What this is

C1 (PLAN-CV-INSIGHTS.md §11, reviewed as CV-C1 with its P2 fix) scoped the
three CT verifiers by *excluding* GE CV's catalog rows. GE MRI writes its
own rows to the same shared catalogs: 23 `mri.*` to
`insight.metric_catalog` (the MRI-2 extract) and 11 `mri_*` to
`insight.finding_catalog` (MRI-4). The first of them would fail the CT
verifiers, and the CT stage rehearsal gates on all three. So this must be
deployed before MRI's first prod write.

| File | Before | After |
|---|---|---|
| `insight/verify_facts.js` `CATALOG_SQL` | `WHERE metric_key NOT LIKE 'cv.%'` | `... AND metric_key NOT LIKE 'mri.%'` |
| `insight/derive/verify.js` `INVARIANTS_SQL` (catalog subselect) | same | same addition |
| `insight/findings/verify.js` `CATALOG_SQL` | `WHERE left(finding_key, 3) <> 'cv_'` | `... AND left(finding_key, 4) <> 'mri_'` |

Each module also exports `MRI_AWARE = true`. The MRI `--apply` interlocks
read it (`insight/mri/load.js` `ct_verifiers_not_mri_aware`, used by the
MRI backfill and findings preflights).

**Design choice:** extend the exclusion (recommended in plan §10.1), rather
than selecting CT keys by the CT registry's prefixes. It is the smallest
change to closed-out CT code, mirrors the reviewed C1 pattern, and a new CT
prefix needs no verifier edit. The cost: a fourth modality repeats this
change.

## How it was checked (plan §10.5)

- **Tests in the worktree:** 316, 315 pass, 1 skipped (CT `stage.test.js`
  "F2 connect()", which needs a `.env`; the same skip as C1).
- **Mutations:** each of these fails at least two tests: either `mri.%`
  filter removed, the findings filter removed, a 3-character `'mri'`
  prefix, `LIKE 'mri%'` (no dot), `LIKE 'mri\_%'` (a backslash), or
  `MRI_AWARE = false` on one module.
- **Local throwaway DB (PG 14), one transaction, rolled back**
  (`~/cv_d3b_evidence/mri/c1mri/c1mri_local.js`, `c1mri_local.log`): the
  original modules (main checkout) vs the worktree's, with CT catalogs
  seeded by CT's own statements next to real MRI rows and CV rows.
  - The original fails all three checks with MRI rows; C1-MRI passes.
  - C1-MRI still catches a missing / extra / changed CT row, including
    `mrix.not_mri`, `mrix_unknown`, `mria` and `mri`.
  - With no CV / MRI rows, the original and C1-MRI behave identically.
  - The same results under `standard_conforming_strings` on and off.
  - The real MRI backfill and findings preflights refuse `--apply` on the
    original and pass on the worktree.

## Please look at

1. **Filter correctness:** `'mri.%'` (`.` literal, no `_`) and
   `left(finding_key, 4) <> 'mri_'` drop exactly the MRI keys. The
   `metric_catalog` key CHECK (`^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$`) means a
   metric key always has a dot. Is any CT key, or any key a future CT rule
   could plausibly use, hidden?
2. **Completeness:** are these three statements the only CT checks that
   count or compare shared catalog rows? Plan §10.3 lists the log-only
   places left alone (CT findings `sync_catalog` "not in the registry",
   `COUNTS_SQL` totals, the stage's "fresh read" count) and CV's
   `stage.js` "CT unchanged" fingerprint, which excludes only `cv`. Does
   anything else gate a CT run on catalog contents or on
   `insight.findings` rows of another source?
3. **`cv_scope.test.js`:** does its fake `LIKE` / `left()` evaluation still
   faithfully model what PostgreSQL does with two ANDed exclusions? It
   uses copies of the MRI keys (CT may not load `insight/mri`); the real
   registries are checked in `mri.test.js` "C1-MRI: every real MRI catalog
   row ...".
4. **No `insight/cv/` change:** `cv.test.js`'s C1 text checks still pass on
   the two-part filters. Is relying on that right, or should the CV test
   also pin the MRI part?
5. **Deploy order** (§10.4 / §10.5 "Next"): commit after the CV-5
   close-out, CT stage rehearsal on prod, then push, all before MRI-2's
   first prod write. Anything missing?
