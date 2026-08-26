# CLAUDE.md

> **MIGRATION IN PROGRESS (started 2026-08-26)** — aligning to the fleet
> dev/release paradigm (`data_acquisition/docs/migration_CLAUDE.md` Part 1;
> fourth app, after data_acquisition 2026-08-24, monday 2026-08-25,
> hhm_rpp_siemens 2026-08-25). Until this banner comes off, sections below may
> describe pre-migration state; each is corrected in the commit that changes
> it. The live tree at `/opt/apps/hhm_rpp_ge` is **FROZEN** as of this commit —
> all code work happens in the dev clone `~/apps/hhm_rpp_ge`, and production
> cron keeps running the old code until `build-release.sh` replaces
> `/opt/apps/hhm_rpp_ge` in one step. Migration checklist authority:
> migration_CLAUDE.md **Part 3** (no rival checklist here, on purpose —
> the old `docs/run.md`/`docs/setup.md` were deleted in this commit as
> pre-paradigm rivals).

**hhm_rpp_ge** is a Node.js parser: it incrementally reads GE equipment log
files (fetched to `/opt/resources/acqu_files/<SME>/` by data_acquisition every
30 min), tails only the new bytes since the last run (Redis byte-size cursor),
parses per-modality, and bulk-inserts to PostgreSQL (`log.ge` tables via
`utils/db/sql/pg-helpers_hhm.js`; gzipped source snapshots to
`log.saved_files`). Run-once by design — triggered on a schedule, not a
long-running service.

**This repo OWNS the shared image `hhm_rpp:<tag>`** (built from
`docker/Dockerfile`), consumed as-is by hhm_rpp_philips and hhm_rpp_siemens —
neither has a Dockerfile, on purpose. Migration plan for the tag (settled with
the siemens migration 2026-08-25): dev builds tag `hhm_rpp:<username>`, the
release builds `hhm_rpp:svc` and re-points the `staging` alias at the same
image for un-migrated philips; siemens then flips its `IMAGE_TAG` to `svc` in
one commit + re-release.

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

## Schedule (pre-migration, matt-teixeira's USER crontab — verbatim)

```cron
15,45 * * * * cd /opt/apps/hhm_rpp_ge && docker compose run --rm app_tools bash -lc "npm run ge_ct"
15,45 * * * * cd /opt/apps/hhm_rpp_ge && docker compose run --rm app_tools bash -lc "npm run ge_cv"
15,45 * * * * cd /opt/apps/hhm_rpp_ge && docker compose run --rm app_tools bash -lc "npm run ge_mri"
```

Per the fleet standing decision these entries STAY in the user crontab
(consolidation into svc's crontab is data_acquisition BACKLOG 6f, a separate
follow-up); at cutover they are hardened in place at the same cadence:
absolute `/usr/bin/docker` + `/usr/bin/flock -n`, `-T`, direct
`node index.js GE_*` argv (identical `argv[2]`, so ops-dashboard's job label
is unaffected), bounded single-`>` `.out` files, small stagger.

## Exit-code / run-record contract (KEEP — consumers depend on it)

- **run_outcome/v1** (audit OPS-03): 0 success/skipped, 1 failed, 2 partial or
  self-log persistence failure, 3 usage error. ops-dashboard and
  incident-engine consume the exit codes and the terminal `run_outcome` event
  (type INFO on purpose — it must never land in `warn_error_logs`). **Never
  regress to exit-0-on-failure.**
- **Event 0's note shape is load-bearing**: ops-dashboard derives this app's
  job label from `verbose_log->0->'note'->'argv'->>2`. Do not reshape `argv`.
- Run record: `util.app_run_logs` (app_name `hhm_rpp_ge`) + JSON file per run.
  Pre-migration the file tag is the `LOGGER` env (`dev`); post-migration it is
  `USER_ID` (your username in dev, `svc` in a release).

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

## Environment / secrets

- `.env` is gitignored; `.env.example` is the tracked record of required keys.
- PG + Redis credentials come from root-only `/opt/resources/secrets/`; this
  app **is registered** in the host rotation script
  (`/opt/resources/scripts/rotate-envs-20260817.sh`), which rewrites BOTH
  copies (`/opt/apps/hhm_rpp_ge/.env` and `~/apps/hhm_rpp_ge/.env`) by
  matching the current value — both copies must keep values matching the
  reference (verified matching 2026-08-26).
