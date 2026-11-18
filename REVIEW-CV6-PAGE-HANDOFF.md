# Review handoff: CV-6 steps 4–5 (the "GE CV Insights — Internal" page)

Repo `~/hep3/reports`, branch `DEV` at e1de116, **uncommitted**. It sits
on top of:
- step 1, `REVIEW-CV6-SHARED-HANDOFF.md`: the shared
  `sme_reports/insights/` module, which CT now uses;
- steps 2–3, `REVIEW-CV6-DATA-MODEL-HANDOFF.md`: data, model and
  verifier.

The plan is `~/hep3/hhm_rpp_ge/PLAN-CV-INSIGHTS.md` §13. §13.2 is the
design, §13.3 Q7 (K1 wording) and Q8 (peaks) were agreed, and the build
record is §13.7.

The page is a self-contained HTML file, built on demand. It is not
emailed and not scheduled. Please write your findings to
`REVIEW-CV6-PAGE-CODEX.md` next to this file.

```
cd ~/hep3/reports
cat sme_reports/cv/render.js sme_reports/cv/cv.client.js sme_reports/cv/cli.js
less sme_reports/insights/client_core.js        # what the parts file plugs into
git diff package.json                           # the one shared line: "report:cv"
node sme_reports/dev/check_cv.js                # no DB, headless Chromium, ~7 s
npm run report:cv                               # read-only, prod -> sme_reports/out/ (git-ignored)
NODE_PATH=$PWD/node_modules node ~/cv_d3b_evidence/cv6/timing.js sme_reports/out/Avante-GE-CV-Insights-Internal-<date>.html
```

## What it is

**`cv/render.js`** (server side, pure).
- **Dashboard:**
  - tiles: reporting, not reporting, configured without data, open
    findings, not configured;
  - the fleet table, with the columns in this order: system, model,
    site / customer, last data (with the newest device time, marked
    "device clock"), open findings, clock, errors per day (30 d),
    busiest day, detector com, anticollision, table encoder, PIB ("not
    logged" when the system never logs it);
  - the configured-without-data table;
  - the inventory footer (collapsed);
  - a method note: K1, the errors-only caveat, definitions, and what is
    verified.
- **System view:**
  - 8 tiles;
  - CT's finding cards through `insights/page.js` `finding_card`, with a
    per-rule caption for Observed (`OBSERVED`), and a `display` that
    adds a `label` next to every `code` in the readable evidence (the raw
    JSON stays as stored);
  - the period bar and the panels container.

**`cv/cv.client.js`** is a parts file for `insights/client_core.js`.
- **Errors:**
  - `barsClip`: entries per day stacked by subsystem. By default the y
    axis tops out at `niceMax(1.5 × p95)`, where p95 is the period's
    95th-percentile **data** day. Taller days are cut, marked ▲, and
    their full count is in the tooltip. A "Clip peaks / Full scale"
    toggle sits above it (§13.3 Q8).
  - `bandsChart`: one band per finding on the same day axis.
- **Errors by code:** the top 10 plus other, every code behind a
  `<details>`. Labels come from `INDEX.codes`.
- **Detector:** by operation, plus the 1200019 series.
- **Positioner and table:** collisions; anticollision and table encoder
  as the period's top 4 axes (the verified `ranks`) plus other;
  backout.
- **Connectivity:** PIB, worklist, dose export.
- **Colours:** slots 1–8 of the dataviz reference palette in fixed
  order. A dim keeps its slot, its rank over all history, in every
  period. Slots 1–5 were validated adjacent on the light surface (CVD
  ΔE 9.1, normal-vision ΔE 19.6). Three slots are under 3:1 contrast,
  so every stacked chart also names its series with period totals in
  the caption.
- **The scale toggle** works by delegated click on `#app`. It sets
  `fullScale`, then clicks the pressed period button, so the core's
  `draw()` redraws the panels. The core doesn't change for this.

**`cv/cli.js`:** `npm run report:cv`. It uses `ct/cli.js`
`resolve_as_of` (as-of = the snapshot's UTC day only), and reports size
and timing against the 10 MB budget.

## Results

- **`dev/check_cv.js` passes** (2 systems × 4 periods × 2 scales). It
  covers:
  - zero page errors, and no sideways scroll at 390 px;
  - "Internal" in the title, header and file name;
  - determinism, also with reversed input;
  - markup in identity, finding text, catalog labels, code labels and
    source files staying text (also on a fully opened page);
  - as-of and CLI refusals;
  - base names, and no debug-text or encoded field names;
  - panels hidden with capabilities removed, and the PIB chart only
    where logged;
  - the peak toggle; filter, row click, next / previous, back, the
    period carried across systems, and a tooltip.

  Four planted faults were all caught: a chart without its metric, an
  unescaped site name, a toggle that doesn't redraw, and a too-wide
  element.
- **Real build** (`npm run report:cv`, prod, read-only, 2026-11-18
  20:28 UTC):
  - `sme_reports/out/Avante-GE-CV-Insights-Internal-2026-11-18.html`,
    **0.22 MB** (budget 10 MB); load 0.6 s, build 0.1 s;
  - 2 reporting, 16 configured without data, 44 not configured;
  - 205 code labels, no source-file path, no debug-text keys, nothing
    IPv4-like.
- **Timing** (`~/cv_d3b_evidence/cv6/timing.js`, headless Chromium on
  the DEV VM):
  - **dashboard ready in 29–93 ms** (3 loads), against a 2 s budget;
  - opening a system: 20–24 ms;
  - **slowest system view × period × scale: 49 ms**, against a 2 s
    budget;
  - 0 sideways scroll at 390 px, and 0 page errors.
- **`cv/verify.js` at 20:29 UTC:** 0 differences in 12,926 comparisons.

## What I'd like checked

1. **Escaping.** The client builds HTML strings. Every database text
   (catalog labels, code labels, source files, dim names, finding labels
   in bands) should pass through `esc`, either directly or through
   `legendOf`, `stat` and `box`'s `stat` calls. `box()`'s title and
   `sub` are not escaped, and only literals are passed to them. Is any
   path missed? `with_labels` puts code labels into the readable
   evidence, which `ev_value` escapes.
2. **Numbers the page computes** from verified arrays, not themselves
   verified:
   - period sums, per data day, the busiest day in the period;
   - the "findings in the period" count;
   - the clip limit, and the count of days cut;
   - the stack totals in captions;
   - `dimOrder` for metrics without ranks.

   Is each one the sum it claims, over `[a, b]` = the period's days
   (`a` = max(0, L − days + 1))?
3. **The scale toggle.** It relies on `app.querySelector('.seg')` in
   the core finding the period bar first: the panels are empty at mount,
   and the scale bar's `.seg` sits inside them. Is that fragile? Could
   re-clicking the pressed period button ever change the period?
4. **The clock wording.** `last_seen` is shown as
   `YYYY-MM-DD HH:MM UTC (device clock)`. It's the stored instant (the
   device's wall clock taken as local time), so for SME02412 it reads
   about 108 minutes in the future. Together with the Clock column and
   the K1 note, is this clear enough, or misleading?
5. **Peaks (Q8).**
   - p95 is taken over data days only, as `ceil(0.95 n) − 1` in sorted
     order. The limit is `niceMax(1.5 × p95)`. Nothing is clipped when
     p95 is 0, or when the maximum is within the limit.
   - Only the errors timeline clips. The detector chart, whose peaks
     are the point, stays at full scale.
6. **Shared CSS** that is CT's: `#systems td:nth-child(7)`, which CV
   overrides, and the date axis label "Sep 26", meaning September 2026,
   which comes from the core. Leave as is, or raise for the shared
   module?
7. **Layout at 390 px** and in the real file, beyond what `check_cv`
   asserts: the code table's long labels; the finding bands' labels
   placed left or right of a band.

Not in scope: the data / model / verifier
(`REVIEW-CV6-DATA-MODEL-HANDOFF.md`) and the shared module
(`REVIEW-CV6-SHARED-HANDOFF.md`).
