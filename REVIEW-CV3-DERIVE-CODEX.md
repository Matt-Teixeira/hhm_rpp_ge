# Review: CV-3 derive

## Findings

### P2 — A failed code rebuild can leave no pending work to retry it

`run_derive()` commits each system’s daily rebuild and clears that system’s pending entry in `derive_system_tx()`, then rebuilds `ge_cv_codes` in a separate transaction (`insight/cv/derive.js:228-239`). If the process stops after all daily transactions commit but before `rebuild_codes()` commits, the pending map is empty. A subsequent default `derive --apply` therefore has an empty scope and skips the code rebuild, leaving stale code labels until someone runs `--full` or new facts create pending work.

Keep a durable code-rebuild pending marker until the code transaction commits, or otherwise make code rebuilding part of retryable work that is not cleared with the daily entries. The existing error status records the failure but does not cause the next run to retry codes.

### P3 — SQL label verification is not equivalent to JS for every Unicode input

For the ASCII GE text in the checked corpus, `TPL` and `template()` agree. For arbitrary UTF-8 input they can differ: JavaScript `.slice(0, 200)` counts UTF-16 code units, while PostgreSQL `left(..., 200)` counts characters. For example, a supplementary-plane character at the 200-character boundary can be split by JS but remains whole in SQL. Also, JS `\b` uses ASCII word characters here, while PostgreSQL `\m` / `\M` word boundaries follow PostgreSQL’s locale rules. Such text could make check D report a label mismatch even when the rebuild is deterministic.

Either constrain/normalize label input to the supported ASCII alphabet, or align both implementations’ boundary and truncation semantics and add corresponding non-ASCII tests. The reported corpus rehearsal found no current mismatch.

## Reviewed paths

- Daily full and touched-day rebuilds delete the old rows before inserting from `host_local`; an emptied day is therefore removed. The range join uses inclusive day start and exclusive next-day start, matching `host_local::date`. Since extraction constructs `host_local` from source `host_date` and `host_time`, the day keys agree for storable rows. `value_last` uses descending device time with fact id as a deterministic tie-breaker.
- Extract and derive take the same advisory lock. An extract cannot add pending days between derive’s pending read and clear; a later extract records its days after derive releases the lock. The `write_last_run` JSON merge preserves the pending map.
- Code aggregation keeps counts and timestamps from facts when a source row is missing; labels then use only surviving source debug text. As the plan’s §9.3 known limit says, source-based verification A, B, and D must be restricted to retained source partitions if log retention is introduced. There is no evidence of dropped CV log partitions today.
- Full code rebuild scans the facts and joins source rows, but the table is currently modest and the inventory has only about 200 codes. Scaling the current six-month volume to 18 configured systems is still a reasonable v1 workload; revisit if retention or collection restoration increases volume materially.
- The mode tie-break using JavaScript string order and SQL `COLLATE "C"` agrees for the current ASCII labels and source fields. K1 (no clock table in v1) is sound for device-day counts and planned per-device findings; the reported offset matters for absolute timestamps, which the viewer should identify as device time.
- Daily facts and code labels provide the device day, metric/dim counts, code counts, source attributes, and time bounds CV-4 needs. No additional derive field appears missing for the planned findings.

## Verification

- `node insight/cv/test/derive.test.js`: 8 passed.
- `node insight/cv/test/cv.test.js`: 15 passed.
- No CV CLI or database migration commands were run.
