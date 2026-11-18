# Review handoff: CV-6 steps 2–3 (the GE CV viewer's data, model and verifier)

Repo `~/hep3/reports`, branch `DEV` at e1de116, **uncommitted**. It sits
on top of step 1 (`REVIEW-CV6-SHARED-HANDOFF.md`: the shared
`sme_reports/insights/` module, CT moved onto it). The plan is
`~/hep3/hhm_rpp_ge/PLAN-CV-INSIGHTS.md` §13: §13.1 evidence, §13.2
design, §13.3 the agreed answers, §13.4 exit criteria. The build record
is §13.7.

These files read prod only and write nothing. Please write your findings
to `REVIEW-CV6-DATA-MODEL-CODEX.md` next to this file.

```
cd ~/hep3/reports
cat sme_reports/cv/data.js sme_reports/cv/model.js sme_reports/cv/verify.js
cat sme_reports/cv/tools/build_fixture.js
node sme_reports/cv/test/model.test.js            # 13, no DB (fixture from prod)
node sme_reports/cv/verify.js                     # read-only, prod, ~1 s
node sme_reports/cv/verify.js --probe             # read-only, 31 planted errors, ~30 s
```

Running against prod: avoid minutes :18 and :48 UTC, when the CT, CV and
MRI stages start. Sessions are read-only (`ct/db.js` sets
`default_transaction_read_only=on`).

## What it is

- **`cv/data.js`:**
  - Reads in one read-only REPEATABLE READ transaction. Every query has
    an ORDER BY.
  - Sources:
    - the five `api.ge_cv_*` views (migration 007);
    - identity: `public.systems` → `sites` → `customers`;
    - the configured list: GE CV/IR systems in `config.acquisition`
      (run_group 1) with a `config.log` row for `sysError.log`;
    - the inventory: GE CV/IR systems that are neither configured nor in
      `api.ge_cv_system_summary_v`.
  - `sourcefile` is cut to its base name **in SQL**. GE's build paths
    (a drive letter, the build tree, a version) never reach the builder.
- **`cv/model.js`** is pure and deterministic for (snapshot, as-of). It
  imports the CT model's day helpers, `PERIODS`, `STALE_DAYS`,
  `open_findings` and `finding_view`.
  - A **data day** is a day with a `cv.error` row. Every counted log row
    has one.
  - **Fleet row**, with D = the last data day ≤ as-of:
    - errors per data day over D−29..D;
    - the busiest day (ties: the earlier day);
    - 30-day sums of four named metrics, null when not in capabilities;
    - open findings;
    - the clock lower bound: `floor((last_seen − snapshot) / 1 min)`
      when ≥ 1, else null (K1, §13.2 item 8).
  - **Groups:**
    - reporting: D ≥ as-of − 6;
    - not reporting;
    - configured without data;
    - inventory.
  - **Per system:**
    - the data mask;
    - `cv.error` per day by subsystem (POS / RTA / DL / other);
    - every named metric per day, in total and per dim;
    - the 1200019 detector-offset series (only with the detector
      capability);
    - code tables per period: every code as `[code, n, days]`, sorted by
      n desc then code; the top 10, other and total;
    - dim ranks per period, for anticollision and table encoder;
    - finding bands: opened day to resolved day, or to the last data day
      while open, clipped to the day range;
    - findings in CT's order.
  - **Page level:** labels for every code listed in a code table or
    named in finding evidence (`evidence_codes` walks for `code` keys at
    any depth).
- **`cv/verify.js`** builds the model from `data.js` rows in the same
  snapshot, and recomputes with its own SQL:
  - every fleet column, the order of the lists, the configured list,
    the without-data list and the inventory;
  - for both systems: every per-day value, the code tables and ranks
    per period, panels, labels and bands;
  - all findings field by field, with the evidence as stored;
  - every code label.

  **Where the SQL takes a different route on purpose:**
  - the subsystem comes from `ge_cv_codes_v`, not from `daily_v`'s
    joined column;
  - the configured list starts from `config.log`;
  - ranks use `row_number()` with `COLLATE "C"`;
  - band clipping and the findings' page order are done in SQL;
  - evidence codes are found with `jsonb_path_query('strict $.**.code')`;
  - the base name comes from `substring(...)` here, against
    `regexp_replace` in `data.js`.

  `--probe` plants 31 errors, one per kind, in the built model. Each
  must cause a difference.
- **`cv/tools/build_fixture.js`** writes `cv/test/fixtures/cv_fixture.json.gz`
  from prod, read-only (0.04 MB, as of 2026-11-18).
  - It holds all of CV: 2 systems with data, 18 configured, 44
    inventory.
  - Site, customer, city, state and `cus_sys_id` are placeholders.
    Codes, counts, dims, days, the masked labels of the 205 reviewed
    codes and source-file base names are kept.
  - It refuses a label that looks like an IP, email, drive or UNC path
    or system id, and a source file with any path separator.

## Results

- **Model tests: 13 of 13.** Expected values come from the fixture rows
  with plain loops.
  - A mutation check planted 8 model faults, and all were caught. The
    busiest-day tie and the 7-day boundary needed tests of their own,
    because the real data has no tie and no system on the boundary.
- **`verify.js` on prod: 0 differences in 12,926 comparisons**
  (2026-11-18 20:06 and 20:29 UTC).
- **`verify.js --probe`:** all 31 caught, with 0 differences unmutated.
- The first verify run had one difference, in the check. The page's
  code-label map lists integer-like keys numerically (a JavaScript
  rule), while the SQL sorted them as text. Keys are now compared as
  sets. The map is a lookup, so order doesn't matter.

## What I'd like checked

1. **Day semantics.**
   - Data days come from `cv.error` only, and facts on device days after
     as-of are ignored, as in the findings rules. Is anything counted
     against a different day range on the two sides? Look at
     `IN_PERIOD`, `SPAN` and the model's `period_range`.
   - `last_seen` (the clock bound) is deliberately not cut at as-of.
2. **The configured, without-data and inventory lists.**
   - Both sides match `config.log.file_name = 'sysError.log'` exactly,
     and `run_group = 1`. Is that the right definition (§13.1), and are
     the three lists disjoint and complete against the 62 GE CV/IR
     systems?
3. **Rounding and time.**
   - The per-day rate is rounded in SQL numeric on one side and with JS
     `Math.round` on the double on the other. The argument for why they
     can't differ is in `verify.js`'s header.
   - Label share: both sides round `share * 1000` computed in double.
   - The clock bound compares milliseconds (JS) with microseconds (SQL)
     at whole minutes.
4. **Is the verifier really independent?** It shares the model's
   constants (`PANELS`, `NAMED`, `FLEET_METRICS`, `RANKED`, the
   periods), and assembles dense arrays in JS from SQL cells. Is there a
   case where the model and the verifier would be wrong in the same way?
5. **Finding bands.**
   - An open finding runs to the last data day. A resolved one runs to
     `evidence.resolved_day`, not to `resolved_at`.
   - A finding with no `opened_day` in its evidence gets no band.
   - Is that right for every `ge_cv` rule's evidence shape
     (`insight/cv/findings/rules.js` in hhm_rpp_ge)?
6. **Privacy.**
   - Can anything other than codes, counts, dims, days, masked labels and
     base names reach the fixture or the page? Finding evidence goes in
     unchanged (counts, codes, dims, days, thresholds; §13.1).
   - Is the fixture tool's refusal list enough?

Not in scope: the page itself, the client and the real build
(`REVIEW-CV6-PAGE-HANDOFF.md`), and the shared module
(`REVIEW-CV6-SHARED-HANDOFF.md`).
