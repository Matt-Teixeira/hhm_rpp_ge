# MRI-5 hook review

Reviewed on 2026-11-17: the uncommitted `index.js` and
`insight/mri/test/mri.test.js` changes in the `mri5-hook` worktree based on
`95797ea72a91af584381699295c88701df576d35`, as identified by
`REVIEW-MRI5-HOOK-HANDOFF.md`.

## Findings

No correctness findings in the hook changes. The MRI branch, awaited
stage call, and guarded fallback logger preserve the intended failure
boundary. CT's and CV's hooks are unchanged.

## Review notes

- **Ingest ordering:** the hook starts after every awaited `run_job`
  returns. The MRI parser's source insert, Redis offset update, and
  host-datetime upsert are awaited before that return. The hook changes
  neither their arguments nor their order. With MRI enabled, stage work
  delays the final run-log write and process completion, as intended.
- **One correction to the handoff's claim that ingest is completely
  finished:** `tooling/gzip_file.js:71` calls `db.none(...)` without
  awaiting or returning its promise. Consequently, awaiting
  `gzip_n_save` does not guarantee that the `log.saved_files` insert has
  completed. A DB-free probe with a deliberately pending insert confirmed
  that the helper returns first. A saved-file insert can therefore still
  be outstanding on the main pool when the stage starts. This behavior
  predates the hook; the stage reads the already-awaited
  `log.ge_mri_gesys` rows and does not close the main pool. I would correct
  the handoff's absolute ordering claim, without expanding this hook
  change into a shared ingest-helper fix. The fake-parser harness cannot
  establish completion of those real saved-file writes.
- **Disabled behavior:** the added require loads only MRI's lightweight
  index module. Unless `INSIGHT_MRI_ENABLED` is exactly `"true"`, that
  module returns before loading the wrapper, database helper, or stage,
  and emits no event. MRI's disabled harness cases preserve the previous
  ingest trace and run-log events. CT and CV do not enter the new branch,
  even when MRI's switch is on.
- **Errors and run logs:** both a failed require and a stage rejection
  produce the expected ERROR / `run_mri_insight` / CATCH fallback event.
  If that logger rejects too, the inner catch still reaches the normal
  final log write. The hook introduces no new rejection escaping this
  boundary. Existing failures elsewhere in `on_boot`, including the
  outer catch's unguarded logger, remain outside that guarantee.
- **Pools, environment, and production logger:** the stage uses its own
  writer pool and closes that pool, rather than calling a global pool
  shutdown or touching the ingest pool/Redis client. The added call
  shares only `run_log` and `addLogEvent` with ingest. Reading the local
  and production logger/enums confirmed compatible signatures and the
  same INFO/WARN/ERROR and DETAILS/CATCH values; `addLogEvent` appends to
  the supplied event array. Root-index dotenv loading remains unchanged;
  enabled-stage loading uses the existing repo-relative insight database
  helper. No environment override is added by this diff.
- **Overlap:** the wrapper's five-minute work deadline starts after
  connection acquisition, which has its own ten-second limit. The
  measured ordinary durations supplied in the handoff leave substantial
  room within the 30-minute cadence. Overlapping MRI stages use the same
  advisory lock and skip rather than queue; that lock does not serialize
  ingestion itself. CT/CV use different locks and distinct row namespaces
  in the shared tables. I found no new cross-modality lock dependency.
- **C1-MRI combination:** both supplied C1-MRI patches applied cleanly
  over a temporary copy of the hook tree. The proposed stage-preflight
  test flip is correct: once all three CT verifiers export `MRI_AWARE`,
  the valid limited-writer/schema-9 case succeeds. The superuser,
  wrong-role, and missing-C2 refusals remain covered and passed. The
  combined MRI interlock tests still check refusal using fake modules
  that lack `MRI_AWARE`; the flip does not remove that protection.

## Verification

- In the hook worktree: `mri.test.js` passed 24/24, `cv.test.js` passed
  17/17, and CT `stage.test.js` passed 23 with the documented one skip
  for missing `PG_SSL_PATH`.
- MRI `stage.test.js` passed 26/27. Its fresh-process test could not
  complete here: nested `spawnSync` reports `EPERM` in this sandbox and
  supplies empty stdout, causing the subsequent JSON parse to fail.
  A standalone child-process probe reproduced that restriction; the
  equivalent MRI disabled-loading check passed when run directly in a
  fresh process. This is a verification limitation, not evidence of a
  hook regression. Overall: 90 passes, one expected skip, and this one
  environment-limited test.
- Read the DB-free hook harness, then reran a copy in `/tmp` against
  freshly captured baseline and worktree index files. All 11 scenarios
  satisfied additional assertions: unchanged ingest traces; identical
  CT/CV outputs; unchanged disabled-MRI events; stage after 3/3 completed
  parser calls and before log writing; exact fallback error fields; final
  log writing after logger failure; no reported unhandled rejection or
  extra active handle. Enabled stages were stubbed, so this does not
  measure real database contention or live pool cleanup.
- In the temporary hook + C1-MRI + test-flip copy: MRI core 25/25,
  MRI findings 27/27, and CT catalog-scope 7/7 passed. Independently ran
  all four assertions from the proposed stage-preflight flip; they passed.
- `node --check index.js` and `git diff --check` passed.

No database connection, live ingest, CLI command, migration, or deployment
was run. The actual worktrees and plan were left unchanged; only this
review file was added to the main checkout. Harness outputs and combined
verification copies were confined to `/tmp`.
