# Review handoff: MRI-3 derive (`insight/mri/`, GE MRI daily, code labels, derived queries)

Please review the commit named by the user (MRI-3 on `dev`, on top of
4345243), and write your findings to `REVIEW-MRI3-DERIVE-CODEX.md` next to
this file.

```
cd ~/hep3/hhm_rpp_ge
git show --stat HEAD                                        # the MRI-3 commit
node insight/mri/test/derive.test.js && node insight/mri/test/mri.test.js   # no DB needed
```

**For comparison:** `insight/cv/derive.js` and `insight/cv/verify_derive.js`
(CV-3, reviewed as CV3-DERIVE, with its P2 / P3 fixes); the MRI extract
(`insight/mri/load.js`, `reconcile_sql.js`, reviewed as MRI2-EXTRACT); the
tables in `migrations/009_mri_schema.sql` (MRI1-SCHEMA).

**Out of scope; don't edit:** `PLAN-MRI-INSIGHTS.md` (this phase is §8,
with the evidence in §8.3 and five questions in §8.5; comment on them in
your findings), `PLAN-MRI-INSIGHTS-CODES.md`.

**Don't run** `insight/mri/cli.js` or anything that connects with the repo
`.env`: it targets the production database, and GE CV's stage is in a
monitoring window until 2026-11-19.

## What MRI-3 does

From `insight.ge_mri_facts` (MRI-2):
- **`insight.ge_mri_daily`**: per system, device day, metric, dim; the
  pending days the extract recorded (or the whole system); one transaction
  per system, which also clears its days and marks the codes as owed.
- **`insight.ge_mri_codes`**: per message code: n, systems, first / last
  device time, most common process, the reviewed category (361 codes;
  NULL for the long tail and new codes) and a label = the most common
  masked template (`labels.js`).
- **Derived queries** (`derived_sql.js`, no tables): capabilities,
  inventory, software sessions, service-mode sessions, process deaths with
  `at_restart` (a start, stop, System Up or the stop companion 200002364
  within ±10 device minutes).
- **`verify_derive.js`**: A daily vs the source (device day from
  `host_date`, not `epoch`); B `mri.error` per code and day; C daily vs a
  GROUP BY over the facts; D codes vs a SQL rebuild from the source (the
  masking rewritten in PostgreSQL regexes); E label leak check; F each
  derived query vs an independent JS computation.

## How it was checked (plan §8.3)

- **Local throwaway DB (PG 14):** rehearsal with every check at 0
  differences (A 17,011 cells, B 52,917, C both ways, D 823 codes, E 0
  leaks, F five queries); apply; no-op rerun; a new device day with a new
  code; a simulated crash in the code rebuild, recovered by the next run;
  `--full` byte-identical to the pending path.
- **Prod, read-only (PG 16.15):** D's SQL vs the JS derive over the same
  deduped source rows: 823 codes, 0 differences.
- **Tests:** derive 14, MRI 23; every suite 288 of 288.

## Please look at

1. **Daily.** Delete-and-rebuild per day and per system; `first_at` /
   `last_at` and `local_day` from `host_local` (009's CHECK);
   `value_last` ordering; the pending / `codes_pending` protocol (copied
   from CV after CV3-DERIVE P2). Any way a day is left stale or a code
   rebuild is skipped?
2. **Labels and privacy.** Is `labels.js` sound as the only place message
   text becomes stored text? Every host seen in `type` is masked (≥ 3
   characters, any case, word boundaries), plus MAC, IP, serials, digits,
   dates, AE titles. Is anything identifying likely to survive (operator
   free text, site names in messages not tied to a host)? Is check E
   strong enough?
3. **JS vs SQL equivalence (D).** The SQL rewrite in `verify_derive.js`
   vs `labels.js`: JS backtracking vs PostgreSQL's longest-match
   alternation, `\b` vs `\y`, lookbehind with a case-insensitive host
   alternation, `[^]]`, the `$` / `.` behaviour, the ASCII step, the
   process trim. It agreed on all 823 codes on PG 14 and 16; is there an
   input where they would part?
4. **Derived queries.** Definitions and edge cases: ties at one device
   second, a start with both a `sw_stop` and its companion, a stop before
   the first start, service 'on' after 'on', the inclusive ±10 min window,
   inventory ordering. Are the JS references in check F truly independent
   of the SQL?
5. **Questions §8.5** (Q-D1 restart events incl. 200002364; Q-D2 queries,
   not tables; Q-D3 long-tail category NULL; Q-D4 no clock table; Q-D5
   mask every host): any reason to decide otherwise?
6. **Isolation and shared tables.** Derive writes only `ge_mri_daily`,
   `ge_mri_codes` and `job_state 'ge_mri_derive'`; reads the source for
   labels (C2-MRI). Anything that touches CT or CV rows or code?
