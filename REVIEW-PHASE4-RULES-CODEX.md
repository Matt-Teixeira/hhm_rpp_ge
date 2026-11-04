# Code review: Phase 4 findings rules

### F1 — Safe-state evidence exposes raw log text to customers

- Severity: medium
- Confidence: confirmed
- Location: `insight/findings/rules.js:107,113`
- What's wrong: `ctx.safe` carries the first 120 characters of the source fact's `value_text` as `msg`, and this rule copies it into each `evidence.codes` entry as `message`. The finding catalog defaults `customer_visible` to true, and the Phase 2 design says raw log text is internal. The extractor stores `firstLine(row.message)` without constraining it to a fixed vendor string, so this is raw message text, not just the safe-state code/count datapoints.
- Failure scenario: A safe-state finding is returned through the customer-facing findings view with the first 120 characters of a raw GE log message. If a message includes variable or internal material, the customer receives it despite the stated visibility boundary.
- Evidence: Read `insight/findings/load.js:26` (loads `left(value_text, 120)`), `insight/rules/ge_ct.js:212-214` (stores the raw first line), `insight/findings/rules.js:107,113` (copies it into finding evidence), and `PLAN-CT-INSIGHTS.md:480-485` (raw log text stays internal). No database query or probe run.
- Suggested fix: Keep only the code and counts in finding evidence, or add an explicit scrub/redaction boundary before customer-visible findings are served. If the message is intentionally retained for the internal report, separate that internal evidence from the customer-visible record.

### F2 — Future device-day power events can change an as-of safe-state result

- Severity: low
- Confidence: confirmed
- Location: `insight/findings/context.js:120,130-136`
- What's wrong: `build_context` filters safe-state events to `d <= today`, but builds `cycles` from every boot and shutdown without applying the same cutoff. Thus an event on a later device day can exclude an otherwise in-scope safe state. `verify_sql.js` repeats this behavior: the safe-state row is capped at today, but its `NOT EXISTS` boot/shutdown probe has no date cutoff (`insight/findings/verify_sql.js:96-100`), so the independent check agrees with the leak.
- Failure scenario: A safe state occurs within 30 minutes before midnight on the as-of day, and a boot or shutdown occurs just after midnight on the next device day. Replaying through the earlier day suppresses the safe state based on data that the as-of contract says to ignore. This is especially relevant where device clocks run ahead.
- Evidence: Read the JS filter and SQL predicates cited above, and the as-of rule in `PLAN-CT-INSIGHTS.md:1495-1499` plus the handoff's definition that later device days are ignored. No database query or probe run.
- Suggested fix: Apply the as-of device-day cutoff to the boot/shutdown candidates used for exclusion in both implementations. Preserve the ±30-minute rule for events at or before the as-of day.

### F3 — SQL verification drops replacement events when install date has no data day

- Severity: low
- Confidence: confirmed
- Location: `insight/findings/verify_sql.js:183-201`
- What's wrong: The JS event replay supports an install date that is not a system data day: it opens on that date and `day_start` uses the nearest data day's clock offset (`insight/findings/context.js:162-170`, `insight/findings/state.js:84-100`). The independent SQL instead inner-joins `rep2.inst` to `dd` at line 200. If there is no `dd` row exactly on the install date, the replacement disappears from the SQL result, so the verifier cannot reconcile it with replay.
- Failure scenario: A `tube.replacement` fact records an install date on a day with no other system facts. Replay emits a finding opened on the install date, while `FINDINGS_SQL` omits it; `compare_findings` reports a missing/extra row and verification fails for valid data.
- Evidence: Read the event replay, `day_start`, and SQL joins cited above. The handoff explicitly calls out an install date without a data day as a state-machine edge case. No database query or probe run.
- Suggested fix: Derive a replacement's opening instant in SQL using the nearest data day's offset, or define the opening day as an evaluated data day in both implementations. Add a fixture covering a replacement install date with no corresponding data-day row.
