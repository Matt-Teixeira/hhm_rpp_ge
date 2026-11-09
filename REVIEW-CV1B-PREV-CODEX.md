# Review: CV-1b D5/D6 old-file tail handoff

## Findings

### P2 — Backfill can race the live parser and insert duplicate tail rows

`maintenance/backfill_ge_cv_prev_tail.js:74-80, 171-174` calculates `p.fresh` with the duplicate guard before asking for confirmation, then inserts that saved row set later in a separate transaction. If the D5 parser processes the same `sysErrorPrev.log` tail after the check but before the backfill INSERT, the backfill still inserts those rows. The target table has no content uniqueness constraint in this code path, and the row-count check only verifies that the INSERT inserted the requested number; it does not check for concurrent duplicates.

Coordinate the one-time APPLY with the live parser (for example, pause CV parser runs until the backfill commits), or add a serialization/recheck mechanism that is shared with the parser. The existing dry-run rollback and count safeguards do not close this race.

## Reviewed paths

- D5 reads the previous tail only on a `new_file` or `shrunk` full reread and only when `sysErrorPrev.log` has the stored old head and reaches beyond the old watermark. Missing, stale, too-short, or unidentifiable Prev files are skipped with a warning. The duplicate guard makes a retry after an insert failure safe; the old and new rows are inserted together before Redis is updated.
- The `file.head === null` wait does not move Redis. A stable empty or incomplete first record can delay this rotation until a complete first record is collected; with the described device behavior and atomic collector publication, this is a wait for the next useful poll. A second rotation before the next parser run can make the original tail unavailable because GE retains only one previous generation; the head check skips the wrong generation rather than reading it as the old file.
- The backfill’s complete-copy, parse, suffix, contiguous-sequence, and `--expect` checks are useful safeguards against selecting the wrong file. `db.tx` rolls back when the dry-run callback throws, and the callback verifies the inserted row count before it can commit.
- Collector transfers use separate temporary paths and only publish Prev after a successful main-file transfer; scp Prev errors are suppressed and do not change the main transfer result. The lftp Prev failure is handled by `|| !rm` before the main `get`; the final command remains the main transfer. I found no further issue in the reviewed collector diff.

## Verification

Static review only; no tests, collector harness, or production operations were run.
