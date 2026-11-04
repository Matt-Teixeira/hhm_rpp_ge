# Code review: Phase 5 ge_ct insight stage

### F1 — A failed batch commit can advance the recovery watermark past uncommitted facts

- Severity: high
- Confidence: confirmed
- Location: `insight/load.js:182-188,192-196`
- What's wrong: `apply_batches` assigns `watermark` and `watermark_capture` inside the `conn.tx` callback, after `write_job` but before the transaction has committed. If the transaction promise rejects during commit, control enters the catch with these local variables already advanced. The catch then writes an error job row using that advanced watermark. If that error write succeeds while the batch transaction rolled back, the next extraction starts after rows whose facts and pending touched days were never committed.
- Failure scenario: A batch callback succeeds, but PostgreSQL rejects or rolls back `COMMIT` (for example, a deferred constraint or commit-time failure). `conn.tx` rejects; the catch records `watermark = r.last_id`; a later run resumes after that id and permanently skips the batch.
- Evidence: Read `apply_batches`: the transaction callback sets the local watermark at lines 186-187, and the catch persists it at line 195. No database query or probe run.
- Suggested fix: Keep the candidate id and capture time local to the transaction callback, but update the outer watermark variables only after `await conn.tx(...)` resolves successfully. The error path should persist only the last transaction confirmed committed.

### F2 — The stage has no bounded connection-acquisition timeout

- Severity: medium
- Confidence: likely
- Location: `insight/index.js:50-51`; `insight/db.js:18,31-43`
- What's wrong: The stage sets statement and lock timeouts, but `connect()` does not configure a PostgreSQL `connectionTimeoutMillis` (or another deadline for acquiring a connection). Those timeouts do not apply while the new pool is still establishing its connection. `run_ct_insight` awaits `db.task(...)` before it can enter the `finally` block that closes the pool.
- Failure scenario: A database host or network path is unresponsive during connection establishment. The `ge_ct` process can remain waiting on the insight stage instead of reaching the catch/cleanup path promptly, despite the intended never-block-ingest contract.
- Evidence: Read the stage's `connect` and `db.task` calls and the pool configuration; the only configured timeouts are PostgreSQL session options for statements, locks, and idle transactions. The installed `pg-pool` 3.8.0 code only starts its connection timer when `connectionTimeoutMillis` is set. No database connection or probe was attempted.
- Suggested fix: Configure a short connection-acquisition timeout for the insight pool (and keep the existing statement/lock limits). Ensure a timeout is caught and logged as a skipped/failed insight stage.
