# Review: CV-1b parser fix

## Findings

### P3 — An unchanged unterminated tail warns on every run

`jobs/CV/sysError_parser.js:65-68` logs `File ends inside a line` whenever the bytes read extend past the last newline. The watermark correctly remains at the last complete line, so on every subsequent poll `plan_read` selects the same partial tail again. If the collector leaves a file without a final newline (or stalls while writing its last record), the same warning is emitted on every run until the file grows or rotates. This can make the run log noisy for a condition the parser is intentionally handling.

Consider logging only when the partial-tail byte count or file identity changes, or lowering this event to informational/debug level. The offset behavior itself is correct: the partial record is not parsed or committed.

## Reviewed paths

- Insert or duplicate-check failures do not reach the watermark writes. The duplicate guard fails open, and the insert is awaited before the offset update.
- The watermark is written before the head. If the process stops between writes, the next run sees the old head and compares it with the currently opened file before choosing the offset. If only the head write fails, `updateRedisLine` logs and returns; the unchanged file is re-read from the old offset on a later run, with the duplicate guard covering already inserted rows.
- The descriptor keeps reads on the opened inode if the path is replaced. As documented in the handoff, this does not protect against an in-place mutation of that same inode during the read.
- The CV datetime replacement uses the same format, default timezone, and `dateTimeTemplate` call as `generateDateTime`. Invalid Luxon input still returns `null`; an exception still produces `undefined`.
- The duplicate key includes all 18 parsed columns, normalizes the integer columns, and queries `host_date` as text. `mapDataToSchema` has already converted empty strings to null before the guard runs.

## Verification

Static review only; no tests or production operations were run.
