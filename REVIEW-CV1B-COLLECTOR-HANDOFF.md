# Review handoff: CV-1b collector change (download sysError.log to a temp name, then rename)

Repo: **`hhm_data_acquisition`** (`~/hep3/hhm_data_acquisition`), branch
`DEV`. The change is **uncommitted**, on top of `8834a67`. Please write
findings to `REVIEW-CV1B-COLLECTOR-CODEX.md` (in the `hhm_rpp_ge` root,
next to this file).

That working tree also has unrelated WIP by the user:
`db/normalize/prod/*.sql` and the untracked `handoff/`. They are **not
part of this review**; don't edit them.

## What to review

```
cd ~/hep3/hhm_data_acquisition
git diff -- read/sh/GE/ge_cv_21.sh read/sh/GE/ge_cv_22.sh read/sh/GE/ge_cv_22_1.sh read/sh/GE/ge_cv_22_2.sh read/sh/GE/ge_cv_22_3.sh
```

These are the five scripts `config.acquisition` uses for GE CV/IR:
- `ge_cv_21.sh`: lftp FTP, 12 systems, including the two live ones;
- `ge_cv_22*.sh`: scp via `sshpass`, 7 systems.

`ge_cv_sftp.sh` is unused and unchanged.

## Why

`hhm_rpp_ge` parses `files/<sme>/sysError.log` every 30 min (:18/:48).
The collector (`ge_cv` job, :00/:30) overwrote that file in place:
- `lftp mget` with `xfer:clobber true`, or `scp` straight onto the name;
- a transfer that dies part-way therefore leaves a short file under the
  real name.

The new parser (`REVIEW-CV1B-PARSER-HANDOFF.md`) copes with a short file:
it reads the whole file, and its duplicate guard drops what is already
stored. A short file is still wrong input, though. The CT precedent is
`PLAN-CT-INSIGHTS.md` §11.4 step 3. Background: `PLAN-CV-INSIGHTS.md`
§5.1 and §5.5 D3a.

## The change (the same block in each script)

- The transfer writes to `$4/.sysError.log.part`: lftp uses
  `get sysError.log -o …` instead of `mget sysError.log -O $4`; scp just
  gets that destination.
- Then:
  - transfer exited 0 and the temp file exists → `mv -f` it over
    `$4/sysError.log` (same directory, so a rename); if `mv` fails, exit 1;
  - otherwise → `rm -f` the temp file.
- The script exits with the transfer's status.

## Constraints the change must keep

`read/exec-hhm_data_grab.js` decides online / offline / retry from the
script's stdout, stderr and exit code, against
`util/tools/connection_regex.js`. These must not change for any outcome.

Known difference: lftp error lines start `get:` instead of `mget:`. No
regex reads that prefix.

## Already verified (by the author, locally; no device was contacted)

Harnesses are in the author's scratchpad
`/tmp/claude-1018/-home-matt-teixeira-hep3-hhm-rpp-ge/1894fa50-36db-4fcc-bd12-e9b53eaca8df/scratchpad/collector_test/`.

**`ge_cv_21.sh`.** A copy has its `open ftp://…` replaced by
`open file:/` and the `cd` re-rooted to a local tree. It ran side by side
with a copy of the original from `HEAD`.

| Case | Original | New |
|---|---|---|
| Success | exit 0, no output | same; file byte-identical, remote mtime kept, no `.part` left |
| Success over an old file plus a stale `.part` | exit 0 | same; `.part` gone |
| Remote file missing | exit 1, `mget: Access failed: …` | exit 1, `get: Access failed: …`; old file kept |
| Remote dir missing | exit 1, `cd:` + `mget:` lines | exit 1, `cd:` + `get:` lines; old file kept |
| Replace | n/a | new inode; a reader holding the old file still reads the old content |

**`ge_cv_22*.sh`.** A fake `sshpass` first on `PATH`:

| Case | All four scripts |
|---|---|
| Copy succeeds | exit 0; file replaced |
| `scp: No match.` | exit 1, the message passed through; old file kept; no `.part` |
| Dies after writing 5,000 bytes, `Connection … timed out` | exit 255, message passed through; **old file kept**, partial removed (before: the partial replaced `sysError.log`) |

## Questions for the reviewer

1. **Same outcome classification?** Does any path change what
   `exec-hhm_data_grab.js` would classify, including `error.code === 124`
   and an `execFile` rejection?
2. **lftp `get -o` vs `mget -O`.** With `xfer:clobber true` and the
   `cd` into a path with escaped spaces: any difference in behaviour,
   such as mtime preservation, a remote file name glob, or the exit
   status when the file is missing?
3. **The hidden `.sysError.log.part`.** Anything that lists or syncs
   `files/<sme>/` and would pick it up? `jobs/read_dir.js` is a one-off
   dev tool. Also consider `relocate_files/`, althea, and any backup.
4. **Two collector runs for one system at once** (e.g. the `ip` reset
   job retrying while the scheduled run is still going): do they race on
   the one temp name? Is that worse than before, when both clobbered the
   real file?
5. **`$4` unquoted inside the lftp command string**, as in the original.
   Acceptable, given the paths are `.../files/SMExxxxx`?

---

## Round 2: fix for REVIEW-CV1B-COLLECTOR-CODEX P2 (shared temp name)

Same five scripts, same diff command. The change:

- **Temp name per run.** `tmp="$4/.sysError.log.part.$$"`. The transfer
  writes there (lftp `get sysError.log -o $tmp`; scp to `$tmp`).
- **Cleanup.** `trap 'rm -f "$tmp"' EXIT` removes it on every exit,
  including SIGTERM. The old `else rm -f` branch is gone.
- **Sweep.** At the start of each run, temp files older than 2 h are
  removed (left behind after SIGKILL or a reboot):
  `find "$4" -maxdepth 1 -name '.sysError.log.part*' -mmin +120 -delete 2>/dev/null`.
  The runner (`exec-hhm_data_grab.js`) calls `execFile` without a
  timeout, and the transfers are bounded (lftp `net:timeout 20` with 2
  retries; scp `ConnectTimeout=30` and `ServerAlive` 10 s × 6). So no
  live run is near 2 h old.
- **Publish.** `if [ $rc -eq 0 ]; then mv -f "$tmp" "$4/sysError.log" || exit 1; fi; exit $rc`.
  With the old `[ -f … ]` test removed, a run whose transfer exited 0 but
  whose file is gone now exits 1, with mv's message on stderr, instead of
  0. That message matches no regex in `connection_regex.js`, so it takes
  the same generic error path as before.

Local harness results (scratchpad `collector_test/`; lftp against
`open file:/`, scp via a fake `sshpass`):

| Case | Result |
|---|---|
| Success (lftp and all four scp scripts) | exit 0, no output, file byte-identical (lftp keeps the remote mtime), no temp file left |
| Success with a 3 h old temp file plus a fresh temp file of another run | stale one swept; the other run's file left alone |
| Remote file missing (lftp) / `scp: No match.` | exit 1, message passed through, old file kept, no temp file |
| Partial transfer, `Connection … timed out` | exit 255, message passed through, old file kept, no temp file |
| Exit codes vs `HEAD` scripts | identical (1 / 255) |
| **Overlap:** run A slow, run B starts later and fails part-way | B exit 255; A exit 0 and publishes the full file (before: B's `rm -f` deleted A's download, and A exited 0 without publishing) |
| SIGTERM during the transfer | exit 143; trap removed the temp file; old file kept* |
| SIGKILL during the transfer | exit 137; temp file left, swept after 2 h; old file kept |

\* The fake transfer writes its destination twice, so after the script
died it recreated the temp file. A real scp or lftp opens the destination
once and keeps writing to the unlinked inode. Either way the leftover is
swept by the 2 h rule.
