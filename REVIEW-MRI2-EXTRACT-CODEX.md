# Review: MRI-2 extract

## Findings

### P2 — Late conflicting rows can bypass the apply conflict check

[load.js](/home/matt-teixeira/hep3/hhm_rpp_ge/insight/mri/load.js:234) selects late rows only when no `mri.error` fact exists for their natural key. If a late-committed row has a key already stored from an earlier source row, it is filtered out before `reread_late()` calls `check_conflicts()`. This includes the important case where the late row has different `(message_number, type, message)` content: `--apply` will neither reject it nor report the conflict in that run, even though `CONFLICTS_SQL` later makes `verify` fail. That conflicts with the stated behavior that a late conflicting record refuses the write.

Have the late reread pass such rows to `check_conflicts()` as well—for example, select rows not represented by their source primary key rather than rows whose natural key has no fact. Identical re-sends can then be counted as known duplicates, while different content is rejected before the batch commits. Also, `reread_late()` runs before `apply_range()`'s error-recording `try` block, so a conflict it does detect leaves the previous job status in place instead of recording `error`.

### P2 — Verify can pass with stale facts after a rule-version bump

[verify.js](/home/matt-teixeira/hep3/hhm_rpp_ge/insight/mri/verify.js:42) compares fact counts, `mri.error` dimensions, and scan sums, but never checks `ge_mri_facts.rule_version`. After a rule changes and its version is bumped, the normal apply starts at the existing watermark; older facts are therefore not revisited. A change to attributes, dimensions, or another output that preserves the checked aggregates can leave old-version facts in place while `verify` reports success. Check each stored fact's version against its metric's registry version (or otherwise make replay coverage explicit) so the exit gate detects stale rows.

## Reviewed paths

- The registry has the agreed 22 named metrics plus `mri.error`; the independently written SQL conditions cover the same metric/code set. The process-death rules exclude dsserver and code 200002379, and the scan/system-up matchers align with the SQL conditions. Device-local partition filtering uses the same epoch-derived timestamp bounds as migration 009.
- The natural-key dedupe is stable for id-ordered batches, and the first stored row remains the source for same-version re-sends. The identity definition (code, type, message) matches plan §6.6; `coil`, `psd`, and `host_datetime` are not part of the agreed conflict identity.
- Facts, the batch watermark, and derive-pending days are written in one batch transaction. The preflight checks schema/version, writer identity, C2-MRI, and—only for apply—the CT `MRI_AWARE` interlock. Catalog writes during rehearsal are inside its rollback transaction, so the interlock is not needed there.
- The fixture masking covers the identifiers named in the handoff in the reviewed samples; I found no obvious host, system ID, MAC, IP, UDI, or AE title left in the checked fixture text. The shared `../db` require loads dotenv configuration but does not connect until `connect()` is called; the other shared imports are load-time definitions only.
- The verifier independently checks per-system/metric counts, per-system/code counts, scan totals, source coverage, natural-key conflicts, and the MRI catalog key/version set. Unreviewed codes are surfaced as a note, as planned.

## Verification

Source review only. I did not run tests, the MRI CLI, fixture generation, or database commands; the handoff reports the test and throwaway-database results.
