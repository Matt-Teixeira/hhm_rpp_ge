# Code review — Phase 3 checkpoint 2

### F1 — Same-time tube identity ties ignore record order
- Severity: low
- Confidence: confirmed
- Location: insight/rules/ge_ct_derived.js:124
- What's wrong: `tube_source` sorts identity facts by `host_datetime`, `epoch`, and `record_number_concurrent`, but stores only the timestamp of each verdict's first occurrence. If the most frequent verdicts tie and their first occurrences have the same timestamp, the comparison at line 124 always chooses `verified`, even when `unrecognized` came first in the source record order. The agreed tie rule is whichever verdict was seen first.
- Failure scenario: a segment has one `unrecognized` and one `verified` identity fact at the same `host_datetime`, with the unrecognized fact ordered first by epoch/record number. The counts tie, but the derived segment is labeled `verified`.
- Evidence: code inspection. `sorted()` uses the required secondary ordering at line 61; `tube_source()` then reduces `first` to millisecond timestamps and compares only those values at line 124. No database query or test was run.
- Suggested fix: retain the first fact's complete ordering tuple (or its sorted index) for each verdict, then compare those tuples when counts tie. Add a case where tied verdicts share a timestamp but differ in record order.

### F2 — Independent reset SQL includes non-finite counter values
- Severity: low
- Confidence: likely
- Location: insight/derive/verify_sql.js:41
- What's wrong: the JS rule excludes every non-finite `value_num` before ordering readings, while the SQL verifier filters only `NULL`. PostgreSQL `double precision` can hold `NaN` and infinities, so those values remain in the SQL window and can change the previous/next readings used to decide whether a reset stayed low. The two implementations can therefore disagree on systems containing such a row.
- Failure scenario: a non-finite reading appears between a large counter value and a low reading. JS drops it and compares the low reading with the preceding finite value; SQL keeps it in the ordered window and can use the non-finite value as the predecessor or one of the following readings. The reported independent reset result may then differ from the rule result.
- Evidence: code inspection of `find_resets()` at `insight/rules/ge_ct_derived.js:130-139` and the SQL window input at `insight/derive/verify_sql.js:35-38`. The fact column is `double precision`; no database query or test was run. The handoff reports no fleet differences on current data, but that does not cover non-finite values if none are present.
- Suggested fix: filter `NaN`, positive infinity, and negative infinity out of the SQL input to match JavaScript's `Number.isFinite` behavior, or define a shared explicit policy for them in both implementations.

