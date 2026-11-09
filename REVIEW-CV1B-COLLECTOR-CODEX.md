# Review: CV-1b collector change

## Finding

### P2 — Concurrent runs share and can delete each other’s temporary download

All five modified scripts use the same `$4/.sysError.log.part` path for every invocation, then independently test, rename, or remove it (`read/sh/GE/ge_cv_21.sh:16-22`; the four `ge_cv_22*.sh` scripts use the same sequence at lines 9-15). If a scheduled collection overlaps an IP-reset retry for the same system, one invocation can rename the other invocation’s file while it is still transferring, or its failure cleanup can unlink the other invocation’s in-progress file. The affected run may then either fail to publish a completed download or observe no `.part` file and exit with the transfer’s status of 0. In the latter case, `exec_hhm_data_grab` can classify the acquisition as successful although that invocation did not promote a file.

Use a per-invocation temporary path (for example, a name containing `$$`) and remove only that invocation’s path. Keep the final `mv` in the target directory so publication remains an atomic rename.

## Other reviewed questions

- For ordinary transfer outcomes, the scripts save `$?` immediately and exit with it after cleanup. The existing `exec_hhm_data_grab` classification of transfer failures based on stderr and exit code is therefore preserved; the changed lftp `get:` prefix is not used by the configured connection regexes. A rename failure is a new local filesystem failure and exits 1.
- The `get sysError.log -o ...` lftp invocation requests the same exact remote filename (no wildcard) and a specific local destination. I found no indication in the inspected configuration or scripts that this changes the relevant file selection. The handoff’s local lftp harness covers timestamp preservation and missing-file status, but I did not independently run lftp against an FTP server.
- The repository’s general directory reader is explicitly a one-off tool, and the searched acquisition paths did not reveal a routine consumer of `.sysError.log.part`.
- The `$4` expansion in the lftp command string remains unquoted, as in the original. The configured destination is an SME directory path without spaces.

## Verification

Static review only; no device was contacted and no collector harness was run. Unrelated SQL and `handoff/` changes in `hhm_data_acquisition` were not reviewed or modified.
