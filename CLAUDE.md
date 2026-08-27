# CLAUDE.md

> **Migrated to the fleet dev/release paradigm 2026-08-26** (fourth app, after
> data_acquisition, monday, hhm_rpp_siemens). Conventions:
> `data_acquisition/docs/migration_CLAUDE.md` Part 1. Dev clone:
> `~/apps/hhm_rpp_ge`; `/opt/apps/hhm_rpp_ge` is build output produced ONLY by
> `build-release.sh`. Cutover verified over two cron cycles (2026-08-26 13:15 +
> 13:45 UTC: all three families, all `RELEASE_SHA=a957a59`, zero `dev-tree`,
> warns in the pre-migration band).

**hhm_rpp_ge** is a Node.js parser: it incrementally reads GE equipment log
files (fetched to `/opt/resources/acqu_files/<SME>/` by data_acquisition every
30 min), tails only the new bytes since the last run (Redis byte-size cursor),
parses per-modality, and bulk-inserts to PostgreSQL (`log.ge` tables via
`utils/db/sql/pg-helpers_hhm.js`; gzipped source snapshots to
`log.saved_files`). Run-once by design — triggered on a schedule, not a
long-running service.

**This repo OWNS the shared image `hhm_rpp:<tag>`** (built from
`docker/Dockerfile`), consumed as-is by hhm_rpp_philips and hhm_rpp_siemens —
neither has a Dockerfile, on purpose. Tag scheme (settled with the siemens
migration 2026-08-25): dev builds tag `hhm_rpp:<username>`, the release builds
`hhm_rpp:svc`, and all three consumers carry `IMAGE_TAG=svc` in their release
`.env`s. The transitional `staging` alias (kept for philips until its
2026-08-26 migration) was retired 2026-08-27: the re-tag step is gone from
`build-release.sh` and the tag itself removed (`hhm_rpp:pre-ge-migration`
remains the named rollback handle).

## Run arguments (job families)

| argv | boot query filter | status |
| --- | --- | --- |
| `GE_CT` | GE, modality `LIKE '%CT'`, run_group 1, process_log | **live** — user crontab `15,45 * * * *` |
| `GE_CV` | GE, modality `CV/IR`, run_group 1, process_log | **live** — same cadence |
| `GE_MRI` | GE, modality `MRI`, run_group 1, process_log | **live** — same cadence |

Baseline (48h to 2026-08-26 12:15 UTC, `util.app_run_logs`): 95 runs per
family (every `:15/:45` tick), warns+errors per run ≈ 52 (CT) / 2 (CV) /
16.5 (MRI). Judge post-migration health against this band, by family — not by
whether warnings exist.

Incremental mechanism: Redis key `<SME>.<file_name>` holds the last seen
**filesize in bytes**; a run tails `-c<delta>` and advances the cursor only
**after** a successful insert. Overlapping runs of the same family would
double-insert — cron entries must use `flock -n` (pre-migration entries do
not; fixed at cutover).

## Schedule (matt-teixeira's USER crontab — hardened 2026-08-26)

```cron
15,45 * * * * sleep 0  && cd /opt/apps/hhm_rpp_ge && /usr/bin/flock -n /tmp/hhm_rpp_ge.ge_ct.lock  /usr/bin/docker compose run --rm -T app_tools node index.js GE_CT  >/opt/run-logs/hhm_rpp_ge/cron.ge_ct.out 2>&1
15,45 * * * * sleep 20 && cd /opt/apps/hhm_rpp_ge && /usr/bin/flock -n /tmp/hhm_rpp_ge.ge_cv.lock  /usr/bin/docker compose run --rm -T app_tools node index.js GE_CV  >/opt/run-logs/hhm_rpp_ge/cron.ge_cv.out 2>&1
15,45 * * * * sleep 40 && cd /opt/apps/hhm_rpp_ge && /usr/bin/flock -n /tmp/hhm_rpp_ge.ge_mri.lock /usr/bin/docker compose run --rm -T app_tools node index.js GE_MRI >/opt/run-logs/hhm_rpp_ge/cron.ge_mri.out 2>&1
```

Cadence unchanged from the legacy entries (`:15,:45`, ~2 min after
data_acquisition's `:00/:30` fetch completes). Direct `node index.js GE_*`
argv keeps `argv[2]` identical to the old npm-run mapping, so ops-dashboard's
job label is unaffected. `flock -n` because the Redis cursor advances after
insert — overlap would double-insert. Per the fleet standing decision these
entries STAY in the user crontab (consolidation into svc's crontab is
data_acquisition BACKLOG 6f, a separate follow-up). The schedule is host
configuration — changing a cadence needs no release. Pre-cutover backup:
`~/cron-bk/user-crontab.bak-2026-08-26-pre-ge-cutover`.

## Exit-code / run-record contract (KEEP — consumers depend on it)

- **run_outcome/v1** (audit OPS-03): 0 success/skipped, 1 failed, 2 partial or
  self-log persistence failure, 3 usage error. ops-dashboard and
  incident-engine consume the exit codes and the terminal `run_outcome` event
  (type INFO on purpose — it must never land in `warn_error_logs`). **Never
  regress to exit-0-on-failure.**
- **Event 0's note shape is load-bearing**: ops-dashboard derives this app's
  job label from `verbose_log->0->'note'->'argv'->>2`. Do not reshape `argv`.
- Run record: `util.app_run_logs` (app_name `hhm_rpp_ge`) + JSON file per run,
  tagged by `USER_ID` (your username in dev, `svc` in a release). Rows before
  2026-08-26 ~13:00 UTC carry the retired `LOGGER` tag (`dev`) in filenames
  and no `RELEASE_SHA` in event 0 — that is history, not a bug.

## KNOWN WARTS (deliberate — do not "fix" casually; per-item sign-off to remove)

- `redis/redisHelpers.js:44` (`getRedisFileSize` catch): references an
  undeclared `note`, so a Redis GET failure throws `ReferenceError` from the
  catch and mislabels the cause. Known, kept as-is 2026-08-26 (owner chose
  document-over-fix during migration).
- **Cursor re-measurement window**: `updateRedisFileSize` re-runs `wc --bytes`
  after the insert instead of reusing the size captured before the tail; bytes
  appended between the two reads are skipped permanently. Narrow, real,
  deferred — a behavior change needs its own change.
- `GE_CT`'s boot query matches modality `LIKE '%CT'` but `index.js` dispatches
  on exact `"CT"` — a future GE `PET/CT`/`SPECT/CT` system in run_group 1
  would throw `E_UNKNOWN_MODALITY` every run (exit 2, partial). Latent.
- Museum code retained pending post-cutover cleanup (deferred by decision):
  `utils/vpn/` (cannot even load — requires a nonexistent `ipsec_data.json`;
  contains the only non-logger file writer, dead), `utils/config-processor/`,
  `utils/units/`, `utils/sh/`, dead `utils/db/sql/sql.js` + non-GE SQL trees,
  `utils/db/pg-pool copy.js` (orphan), `utils/logger/stamp_compress.sh`
  (pre-Docker paths), unused `pm2` dependency, dead redis helpers
  (`getRedisLine`/`updateRedisLine`/`dp:queue`/`file_dt:queue` surface),
  empty `read/index.js` / `processing/index.js`.
  **NOT museum:** `utils/db/sql/pg-helpers_hhm.js` is LIVE here (log.ge
  column sets + `meta_data.logfile_event_history_metadata`) — unlike mmb-rpp,
  do not prune it.
- `PG_SSL_PATH` is set but functionally unread with `PG_SSLMODE=require`
  (pg-pool returns before the CA branch). Kept: flipping to `verify-ca` later
  needs it in place.

## Running

```bash
bash preflight-check.sh          # expect ZERO warnings
bash build.sh                    # deps in-tree + dev log dir + builds hhm_rpp:<USER_ID>

# Development — from the dev tree (~/apps/hhm_rpp_ge), as yourself
RUN_USER=<you> docker compose run --rm app_tools node index.js GE_CT   # or GE_CV / GE_MRI

# Production — from the release copy, RUN_USER omitted (entrypoint defaults to svc)
cd /opt/apps/hhm_rpp_ge && docker compose run --rm app_tools node index.js GE_CT

# Release
bash build-release.sh            # refuses on a dirty tree; stamps RELEASE_SHA
```

Run logs: dev → `./utils/logger/logs/`, release → `/opt/run-logs/hhm_rpp_ge/`
(`hhm_rpp_ge-log.<USER_ID>.<run_id>.json`; read with `cat`, never open in an
editor). A dev run is a REAL run: it advances the same Redis cursors and
inserts into the same staging tables as production — time dev smokes away
from the `:15/:45` cron ticks so two runs of one family never overlap.

### Dev-phase verification (2026-08-26, pre-cutover)

- preflight: 52 OK / 0 warnings / 0 errors.
- Dev smoke `GE_CV` as matt-teixeira: success exit 0, 2 warns (normal band),
  log in-tree tagged `matt-teixeira`, DB row `RELEASE_SHA=dev-tree`,
  `/opt/run-logs/hhm_rpp_ge` untouched.
- SIGTERM mid-run (`GE_CT`): both sinks flushed exactly once (1 DB row),
  fatal `E_SIGNAL`, outcome failed, honest exit 1.
- Clean-tree guard: untracked file → refusal, exit 1, `$DEST` untouched.

## Environment / secrets

- `.env` is gitignored; `.env.example` is the tracked record of required keys.
- PG + Redis credentials come from root-only `/opt/resources/secrets/`; this
  app **is registered** in the host rotation script
  (`/opt/resources/scripts/rotate-envs-20260817.sh`), which rewrites BOTH
  copies (`/opt/apps/hhm_rpp_ge/.env` and `~/apps/hhm_rpp_ge/.env`) by
  matching the current value — both copies must keep values matching the
  reference (verified matching 2026-08-26).
