# Review handoff: Phase 6 steps 4–5 (the page, `dev/check_ct.js`, the real build)

The code is in the **reports** repo (`~/hep3/reports`, branch `DEV`):

| File | State | What |
|---|---|---|
| `sme_reports/ct/render.js` | new | Builds the one-file HTML: dashboard, each system's header and findings cards (server side), templates and JSON blocks |
| `sme_reports/ct/ct.client.js` | new | Inlined client: hash router, dashboard filter, period selector, the panels (SVG charts, heatmap, prep calendar, period totals), tooltips |
| `sme_reports/ct/cli.js` | new | `npm run report:ct [-- --as-of D] [--out DIR]`: read-only load, build, write `Avante-GE-CT-Insights-Internal-<as-of>.html` |
| `sme_reports/dev/check_ct.js` | new | DB-free checks (§16.4) |
| `package.json` | modified | One line: `"report:ct": "node sme_reports/ct/cli.js"` |
| `sme_reports/ct/model.js` | modified | `finding_view` carries the stored `evidence` again (see below) |
| `sme_reports/ct/verify.js` | modified | Compares the stored `evidence` too |
| `sme_reports/ct/test/model.test.js` | modified | The findings-payload test expects `evidence` |

```
cd ~/hep3/reports
git diff package.json sme_reports/ct/model.js sme_reports/ct/verify.js sme_reports/ct/test/model.test.js
```

Steps 2–3 are committed (reports `6f4f46e`, `a10efeb`). **The reports repo
has 5 other untracked paths** (`AvanteConnected-NewMarketing.*`,
`sme21284.html`) that aren't part of this change. Don't open, modify,
stage or revert them.

Background: `PLAN-CT-INSIGHTS.md` §16.2 (design, items 1, 2, 5, 6), §16.4
(exit criteria), §16.3 Q3 (no email, no schedule); the step 2 and step 3
handoffs.

## A change to step 3's F2 fix (user decision, 2026-11-05)

The step 3 F2 fix dropped the stored evidence from the payload. That
conflicted with §16.2 item 6, which shows the evidence in readable form
with the raw JSON behind a toggle. The user chose: **show the stored
evidence, labelled as stored, and check that it is carried exactly.**

- `finding_view` carries `evidence` as stored.
- `verify.js` compares it with the view, field by field, for every finding
  in the fleet. Against prod: **0 differences in 23,434 comparisons**
  (113 more than before). The mutation probe catches all 18 planted
  errors.
- The card shows the checked fields first: observed, baseline, window,
  trip days, data through, and the abort / prep trip numbers. Below them
  is a collapsed "Stored rule evidence (recorded <day>)" section that says
  "As the rule stored it; not recomputed for this page". It holds the
  readable form (scalars, nested objects, arrays as small tables, the
  thresholds), with "Raw evidence JSON" behind a further toggle.

## How the page works

- **The System Activity app pattern.** The dashboard and one view per
  system are inert `<template>`s; each system's data is an inert JSON block
  (`json_script`, so no `<` can close it). The hash picks the view, and a
  system's JSON is parsed only when it is opened.
- **Server side (`render.js`, deterministic):**
  - the dashboard: tiles, fleet table (Reporting, then Not reporting, in
    model order), inventory footer (collapsed), and a method note;
  - each system's header tiles and findings cards (open first, resolved
    collapsed).
- **Client side (`ct.client.js`):** the six panels, drawn from the JSON
  for the chosen period (default 90 d, carried from system to system). It
  only sums the payload's daily arrays over the period's days, and divides
  checked totals for rates (per 100 exams, per exam, per data day).
  - A panel appears only if it is in the payload's `panels` list (from
    capabilities).
  - Days without data are shaded grey in the day charts, so "zero" and
    "no data" differ.
- **Imported, not copied:**
  - `esc` from `render/fleet_page`;
  - the brand CSS from `incident/timeline`;
  - `footer`, `json_script` and `PAGE_CSS` from `incident/system_page`;
  - the logo from `render/assets/logo_small`.

  The brandbar is the CT page's own: `system_page`'s has "System Activity"
  hard-coded. The client has its own small `esc`, as
  `incident/timeline.client.js` does.
- **Chart colors:** categorical slots `#2a78d6` / `#eb6834` and a one-hue
  blue ramp for the heatmap.
  - The dataviz palette validator passes the pair on white: lightness,
    chroma, CVD ΔE 24.7, normal-vision ΔE 33.6, contrast ≥ 3:1.
  - The brand navy failed the lightness and chroma checks as a fill, so
    it stays in the brandbar and text only.
  - Every two-series chart has a legend.
- **Phones:** wide tables and day charts scroll inside their own panel
  (charts at least 640 px wide there); the page never scrolls sideways.
- **Not emailed, not scheduled** (Q3). `cli.js` has no `--email`.

Choices to look at:
- **The clock column.** `clock_flag = 'ok'` (and null) is shown muted.
  `ahead` / `jumps` / `lagging` are highlighted, with the offset when it
  is non-zero.
- **Findings dates and times.**
  - Opened and last-trip days are device days, from the evidence fields
    that `verify-findings` checks.
  - `resolved_at` and the window are shown as UTC instants. The window
    bounds are device midnights, so they read like "04:00 UTC".
- **Series and images per exam** use `ge_ct_exams_v` rows. Exams and the
  rates use `exam.start`, as the fleet columns do. Fleet-wide the two
  counts are equal (42,202 each).
- **Current tube** is shown in millions of mA·s on the dashboard; the
  title attribute holds the exact value.

## Already verified (by the author)

**`node sme_reports/dev/check_ct.js` (no DB):** all assertions pass. It
checks:
- 6 systems × 4 periods;
- the shared imports load;
- "Internal" appears in the title, the header (brandbar tag and h1) and
  the file name;
- byte-identical output for the same input, and with every dataset
  reversed;
- a site name carrying `<img onerror>` stays text and doesn't run;
- no `exam_no` or `protocol` in the file;
- in Chromium:
  - zero page errors;
  - the dashboard and every system view in every period have no
    sideways scroll at 390 px;
  - the panels shown equal the panels logged, in every period;
  - one card per finding;
  - with the rotor capabilities removed from a system, its Rotor panel is
    gone;
  - the filter, a row click, next, the period carried across systems, a
    chart tooltip on hover, and back to the dashboard all work.

**Real build** (`npm run report:ct`, prod, read-only, as of 2026-11-05):
- file and data:
  - `sme_reports/out/Avante-GE-CT-Insights-Internal-2026-11-05.html` (git
    ignores `sme_reports/out/`);
  - 28 reporting, 6 not reporting, 88 without log data;
  - **1.31 MB** (budget 10 MB); load 3.9 s, build 0.9 s.
- **timing** (headless Chromium on the DEV VM):
  - **dashboard ready in 106–187 ms** (3 loads), against a 2 s budget;
  - largest system view by data (SME21873, 46 kB): 34 ms to open, 68 ms
    for "all";
  - slowest of every system × period: **74 ms**, against a 2 s budget.
- all 34 systems × 4 periods: no sideways scroll at 390 px, zero page
  errors.

Model tests 14/14. `verify.js`: 0 differences (above).

## Where to look hardest

1. **Numbers the page computes.**
   - Do the client's period sums use exactly the day range `verify.js`
     checks (`a = max(0, L − days + 1)` .. `L`)?
   - Is any displayed number computed some other way? The gauge
     caption's lowest / highest is the min of the daily mins and the max
     of the daily maxes in the period.
2. **Escaping.**
   - Server: every DB string through `esc`.
   - Client: labels, codes and process names through its `esc`. Error
     codes and process names come from `dim`; the tooltip uses
     `innerHTML`.
   - Is there any path where DB text reaches HTML unescaped?
3. **Determinism.** No clock or randomness in `render.js`. Object key
   order in the JSON blocks comes from the model.
4. **Router and state.** Hash handling for unknown ids, the period carried
   across systems, the tooltip and chart registry cleared on view change,
   scroll restore.
5. **The check itself.** Can `check_ct.js` pass while a panel shows for a
   missing capability, or while a view scrolls sideways in a period it
   didn't try?
6. **Read-only.** `cli.js` uses `ct/db.js` / `load_ct`, so it can't
   write. It writes only the output file.

## Ground rules (this machine is also the production server)

- **Don't run anything that connects to the database**: `cli.js` /
  `npm run report:ct`, `verify.js`, `ct/tools/build_fixture.js`, anything
  in `hhm_rpp_ge` that connects.
- DB-free is fine:
  - `node sme_reports/dev/check_ct.js` (needs Chromium via puppeteer, as
    `check_system_pages.js` does);
  - `node sme_reports/ct/test/model.test.js`;
  - opening the built file in `sme_reports/out/`.

  Run them from `~/hep3/reports`.
- Don't open or print any `.env`.
- Don't modify files in either repo. Report only.
- Don't touch `/home/prod/hhm_rpp_ge`.

## How to report

Write findings to `hhm_rpp_ge/REVIEW-PHASE6-PAGE-CODEX.md`, in the same
format as `REVIEW-PHASE6-VERIFY-CODEX.md`: one `### F<n> — title` section
per finding, each with:
- Severity: high / medium / low
- Confidence: confirmed / likely / possible
- Location: `file:line`
- What's wrong
- Failure scenario
- Evidence (say whether you ran a probe or read the code)
- Suggested fix

Order findings most severe first. If you find nothing, say so explicitly.

## Fixes after review (2026-11-05)

- **F1 (catalog labels unescaped in client HTML): fixed.**
  - `stat()` in `ct.client.js` escapes its label, value and caption.
    Nothing passed HTML into it, so no output changes for clean labels.
  - The client's other DB-text paths were already escaped: chart titles,
    legends, tooltips, error codes, process names, units, segments.
  - New in `check_ct.js`: every metric label and unit is prefixed with
    `<img src=x onerror=…>`. In Chromium, every system view in every
    period has no `img` in the view, nothing runs, and the label text is
    shown.
  - With the escape temporarily removed, the check fails (`SME21859 30d:
    catalog label markup stays text`); restored, it passes.
- **F2 (CLI accepts other `--as-of` days): fixed.**
  - `cli.js` `resolve_as_of` accepts only the snapshot's UTC day.
    - Earlier is refused: the page would show later state under an
      earlier date.
    - Later is refused too: systems that report today would count as not
      reporting.
  - The model gains `valid_day`, a real calendar day: V8's `Date.parse`
    turns 2026-02-31 into Mar 3. `build_model` uses it for `as_of` and
    `snapshot_day`, and so `verify.js` and the CLI argument check do too.
  - `build_model` already refused an earlier day (review PHASE6-DATA-MODEL
    F1), so the CLI couldn't produce such a page before; it now says why
    up front.
  - New in `check_ct.js`: the snapshot day passes; one day earlier, one
    later, 2026-02-31, 2026-13-01 and `20261105` are refused; the model
    refuses 2026-02-31; leap days are handled.
  - Against prod: `--as-of 2026-11-04` and `--as-of 2026-02-31` both exit
    2 with the reason.
- `check_ct.js` all pass; model tests 14/14. Real build rebuilt: 1.31 MB;
  load 3.9 s, build 0.9 s.
