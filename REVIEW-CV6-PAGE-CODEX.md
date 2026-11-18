# CV-6 page — Codex review

Reviewed 2026-11-18 against the uncommitted reports worktree on `DEV`,
base `e1de116`. No implementation changes made. Four P2 issues follow;
the existing browser checks pass, and the current period sums agree.

**F1 — P2: a single visible dimension loses its identity and assigned colour.**

Location: [cv/cv.client.js:125](/home/matt-teixeira/hep3/reports/sme_reports/cv/cv.client.js:125).

`metricBars` replaces a one-stack result with the aggregate metric,
generic metric label and first palette colour. Its caption also stops
naming the stack. This already hides SME08640's detector operation
`waitRxCommandDm` and its table axis `lateral`: the chart says “by
operation” or “4 axes,” but neither the caption nor tooltip identifies
the sole dimension.

It also violates the promised stable colour assignment when a ranked
metric has only one active axis in a period. In a direct reproduction,
an axis assigned orange by `dimStacks` renders blue through `metricBars`.
Use the returned stacks whenever one exists and retain the dimension
name in the caption or legend, including a single stack. Use an
aggregate fallback only for an empty stack list or a deliberately
dimensionless metric.

**F2 — P2: the palette limit can hide a period's leading axis in “other.”**

Location: [cv/cv.client.js:110](/home/matt-teixeira/hep3/reports/sme_reports/cv/cv.client.js:110).

After selecting the period's top four axes, the client discards any
whose all-history rank is ninth or later. Those counts are then folded
into “other,” despite the caption promising the period's four leading
axes. SME02412 already has ten anticollision axes; its ninth/tenth are
`front_lift` and `l_arm`. No current top-four list triggers the problem,
but a recent burst on one of those axes can do so.

A synthetic nine-axis reproduction selected period ranks
`axis_8, axis_0, axis_1`, with counts `100, 1, 1`; rendered stacks were
`axis_0: 1`, `axis_1: 1`, `other (7): 100`. Preserve every selected top
axis even when it needs a fallback colour/pattern and a text label.
The period rank should control visibility independently of palette size.

**F3 — P2: a band spanning the selected period puts its label outside the SVG.**

Location: [cv/cv.client.js:89](/home/matt-teixeira/hep3/reports/sme_reports/cv/cv.client.js:89).

When the label cannot fit to the right, the renderer always places it
left of the band's start without checking left-side space. A finding
opened before the selected period and still open through its end spans
the whole plot: `x0 = 46`, so the text ends at 40. In Chromium,
`storm (medium, open)` then has bounding box **x = −77.81, width = 117.81**.
Most of the label is clipped even though document scroll width remains
correct. This is a normal possible long-running finding, not invalid
input. Place the label inside the plot or in a separate label column
when neither outside position fits; test text bounds as well as body
overflow. Current real bands fit at desktop and phone widths.

**F4 — P2: longer-period rates can round a half-cent tie downward.**

Location: [cv/cv.client.js:152](/home/matt-teixeira/hep3/reports/sme_reports/cv/cv.client.js:152),
using shared [client_core.js:42](/home/matt-teixeira/hep3/reports/sme_reports/insights/client_core.js:42).

The data-model rounding argument relies on a divisor of at most 30.
The selected 90-day, six-month and all-history periods can have more
data days. For **323 entries / 40 data days = 8.075**, the current
`Math.round((323 / 40) * 100)` path displays **8.07**, while exact
half-up rounding gives **8.08**. The separately checked integer sums do
not detect this. Compute the displayed ratio with integer/rational
rounding before formatting, or precompute these period rates. This can
be fixed in the CV part without changing CT's shared formatter/output.

**Answers to the handoff questions**

- **Escaping:** no missed database-text path found. Catalog labels pass
  through `stat`/`frame`; dimension names pass through tooltip escaping,
  legends and escaped caption totals; code labels, subsystem and source
  files are escaped in rows; finding-band text and tooltip values are
  escaped. `with_labels` feeds the escaped evidence renderer. `box`
  receives literals or number-derived strings for its raw title/sub.
  JSON is embedded through `json_script`. Existing malicious-markup
  browser tests pass.

- **Computed numbers:** inclusive `[a,b]` agrees with the model's
  calendar-day periods. Error sums, data-day counts, earliest busiest-day
  ties, named-metric sums, overlapping-band counts and stack totals use
  those bounds. I independently recomputed sums and clip counts for both
  systems in all four periods: eight cases pass. `dimOrder` correctly
  sums all history and breaks ties by name; the subsequent visibility
  and rendering problems are F1/F2. Period rate rounding is F4. “Findings
  in the period” counts overlapping episodes, including resolved ones,
  consistent with its caption and the agreed day-level bands.

- **Scale toggle:** currently safe. `mountSystem` captures the period
  bar before drawing the initially empty panels. The delegated scale
  handler explicitly finds `.periodbar .seg`'s pressed period button;
  its nested click sets the same period and redraws. The scale handler
  ignores that nested event because it has no `data-scale`. Repeated
  scale clicks preserve the selected period in all browser cases.
  A future preceding `.seg` would make the core selector fragile;
  narrowing the core to `.periodbar .seg` is optional later hardening,
  with a new CT proof if the emitted client changes.

- **Clock wording:** the K1 explanation and “no offset visible” are
  appropriate; neither asserts that the clock is correct. The `UTC`
  suffix describes the stored instant's rendering, but can suggest an
  authoritative corrected time when seen alone. Prefer “newest device
  timestamp (uncorrected, shown in UTC)” near the value, and say the
  lower bound is measured against the report snapshot. Do not substitute
  the historical 108–118 minute estimate: the lower bound shrinks as a
  snapshot gets later even without another device record. The separate
  data review records a microsecond flooring edge case.

- **Clipping:** nearest-rank p95 is computed over data days only;
  `niceMax(1.5*p95)` is the limit. Zero p95 and a maximum within the
  limit use the ordinary chart. Mark counts and full-scale restoration
  agree with independent calculations; detector charts retain full
  scale. The caption should say “1.5 × p95, rounded up to an axis tick,”
  rather than claiming the top equals exactly 1.5 × p95. For example,
  the real SME08640 90-day chart has p95 70 and a top of 200, not 105.

- **Shared CSS/date axis:** CV's seventh-column override works. Keep
  it for this extraction; scope such selectors to viewer classes in a
  later shared cleanup. “Sep 26” is ambiguous between a day and a year;
  `Sep '26` or `Sep 2026` is clearer, but changing it is a shared CT
  output change, not a regression introduced by this extraction.

- **Layout:** inspected real desktop and 390-pixel screenshots, plus
  SVG text bounds for every current system/period. Long code labels
  wrap within the horizontally scrollable table. Charts/tables scroll
  inside their containers, with no document overflow. Current finding
  labels fit; F3 is missed by the existing body-width assertion.

**Checks run**

- `node sme_reports/dev/check_cv.js`: pass, both systems × four
  periods × both scales, zero errors. CT browser check also passes.
- `npm run report:cv -- --out /tmp/cv6-codex-review`: real read-only
  build, 0.22 MB, 2 reporting / 16 configured without data / 44 inventory.
- Supplied `timing.js` on that build: dashboard 152/62/29 ms; slowest
  period/scale redraw pair 92 ms; zero page errors and no body overflow
  at 390 px.
- Existing model and shared tests pass. Live CV verification:
  0/12,926 differences, with all 31 mutation probes caught. Its mapping
  blind spot is documented in the data/model review.

Temporary review harnesses: `/tmp/cv6-client-review.js`,
`/tmp/cv6-layout-review.js`, `/tmp/cv6-band-edge.js`.
Real HTML and screenshots remain under `/tmp`; no report source,
production data, staging or commits were changed.
