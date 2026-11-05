# Code review — Phase 6 steps 4–5 (page and build)

### F1 — Catalog labels enter client HTML without escaping
- Severity: medium
- Confidence: confirmed
- Location: `sme_reports/ct/ct.client.js:245-248`
- What's wrong: `stat` interpolates its `k` argument as HTML. `evTotal` passes `label(v, m)` as that argument, and those labels come from `metric_catalog` data in the JSON payload. The Reliability, Environment, Compliance, and Rotor panels call `evTotal` for applicable metrics. This creates a database-text-to-HTML path that bypasses the client's `esc` helper.
- Failure scenario: a catalog label contains markup such as an event handler. When the panel is drawn with `innerHTML`, the markup is interpreted in the report opened by staff. The current fixture labels are benign, and the check only taints a site name.
- Evidence: code inspection. `model.js` builds `v.labels` from capability/catalog rows; `label` reads those values; `evTotal` passes the result to `stat`, which inserts `k` without escaping. No probe or test was run.
- Suggested fix: escape `k` (and any non-static `val` or `s`) inside `stat`, and add a browser check that taints a metric label and confirms it remains text.

### F2 — CLI accepts earlier `--as-of` dates despite claiming to refuse them
- Severity: medium
- Confidence: confirmed
- Location: `sme_reports/ct/cli.js:10-11,38-40`
- What's wrong: the CLI comment says an earlier day is refused because findings and tube state are current, but `main` loads current data and passes any syntactically valid `--as-of` directly to `build_model`; there is no comparison with `raw.snapshot_day`. For an earlier date, the model filters day-based series but retains the snapshot's current tube and finding records, so the generated page can present future state under a historical “As of” date.
- Failure scenario: an operator builds the report with `--as-of` before a later tube replacement or finding change. The title and daily charts use the earlier date, while the current tube and findings reflect the later snapshot.
- Evidence: code inspection of `cli.js` and the model's `index_system` handling of tube/findings. No probe or test was run.
- Suggested fix: enforce the documented restriction by rejecting `as_of < raw.snapshot_day` (and reject dates after the snapshot day); also validate that the supplied date is a real calendar date.
