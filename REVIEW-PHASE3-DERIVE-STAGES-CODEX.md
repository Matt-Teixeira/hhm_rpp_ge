# Code review — Phase 3 checkpoint 3

### F1 — Touched daily rebuild can delete a day and miss its facts
- Severity: medium
- Confidence: confirmed
- Location: insight/derive/daily.js:64
- What's wrong: The touched-day rebuild uses a fixed `host_datetime` interval around the device `host_local` day (two days before through three days after). That is correct only while every fact's device-clock day stays within that margin of its absolute timestamp. No schema or code check enforces that bound; a device clock set several days off can have facts for the touched local day outside this interval.
- Failure scenario: a touched local day has facts whose `host_datetime` is more than the fixed margin away. The rebuild first deletes that day's existing aggregate, then its bounded aggregate query cannot see those facts, leaving the day missing or incomplete. A full rebuild would include them.
- Evidence: code inspection of `day_bounds()` and the touched branch in `rebuild_daily()` (`daily.js:64-82`). The comment at lines 60-63 assumes the difference is only a timezone offset, while `host_local` is explicitly the device wall clock and can differ because of clock error. No database query or test was run.
- Suggested fix: derive the scan bounds from the actual minimum and maximum `host_datetime` of facts for the selected system and local days, or remove the time bound when correctness cannot be established. Keep the local-day predicate so unrelated days are not aggregated.

### F2 — Derived-fact updates report only the new device day
- Severity: low
- Confidence: confirmed
- Location: insight/derive/derived_facts.js:31
- What's wrong: The upsert returns the updated row's `host_local` day, and that is the only day added to `changed_days`. If an existing derived fact is updated because its source's `host_local` changed across a day boundary, the old day is not reported. The touched daily stage then rebuilds the new day but leaves the old day's aggregate in place.
- Failure scenario: a source fact is re-extracted with a corrected device-local timestamp, moving a derived event from day A to day B. Stage 1 updates the existing derived fact and adds only B to the daily scope; stage 2 leaves the stale derived contribution on A.
- Evidence: code inspection: `UPSERT_SUFFIX` returns only `to_char(host_local, ...)` at line 31, and `derive_facts_for_system()` adds only returned `day` values at lines 49-59. `host_local` is among the columns updated when a conflict differs at lines 21-30. No database query or test was run.
- Suggested fix: capture the pre-upsert device day as well as the new day for changed rows, and add both to `changed_days` (for example, via a CTE that joins the existing derived row before the upsert).

