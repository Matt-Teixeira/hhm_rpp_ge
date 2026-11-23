# MRI-5b review

Reviewed the uncommitted change on `dev`, HEAD `63e25fc`, on 2026-11-23.
Read `REVIEW-MRI5B-HANDOFF.md` first and PLAN-MRI-INSIGHTS.md §12.1–12.6.
Compared both callers with `886c0e5`; those old wrappers also match HEAD.

One P3 finding remains in rehearsal failure reporting. I found no P1/P2
issue or live CT/CV wrapper regression that would change ingest behavior,
materially increase its duration, or prevent its run log from being written.

## P3 — Avoid querying the aborted rehearsal transaction after a SQL failure

Locations: `insight/stage.js:194` and `insight/cv/stage.js:229`.
CV also performs unconditional reads at `insight/cv/stage.js:268` and
`insight/cv/stage.js:272` after the guarded verification block.

**Failing scenario:** an extract source read fails with a SQL error outside
a nested transaction/savepoint, for example a statement timeout or query
cancellation on the source maximum-ID query. The real CT and CV extract
steps perform that query directly on the supplied connection
(`insight/load.js:292`, `insight/cv/load.js:316`). During rehearsal that
connection is the outer transaction, so the SQL error leaves it aborted.
`run_stage` catches the step failure, retains its original error, and
returns `ok: false` (its watermark read also fails).

The fixed loop now correctly stops and aggregates only executed runs, but
the checks still unconditionally call `read_derive_pending(t)` in CT or
`derive_state(t)` in CV. These queries reject with SQLSTATE `25P02`,
"current transaction is aborted". That rejection occurs before the
structured rehearsal result is attached to the intentional rollback
exception. The caller therefore receives the secondary database error
instead of the failed result, executed runs, and `not_run` list. CV's
post-rollback watermark check is also bypassed. Rollback and unlock still
occur. This is a remaining limitation of the rehearsal fix, inherited
from the old code; it does not affect the live ingest path.

**Evidence:** a DB-free probe loaded each actual stage module with fake
dependencies and a transaction-aware fake connection. The extract query
raised `57014` and marked the transaction aborted; subsequent queries
raised `25P02` until rollback. Both rehearsals logged the original extract
timeout but rejected with `25P02`. Both recorded
`lock → tx → rollback → unlock`. The appended regression tests throw a
JavaScript error without aborting the fake transaction, so they do not
cover this case.

**Suggested fix:** on a failed run, assemble the failure result from the
already captured data and immediately trigger the intentional rollback.
Skip all further SQL inside that transaction, marking unavailable checks
as skipped/unknown. In CV this includes the later CT fingerprint and count
reads, not just `derive_state`. Alternatively, isolate each rehearsal run
in a savepoint and explicitly roll it back when `run_stage` returns a
failure before querying further. Add a fake-transaction regression that
rejects queries after a SQL failure until rollback and asserts that the
original error, executed runs, and `not_run` are returned.

## Checks and results

- **Wrapper equivalence:** reran `equiv.js` directly against the existing
  old-wrapper copies, first verifying those copies byte-for-byte against
  `git show 886c0e5:…`. All 26 scenarios were identical. Repeated the six
  configuration mutations in memory; every mutation was detected. No
  evidence files were rewritten.
- **Root hook:** inspected the harness and recorded comparison, then
  reran the five scenarios from its own directory. Also compared old/new
  callers by loading the verified old wrapper sources in memory; root
  `index.js` is unchanged from HEAD. CT/CV off, CT/CV on with stubbed
  stages, and MRI off were identical. Logs were written after all three
  fake system ingests and the stage; no extra handles remained. The on
  hook cases intentionally stub the callers; the separate equivalence
  harness exercises the actual enabled wrappers with fake connections.
- **Tests:** ran all 25 test files: 345 passed, one failed. The existing
  MRI fresh-process isolation test at `insight/mri/test/stage.test.js:608`
  fails parsing empty child stdout because this sandbox's `spawnSync`
  returns `EPERM`. A minimal subprocess probe confirmed that restriction;
  running the test's switch-off probe directly in a fresh process passed.
  Both new CT/CV rehearsal regression tests passed. This is not a claim
  that the complete suite passed here.
- **CT rehearsal success:** compared old/new CT stages with fake
  dependencies in 12 cases: success, each of the three verifier failures,
  derive fingerprint/change failures, replay fingerprint/change failures,
  findings drift, pending work, unequal watermarks, and incomplete
  catch-up. Results matched after excluding timing and the new
  `not_run` field; only the success case returned `ok: true`.
- **Loading and exports:** fresh-process probes confirmed that requiring
  CT/CV, enumerating their exports with `Object.keys`, and invoking them
  while disabled load no dependencies. Spreading the exports invokes the
  lazy getters and loads only the dependency-free shared wrapper. All
  four timeout values match the old exports. The production root hook
  destructures only the function; no other production consumer of the
  constants or export spreading was found in the inspected source.
- **Failure boundaries and production integration:** inspected rules
  resolution before connecting, lock/preflight/deadline messages,
  partition warning text, UUID handling, run-stage options, step/summary
  logging, throwing logger protection, deadline kill and late-event
  suppression, unlock/release/pool cleanup, and the root fallback logging
  and final log write. Checked the gitignored logger/enums source without
  loading it. The enum strings match. The shared helper still resolves
  the same `insight/db.js`, whose dotenv path remains the repository root.
- **Static checks:** `node --check` passed for both callers, both changed
  stages, and the shared wrapper; `git diff --check` passed.
- **Deployment design:** no additional defect found in activating both
  callers on pull or restoring the old wrappers by reverting the eventual
  commit. This change introduces no schema or persisted-state dependency
  on the wrapper implementation. The monitor-first and three-day watch
  remain deployment checkpoints; production timing and database state
  were not measured in this DB-free review.

No database command, CLI command, migration runner, or real enabled stage
was run. No `.env` file was opened or printed for inspection, and
`/home/prod/hhm_rpp_ge` was not accessed. Only this findings file was edited.
