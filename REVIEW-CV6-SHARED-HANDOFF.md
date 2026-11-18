# Review handoff: CV-6 step 1 (shared `sme_reports/insights/`, CT moved onto it)

Repo `~/hep3/reports`, branch `DEV` at e1de116, **uncommitted**. The plan
is `~/hep3/hhm_rpp_ge/PLAN-CV-INSIGHTS.md` §13: agreed 2026-11-18 and
committed on hhm_rpp_ge `dev` (1b41310). The build record is §13.7.

This step only moves code. It extracts the generic parts of the GE CT
Insights viewer (CT Phase 6, `PLAN-CT-INSIGHTS.md` §16) into a shared
module. The CV viewer (CV-6) will import them, and later the MRI viewer.
The CT page must not change. The step runs nothing on prod and writes
nothing to any DB. Please write your findings to `REVIEW-CV6-SHARED-CODEX.md`
next to this file.

```
cd ~/hep3/reports
git status --short                      # 3 modified ct/ files + new sme_reports/insights/
git diff sme_reports/ct/                # render.js, verify.js, ct.client.js (now a parts file)
cat sme_reports/insights/page.js sme_reports/insights/verify_core.js
less sme_reports/insights/client_core.js
node sme_reports/insights/test/page.test.js        # 5, no DB
node sme_reports/ct/test/model.test.js             # CT model tests, no DB
node sme_reports/dev/check_ct.js                   # headless Chromium, no DB (~20 s)
bash ~/cv_d3b_evidence/cv6/ctproof/run_proof.sh    # old (git HEAD) vs new pages, 10 inputs
```

`run_proof.sh` compares against `git HEAD`, so it is meaningful only while
the step is uncommitted. After a commit, compare with the parent
(`git archive HEAD~1`).

## What moved where

| From | To | How |
|---|---|---|
| `ct/render.js`: `n0`, `n2`, `MONTHS`, `dlong`, `utc`, `SEV`, `sev_badge`, `open_cell`, the tile helper (it was defined twice inline), `BOOKKEEPING`, `label_of`, `ev_value`, `ev_list`, `finding_card`, the system view's nav, findings section and period bar, `CT_CSS` (now `INSIGHTS_CSS`), `brandbar`, the page shell | `insights/page.js` | Text unchanged, except for three parameters (below) |
| `ct/ct.client.js` lines 8–181, 220–243, 245–250, 336–358 (IIFE, index and state, colours, helpers, dashboard filter, system mount and period bar, chart primitives `bars` / `line` / `gauge`, `hookCharts`, `stat` / `box` / `evBars` / `evTotal`, router) | `insights/client_core.js` | Cut by line range with `~/cv_d3b_evidence/cv6/ctproof/split.py` (no text retyped); four marker lines stand where CT's parts were |
| `ct/ct.client.js` lines 1–7 (header comment), 182–219 (`heatmap`, `prepCalendar`), 244 (`const PANELS`), 251–335 (`const PANEL`) | `ct/ct.client.js`, now a **parts file** with `//@@header@@`, `//@@charts@@`, `//@@panel-keys@@` and `//@@panels@@` sections | The same split |
| `ct/verify.js`: `canon`, `check` with the module-level `checks`, `series`, `r3`, `num`, `msOf`, `PERIOD_SQL`, `SEV_RANK`, the report lines in `main` | `insights/verify_core.js` | `check` now comes from a `checker()` factory, so each verifier has its own list. CT calls it once at module top, which keeps CT's previous single module-level list |

**The parameters added (their defaults give the CT output):**
- `brandbar(product, as_of)`: the product name was the literal
  `GE CT Insights`.
- `finding_card(f, i, sid, { after_facts, observed_label, display })`:
  - `after_facts`: CT passes its `trip_table`, at the position where CT
    called it;
  - `observed_label`: defaults to "Observed";
  - `display`: maps the recorded evidence before the readable list. It
    defaults to the identity. The raw JSON block always prints the
    stored evidence.
- `page_html({ ..., extra_css })`: with no extra CSS, the `<style>` block
  is exactly CT's.

**`assemble_client(parts_text, core_text)`:**
- It drops the documentation before the first marker of each file.
- It splits the parts file at marker lines (`^//@@name@@\n$`).
- It refuses an unknown, repeated or missing section, and a core
  without exactly one of each marker.
- It replaces each core marker line with its section's text, using a
  function replacer, so `$&` in code stays literal.

CT's render calls it once, at module load, as it previously read
`ct.client.js`.

**Unchanged:** `ct/model.js`, `ct/data.js`, `ct/db.js`, `ct/cli.js`,
`ct/tools/`, `ct/test/`, `dev/check_ct.js`, and every other file in the
repo. The repo was clean before this step.

## Evidence that CT is unchanged

- **The CT page from CT's fixture is byte-identical:** sha256 `5c3497e6…`,
  321,545 bytes, before and after.
- **`run_proof.sh`:** old code (`git archive HEAD`) and new code give
  byte-identical HTML and file names for 10 inputs:
  - the fixture, and the fixture reversed;
  - markup in identity, in catalog labels, and in finding label,
    description, category and evidence;
  - a third of the capabilities removed;
  - as-of + 30 days, so every system is not reporting;
  - every finding with `evidence: null`;
  - no findings;
  - one system.
- **`ct/test/model.test.js`:** 14 ok, 0 not ok. **`insights/test/page.test.js`:**
  5 of 5. **`dev/check_ct.js`:** passes (6 systems, 24 views × periods,
  zero page errors, 390 px, escaping).
- **`ct/verify.js` on prod**, read-only, one REPEATABLE READ snapshot,
  2026-11-18 19:49 UTC: **0 differences in 24,581 comparisons** (34
  systems, 117 findings, 64 rule trip days). The report format is the
  same as before, now produced by `report_lines`.

## What I'd like checked

1. **Is the page really unchanged?** Are there paths the 10 inputs don't
   reach where the moved templates could differ? For example a not
   reporting system's notice, a system with no previous or next, a
   finding with `last` evidence but no `day`, or `data_through` null.
2. **`assemble_client`:**
   - its marker parsing (a section that doesn't end with a newline;
     CRLF; a marker-like line inside a template string in a future
     parts file);
   - whether its refusals are enough to stop a half-built client from
     shipping.
3. **`checker()`:** CT now calls it once at module top. `run_checks`
   still resets with `checks.length = 0`, and `main` reads the same
   array. Is there any behaviour change, for example when the verify
   test harness calls `run_checks` repeatedly with `mutate`?
4. **The scope rule:** the reports repo stages only
   `sme_reports/insights/**`, the three `ct/` files, and later
   `sme_reports/cv/**`, `dev/check_cv.js` and one `package.json` line.
   Does anything else need changing (for example `dev/check_ct.js`'s
   list of the shared imports it checks)?
5. **Anything in `insights/` that is still CT-specific and will get in
   CV's way:**
   - `#systems td:nth-child(7)` in the CSS;
   - `hookCharts`' `c.heat` / `c.cal` branches;
   - the stored-evidence wording "The panels below show the checked
     daily data behind it".

   CV's plan is in `PLAN-CV-INSIGHTS.md` §13.2.

Not in scope: the CV viewer itself (steps 2–5; separate handoffs
`REVIEW-CV6-DATA-MODEL-HANDOFF.md` and `REVIEW-CV6-PAGE-HANDOFF.md`).
