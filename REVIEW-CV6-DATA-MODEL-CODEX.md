# CV-6 data, model and verifier — Codex review

Reviewed 2026-11-18 against the uncommitted reports worktree on `DEV`,
base `e1de116`. No implementation changes made. Current fleet counts
and model values pass verification. One P2 verification gap and two
lower-priority boundary/guard issues follow.

**F1 — P2: metric mappings are used as their own verification oracle.**

Location: [cv/verify.js:178](/home/matt-teixeira/hep3/reports/sme_reports/cv/verify.js:178),
also the `M.NAMED`, `M.RANKED`, `M.PANELS` and `M.TOP_CODES` uses in the
panel checks and SQL parameters.

The SQL independently aggregates the selected data, but the model
decides which metric each fleet column means. I reproduced an undetected
wrong result in one read-only snapshot:

```js
M.FLEET_METRICS.detector = 'cv.anticollision_error';
const result = await run_checks(t);
// 0 differences, despite the Detector column now carrying anticollision.
```

SME02412's detector column changed from 13,331 to 9; SME08640's changed
from 0 to 171. Both were accepted. The mapping was changed only in that
process and restored afterward. The existing 31 probes change the
finished model, so they do not exercise this failure mode. Likewise,
removing a metric from a shared list or changing a shared panel definition
can reduce both the model and its expected coverage together.

Add independent assertions for the approved column mappings, complete
metric/panel/rank sets and top-code count, or a separately defined
contract used by the verifier's expectations. Sharing aggregation inputs
is fine once their meanings are checked independently. Freezing the
objects alone would not catch a future source edit to the wrong mapping.

**F2 — P3: millisecond truncation can overstate the clock bound at a minute boundary.**

Location: [cv/model.js:143](/home/matt-teixeira/hep3/reports/sme_reports/cv/model.js:143)
and `FLEET_SQL`'s exact `last_seen - now()` expression.

PostgreSQL retains snapshot microseconds; the JS Date returned by the
loader drops them. For `last_seen = 20:01:00.000000Z` and
`snapshot = 20:00:00.000001Z`, the SQL floor is 0, but `clock_ahead`
returns 1. I checked both results. At larger minute boundaries the
display can similarly be one minute higher than the true floored bound.
This is rare and did not affect the normal runs, but the arithmetic is
not guaranteed equivalent. Compute the bound in SQL at full precision,
or preserve enough timestamp precision for conservative flooring; add
the boundary example to the checks.

**F3 — P3: the fixture text guard is narrower than its stated guarantee.**

Location: [cv/tools/build_fixture.js:37](/home/matt-teixeira/hep3/reports/sme_reports/cv/tools/build_fixture.js:37).

The guard checks addresses and drive/UNC paths only in `label`.
`sourcefile` is checked only for slashes. I ran the actual guard function
without its DB/build entry point: a source file of `192.168.1.2` or
`name@example.org`, a label containing `/private/internal/build/file.cpp`,
and the masked identifier `SME#` are all accepted. Number masking means
the `SME\d+` rule cannot recognize the latter. Finding evidence is copied
without a text/schema guard.

No current leak was established: the checked-in labels were reviewed,
source files are base names, identity is anonymized in the fixture, and
the current rule implementation emits bounded codes/dims/counts/dates.
Treat this tool as a guard for the reviewed vocabulary, not a general
privacy proof. Apply relevant token checks to both text fields, account
for masked identifiers and absolute paths, and either validate evidence
shapes or require renewed review when rule/catalog vocabulary changes.

**Answers to the handoff questions**

- **Days:** the model's `period_range` and SQL `IN_PERIOD` agree on
  inclusive calendar-day windows ending at the last `cv.error` day at
  or before as-of. A fleet window is D−29 through D, with only
  `cv.error` days in its divisor. `SPAN` uses the same metric and cutoff.
  Every currently counted named event also has an error fact, so no
  named series extends outside the error-day span. Capabilities and
  newest device time intentionally describe all available history;
  `last_seen` is not cut at as-of. The CLI restricts publication to the
  snapshot day, while the pure model/verifier support later dates for
  boundary checks.

- **Coverage:** a separate read-only query confirmed **62 GE CV/IR
  systems: 18 configured, 2 with data, 16 configured without data,
  44 other inventory; zero unconfigured systems with data**. The sets
  are disjoint and complete in this snapshot. Exact `sysError.log` and
  `run_group = 1` implement the agreed definition, including exclusion
  of an acquisition-only configuration. Both inventory queries exclude
  summary systems as well as configured ones. If an unconfigured system
  later retains data, it remains a data row and is not counted again in
  the footer.

- **Rounding:** the fleet argument is sound for positive, safely sized
  integer counts and a divisor of at most 30. Half-cent ties in that
  range reduce to binary-exact fractions; other cases are far enough
  from a tie at the observed counts. Label-share rounding agrees for
  the checked values. The microsecond exception is F2. Longer-period
  browser rates have a separate rounding issue in the page review.

- **Independence:** separate SQL aggregation, ranking, evidence walking,
  source-file extraction and finding ordering provide useful independent
  checks. Reconstructing dense arrays from SQL cells is reasonable.
  They verify consistency with the API views, not correctness of the
  upstream extraction or rules. Shared specification constants remain
  unchecked assumptions; F1 demonstrates a consequential one.

- **Bands:** all five CV rules are windowed and use the common state
  machine. `insight/findings/state.js` supplies top-level `opened_day`
  and `resolved_day` for each; an open finding ends at the last evaluated
  data day. Using those device dates rather than UTC dates from
  `resolved_at` is correct. Omitting a band without those fields is
  defensible for malformed/legacy evidence, but should not silently
  become expected for any current CV rule. Resolved-day inclusion follows
  the agreed day-level display; it is not a claim the finding remained
  open for every instant of that day.

- **Privacy:** the real internal page intentionally includes system,
  model, site/customer and location identity. The fixture substitutes
  identity names and clears location/customer-id fields, while keeping
  system IDs/models. Both also carry catalog wording and timestamps,
  so “only codes/counts/dims/days” is a summary, not a literal schema.
  Source paths are removed before reaching the builder; raw debug and
  encoded fields are not selected. Unchanged evidence is safe under the
  current rule shapes, subject to the guard limitation in F3.

**Checks run**

- Model tests: 13/13 pass.
- Normal production verifier: **0 differences / 12,926 comparisons**,
  snapshot `2026-11-18T20:35:18.779Z`.
- Production `--probe`: **31/31 caught**, zero unmutated differences.
- Independent coverage query and the F1/F2 reproductions above, all
  read-only, within REPEATABLE READ transactions.

The fixture builder was inspected; its checked-in fixture was tested
without regenerating it. Temporary reproduction:
`/tmp/cv6-independent-review.js`. No production writes, staging or commits.
