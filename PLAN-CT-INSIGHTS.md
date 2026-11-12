# Plan — GE CT insights: metrics, findings, and an internal viewer

Drafted 2026-11-03. Goal: turn `log.ge_ct_gesys` (raw GE CT gesys log
records) into customer-meaningful data — utilization, tube wear,
reliability, operator compliance, environment — plus **findings** that
call out systems needing attention. Backend first, built to be the
contract the frontend team consumes after the server migration. Until
then, an internal HTML viewer reads the same contract.

Out of scope for v1: MRI and CV. The design keeps them in mind (shared
schema, rule registry per source), but nothing is built for them yet.

## Status (2026-11-12)

- **Phase 0 done.** Decisions in §9.
- **Phase 1 done: applied to prod 2026-11-03 19:44:38 UTC** by the user
  on `vm-debian` from a clean checkout at `2bc73b6`. The runner ended
  `APPLIED`:
  - all 2,892 protected fingerprints unchanged
  - no locks taken on protected relations
  - a fresh-connection re-check passed

  Independently verified afterwards: `status` shows 2/2 applied with
  matching checksums; 36 `insight` tables (including partitions) and the
  5 `api.ge_ct_*` views exist and are empty.

  Before applying, the same was verified as a dry run:
  - static scan ok on all 4 files; `node migrations/test/sqlscan.test.js`
    passes 8/8
  - dry run of up 001→002: catalog unchanged after ROLLBACK
  - `roundtrip` (up 001→002, then down 002→001): the catalog was
    restored exactly
- **Phase 1b: root cause found (§11). Fix step 1 implemented on `dev`
  and verified; not yet deployed. Cleanup approved in principle, and the
  exact statements are awaiting approval.** Step 1 lives in
  `persist/drop_already_ingested.js`, called from
  `jobs/CT/gesys_parser.js`. Verified on real `saved_files` snapshots
  against prod (read-only):
  - SME18531 rotation: drops exactly the 3,482 carried-over records and
    keeps the 341 new ones.
  - SME21865 rotation: drops 112 and keeps 586.
  - Normal incremental run: drops 0.

  The lookup costs 17 ms in the worst case (2 weeks, 14k rows) and 0.1 ms
  for a normal batch. `node test/drop_already_ingested.test.js` passes
  9/9. New duplicates stop only once the prod server runs this code.
  **Step 2 approved and implemented. Steps 1 and 2 were pushed to dev, staging and prod (`2bc73b6`), and `vm-debian` is on that commit (its migration record shows it).**
  - Code: `read/gesys_head.js`, plus an opt-in `force_full_read` flag in
    `acquisition/GE_CT_CV_MRI.js` (CV/MRI never set it).
  - Header check: across 6,816 snapshots of 71 CT files, the
    `A <epoch>` header changed exactly at the 2 rotations and nowhere
    else.
  - Simulation with the real class and SME18531's rotated file (after a
    rotation the size check misses): today ingests 173 of the 341 new
    records and loses 168. With step 2 it ingests all 341, and the
    3,482 records already stored are dropped.
  - `node test/gesys_head.test.js` passes 4/4.
  - The first run after deploy has no stored header, so it behaves as
    before. The header is stored from then on.

  **Fix live in prod:** the 19:45 UTC CT run on 2026-11-03 wrote header
  keys and inserted 456 rows with 0 duplicates.

  **Cleanup done 2026-11-03 19:54 UTC** (§11.6). 154,945 duplicate rows
  were deleted; the 49 rows referenced by detections were kept.
- **Phase 2 DONE (2026-11-03 22:06 UTC).** Backfill applied as
  `insight_writer` (`node insight/cli.js backfill --apply`):

  | Item | Result |
  |---|---|
  | Gesys rows | 2,948,466, in 59 batches, 208 s, one commit per batch |
  | Facts | **2,163,802** across 37 metrics and 34 systems |
  | Rule errors, skipped rows | 0 |
  | Collapsed | 57 facts: the 49 kept duplicates and DST-hour key collisions |
  | Watermark | `ge_ct_extract` = 18543534, status `ok` |

  Exit criteria (§8):
  - **Exact reconciliation:** `cli.js verify` → all 621 system×metric
    cells equal the independent DISTINCT-key SQL count; catalog 37/37.
  - Rule tests pass (47 tests in 7 suites).
  - Coverage criterion MET (§12.1).
  - The writer verified unable to write outside `insight`.

  Before the apply, both run as `insight_writer` and rolled back:
  - rehearsal: 2 batches, 50,607 facts
  - upsert-semantics test: same version again → 0 rows changed;
    version bump on `error.ermes` → exactly its 4,969 facts replaced; old
    version again → 0; catalog re-sync → 0

  How we got here:
  - The Codex review's 5 findings were fixed
    (`REVIEW-CT-INSIGHTS-CODEX.md`).
  - The `insight_writer` login was created by the user on `vm-debian`,
    and its credentials copied (never displayed) from
    `/home/prod/hhm_rpp_ge/.env` to this checkout's `.env`.
  - 003 was applied by the user, 2026-11-03 21:58 UTC.

  Observations for later:
  - **Device clock drift.** Some scanners' clocks run ahead of capture
    time: SME20594 ~37 min, SME16618 ~26 min, SME21873 ~11 min. Phase 3
    busy-hour and cross-system timelines need a per-system clock-offset
    estimate.
  - **Server permissions (flagged to the user, not changed).**
    `/home/prod/hhm_rpp_ge/.env` is world-readable and `/home/prod` is
    world-writable. Suggested fix, run as `prod`: `chmod 600
    /home/prod/hhm_rpp_ge/.env` and `chmod 755 /home/prod`. **User
    decision 2026-11-03: not changing these now.** Dev and prod share
    this machine (prod is the `prod` user), and a server migration that
    physically splits dev/staging/prod is in progress. At cutover:
    - port this work to the new line
    - give each environment its own writer login
    - remove the writer credentials from the dev checkout

- **Phase 3 DONE (2026-11-04 13:56 UTC).** All §13.3 exit criteria met;
  details, choices and review fixes in §13.5.
  - **Migration 004** applied by the user 2026-11-04 12:54:51 UTC from
    `61fdfe1` (scan, dry run and roundtrip passed first).
  - **Derive applied** as `insight_writer` (`node insight/cli.js derive
    --apply`, from `5c00636`): 34 systems, one transaction each, 27 s.

    | Table | Rows |
    |---|---|
    | derived facts | 3,393 (3,385 `system.boot` + 8 `tube.replacement`) |
    | `ge_ct_daily` | 103,985 |
    | `ge_ct_exams` | 41,826 |
    | `ge_ct_tube_segments` | 42 |
    | `system_capabilities` | 659 |
    | `system_clock` | 28 |

    `job_state` `ge_ct_derive` = watermark 18543534, status `ok`.
  - **`node insight/cli.js verify-derive` → ALL CHECKS PASS**, each against
    independent SQL:
    - **Tube:** the §13.1 table exactly (7 confirmed, 1 `counter_only`);
      every replacement has a tube source; segments agree with the
      replacement facts.
    - **Boots:** 3,385 = independent SQL, clean/unclean included; the
      SME18531 restart loop gives 0 boots from 37,656 inits.
    - **Exams:** rows = distinct starts; 99.91% have a series summary.
    - **Daily:** 103,985 cells exact on n / sum / min / max / last /
      last_at.
    - **Capabilities:** 659 cells exact.
    - **Clock:** flagged ahead = SME11229, SME16618, SME21873, SME21929.
    - **Invariants:** host_datetime within 14 h of the device clock
      everywhere; 39 catalog rows.
  - **Phase 2 `verify`** still 621/621.
  - **Boot tolerance accepted by the user as listed (2026-11-04).** It may
    be revised when more information arrives (§13.5).
  - Before the apply, a rehearsal (one transaction, rolled back) did the
    same writes, then:
    - a second pass that changed nothing;
    - a touched-days pass (28 systems, 439 days) that was byte-identical
      to the full rebuild;
    - verify-derive inside the transaction: all PASS.
  - Four Codex reviews; all 8 findings fixed (§13.5). The last review came
    after the apply; its fixes only tightened the CLI and verify, and the
    stricter verify passes on the written data.
  - Commits on `dev` (not pushed): `76ede42`, `61fdfe1`, `46362ea`,
    `5bf5098`, `5c00636`.
- **Phase 4 DONE (2026-11-04 15:52 UTC).** All §14.4 exit criteria met;
  details, choices, tuning and review fixes in §14.7.
  - **Catch-up first** (§14.3 Q4): `backfill --apply` added 2,533 facts
    (4,102 gesys rows; watermark 18547636), then `derive --apply`. `verify`
    622/622 cells; `verify-derive` ALL PASS; the §13.1 replacement list and
    the clock flags didn't change.
  - **Migration 005** applied by the user 2026-11-04 14:43:42 UTC (scan,
    dry run and roundtrip passed first). Committed afterwards as `4d8a345`.
  - **Findings applied** as `insight_writer` (`node insight/cli.js findings
    --apply --replay`, from `63377f7`): 112 findings (29 open) on 34
    systems, 13 catalog rows, 9.4 s. `job_state ge_ct_findings` =
    watermark 18547636, as of 2026-11-04.
  - **`node insight/cli.js verify-findings` → ALL CHECKS PASS**: every
    finding equals the independent SQL (112 = 112), catalog = registry,
    invariants hold.
  - The three named problems: SME21859 `tube_rotor_instability` **high**,
    open since 2026-05-15; SME18531 `process_restart_loop` 2026-09-12 →
    resolved 09-23; SME21867 `abort_rate_high` **chronic**, 2026-05-13 →
    resolved 10-06.
  - **Two rules tuned from the replay evidence** (user approved the
    recommendations, 2026-11-04): aborts and safe states (§14.7).
  - The evidence review (§14.3 Q5) was done on the full replayed list;
    field-service confirmation is Phase 7.
  - Two Codex reviews, 6 findings, all fixed (§14.7).
  - Commits on `dev` (not pushed): `4d8a345`, `3420fcf`, `63377f7`.
- **Phase 5 DONE (closed out 2026-11-12 13:11 UTC).** All §15.4 exit
  criteria met, checked read-only against prod:
  - **Runs:** 371 GE_CT runs from 2026-11-04 19:48 to 2026-11-12 12:48
    UTC (prod run logs). There are no gaps over 35 min and no ERROR
    events. Every stage summary is `ok` with all three watermarks equal,
    and the watermarks never go backwards (last 18603339).
  - **Stage time per run:** p50 4.1 s, p95 16.0 s, max 29.3 s (the first
    catch-up run). The daily all-systems pass ran on each of the 8 UTC
    days (00:18), taking 12.9–14.2 s, with 0 drift.
  - **Drift:** 0 in every default run since the fix deploy (2026-11-05
    13:00 UTC). The only stage WARNs in the window are the 4 pre-fix
    SME01430 `abort_rate_high|2026-09-25` drift events (06:18, 06:48,
    10:18 and 10:48 UTC on 11-05).
  - **Verifiers at the end** (13:03–13:11 UTC, watermark 18603339):
    - `verify`: 624 cells equal, catalog 39.
    - `verify-findings`: 115 findings, missing / extra / differ 0, ALL
      PASS.
    - `verify-derive`: ALL PASS after one reviewed new tube replacement
      (below).
  - **Ingest unaffected:** `log.ge_ct_gesys` follows the same daily
    pattern before and after 11-04 (weekdays 7.5k–11.4k rows from 25–27
    systems; weekends 1.4k–2.4k). `scan_seconds` rows from
    `extract_tube_usage` keep arriving (13–27 on weekdays).
    `alert.offline_hhm_conn` is updated for all 27 systems seen in the
    last day. The ~200 ingest WARNs per run predate insight.
  - **Reviewed at close-out, a new tube replacement:** SME21870 on
    2026-11-07, `confirmed`. Evidence:
    - the counter goes from 56,442,759.5 to 0 mA·s at 20:46 UTC;
    - 7 calibrations from 19:14 UTC and 4 boots that day;
    - the tube source is verified;
    - the new segment rises with normal scanning from 11-09;
    - the old tube's total is in line with the other replaced tubes
      (52.8M, 57.3M).

    The `tube_replaced` finding (info) is open. Fix:
    `insight/derive/verify.js` now holds the §13.1 list plus a
    `REPLACEMENTS_REVIEWED` list (SME21870 is its first entry); the test
    still checks the fixtures against §13.1 alone.
  - The Phase 5 build history follows.
- **GE CV now shares the `insight` tables (2026-11-12, `PLAN-CV-INSIGHTS.md`).**
  - The CT verifiers count only CT rows (C1, `de32296`).
  - Migration 008 added `WHERE source = 'ge_ct'` to
    `api.ge_ct_findings_v`; it still shows the 115 CT findings.
  - `insight.metric_catalog` now also holds 9 `cv.*` rows, and
    `insight.findings` 13 `ge_cv` rows.
  - Nothing else in CT changed.
- **Phase 5 build history (§15).**
  - Built: the insight stage (`45c2ab2`, review PHASE5-STAGE F1-F2) and
    the `index.js` hook (`9c098f2`, review PHASE5-HOOK F1-F2). The first
    live stage run was 2026-11-04 19:48 UTC.
  - **Checkpoint during monitoring, the clock flag (`c8d15df`):** that
    first run flagged SME20594 `ahead`. Reviewed and accepted into
    `verify-derive`'s expected clock-ahead list. Every capture
    2026-10-05..10-31 had lag +13..+35 min; every capture from
    2026-11-01 (US DST end) has lag −17..−46 min, a ~60 min step. 27 of
    251 captures in the 30-day window are negative, which puts p10 below
    0. It is a device clock behaviour for the Phase 7 field-service list,
    not a pipeline fault.
  - **Drift fix (`b09674e`, review PHASE5-DRIFT: no findings):** resolved
    findings follow the replay inside the 7-day window. Deployed
    2026-11-05 13:00 UTC, which restarted the 0-drift window.
  - The §15.4 windows ended 2026-11-11 19:48 UTC (7 clean days) and
    2026-11-12 13:00 UTC (0 drift); see the close-out above.
- **Phase 6 DONE (2026-11-06).** The internal viewer, "GE CT Insights —
  Internal" (§16). All §16.4 exit criteria met:
  - **Migration 006** (`api.ge_ct_days_v`, `api.ge_ct_capabilities_v`,
    `api.ge_ct_boots_v`; views only): pre-checks, dry run and roundtrip
    passed (two rounds; the boots view was added before the apply).
    Applied by the user 2026-11-05 17:42:49 UTC at `883bad7`.
  - **Numbers verified** (`sme_reports/ct/verify.js`, read-only, one
    REPEATABLE READ snapshot, as of 2026-11-05): **0 differences in
    23,434 comparisons.** It covers:
    - every fleet column for all 34 systems, the order of both lists and
      the inventory footer;
    - every per-day series, period total, heatmap cell and error top 10
      for SME21859, SME18531 and SME21867;
    - every field of all 113 findings, including the stored evidence;
    - on all 62 abort / prep trip days, the column = the rule's value =
      the stored evidence.

    A mutation probe planted 18 errors, one per kind; all were caught.
  - **`dev/check_ct.js`** (no DB) passes:
    - the build is deterministic, also with every input reversed;
    - zero page errors in headless Chromium;
    - no sideways scroll at 390 px in any view or period;
    - "Internal" in the title, header and file name;
    - panels are hidden without their capability;
    - markup in site names and catalog labels stays text;
    - `--as-of` accepts only the snapshot's UTC day.
  - **Real build** (`npm run report:ct`): 1.31 MB (budget 10 MB). The
    dashboard is ready in 106–187 ms and the slowest system view × period
    in 74 ms on the DEV VM (budget 2 s each).
  - **Review:** Q6 settled; the user is the reviewer. The user reviewed
    the page 2026-11-05 and asked for no changes. The user may share the
    file with the team; that feedback will be recorded in §16, and
    anything about scanner behaviour goes to the Phase 7 field-service
    list.
  - **Decisions made while building** (user, 2026-11-05):
    - `api.ge_ct_boots_v` was added to 006 before the apply;
    - finding cards show the stored rule evidence, labelled as stored and
      compared exactly by `verify.js`, as §16.2 item 6 says;
    - a build is a "now" report: `--as-of` must be the snapshot's UTC
      day, because findings and tube state are current.
  - **For the Phase 7 field-service list:**
    - the warm-up steps on the prep calendar (`Cold Tube Warmup`,
      `WarmupI`, `WarmupII`);
    - the PSU gauges' 2147483647 placeholder (the page shows PSU event
      counts only);
    - SME20594's DST-end clock step (above).
    - SME21870's tube replacement on 2026-11-07 (Phase 5 close-out): ask
      field service to confirm the swap date.
  - **Codex reviews:** PHASE6-006 (two rounds, no findings), DATA-MODEL,
    VERIFY and PAGE (F1–F2 each, all fixed).
  - **Commits:**
    - reports `DEV`: `6f4f46e`, `a10efeb`, `07a5693` (only
      `sme_reports/ct/**`, `sme_reports/dev/check_ct.js` and the
      `report:ct` line);
    - hhm_rpp_ge `dev`: `a3c5a4e`, `883bad7`, `ccd4c38`, `cce1ffc`,
      `9835853` and this update.

    None pushed.
- **Correction to §1 and the dedupe key:** `(system_id, epoch,
  record_number_concurrent)` is unique except in 8 known cases, which are
  distinct records. GE `epoch` is local wall-clock seconds, so it repeats
  in the DST fall-back hour. See §11.3. The key is fine for metrics (§9
  stands). Deleting rows must match exact copies.

---

## 1. What the data supports (verified against prod, 2026-11-03)

- `log.ge_ct_gesys`: ~3.1M rows, 34 CT systems, partitioned on
  `capture_datetime`, indexed `(system_id, host_datetime)`.
- **Usable history starts 2026-05.** Before that only 1–6 systems
  report. Expect ~6 months of backfill, not 18.
- Content lives in `message` (free text, repeating templates). `type` is
  `"<hostname>\t<process>"`; the process (e.g. `scanRx`, `dailyPrepRx`,
  `tgp_subsys`) is the useful half. `exception_class`, `severity`,
  `ermes_number` are populated for ~22% of rows (the error records).
- **Natural key is `(system_id, epoch, record_number_concurrent)`.**
  `sr` is *not* unique — GE logs several records in the same second
  with `record_number_concurrent` 0..n. About 3% of rows are true
  duplicates (same key, later `capture_datetime`), up to 30% on some
  systems (SME17371), from the same file contents being re-ingested.
  **Every metric must dedupe on this key.** (Root cause and the 8
  known exceptions to the key: §11.)
- The system's model and software version are in Svc_Notepad
  `PRODUCT CONFIGURATION|Product: …|sw_version: …`. 33 of 34 systems
  log it. Fleet: Optima CT540/580/660/520, Discovery CT750 HD/RT/610/MI,
  BrightSpeed, LightSpeed RT16/VCT/16.

### Problems already visible (deduped, last 90 days)

| System | Model | Signal |
|---|---|---|
| SME21859 | Optima CT540 | 205 "Liquid Bearing tube rotor decelerating to stop unexpectedly"; weekly count rose ~12 → 26 Jul→Sep, still ~20/wk; aborts track 1:1. Possible tube failure precursor. |
| SME18531 | Discovery MI | 37,666 `cupMonitor` "unexpected termination of device_eventlog … restarted": a process restart loop. (Correction, 2026-11-03: the 2026-08 row spike is mostly SME01434, §12.1.) |
| SME21867 | LightSpeed16 | 1,133 Abort-class records vs 285 exams. |

---

## 2. Architecture decision

**Separate pipeline, same process. No new cron line.** The insight
pipeline is a stage at the end of `npm run ge_ct`. `on_boot()` in
`index.js` calls `run_ct_insight(run_log)` after the system loop finishes
(only for `GE_CT`, with an env kill switch `INSIGHT_ENABLED=false`).

**The stage reads what was just inserted from the DB by watermark,
instead of taking the parsed rows in memory.** It still runs in the same
process, right after the inserts, so latency is seconds. Reasons:
- **Self-healing.** If the stage fails or the process dies, the
  watermark hasn't moved, so the next run picks those records up. Records
  handed over in memory would be lost for good.
- **Backfill uses the same code path.** A backfill is just "reset
  watermark, run". Rules will change (new templates, fixes), so history
  will be reprocessed more than once. In-memory hand-off would need a
  second path for that.
- **Rollups and findings need history from the DB anyway**: baselines,
  tube segments, per-exam aggregation.
- **Dedupe happens in one place**, on the natural key, however the
  parser re-ingests.
- **The ingest path is isolated.** The stage runs after inserts and the
  Redis update, inside its own try/catch, so a bad rule can't block log
  inserts.

The cost is re-reading this run's new rows, which is small. Fleet volume is
~350k rows/month, and the watermark query is an index range scan on `id`
plus a `capture_datetime` floor so only recent partitions are touched.

The rule engine is a pure function `(row) → facts[]`, so it doesn't
care where rows come from. If a per-record hook in the parser is ever
needed, it can call the same function.

Concurrency: if one `ge_ct` run overlaps the next, the stage takes
`pg_try_advisory_lock` and skips if another holds it. Upserts are
idempotent, but opening and resolving findings should not race.

Backfill is a manual one-off command (`npm run ct_insight -- --backfill`),
not a schedule.

**Existing tube path stays untouched.** `extract_tube_usage` →
`public.logfile_event_history_metadata` (`name='scan_seconds'`) is read by
`fse_dispatch` (`get_scan_seconds.sql`) and shared with the Philips/Siemens
parsers. Note the value is **mA·s, not seconds**. The new tube metrics are
computed independently from the log table, and the old path can be
retired later once `fse_dispatch` moves over.

---

## 3. Data model — new schema `insight`

All DDL lives in tracked migration files: `migrations/NNN_*.sql` in this
repo. Applied to prod through the guarded runner in §10. Note that `.gitignore` ignores `utils/`
wholesale, so **new code must not live under `utils/`** or it won't be
versioned. Production is the non-docker `prod` branch on `vm-debian`
(Node v16.20.2), promoted dev → staging → prod. The `*_docker` branches
belong to a separate server.

| Table | Grain / key | Purpose |
|---|---|---|
| `insight.metric_catalog` | `metric_key` | Label, unit, category (utilization / tube / reliability / compliance / environment / inventory), description, `customer_visible`, `rule_version`. Drives labels in every consumer. |
| `insight.ge_ct_facts` | one row per (log record × metric). Unique `(system_id, epoch, rnc, metric_key, host_datetime)`. Monthly partitions on `host_datetime` (same convention as `alert.detections`), pre-created by migration through 2028‑12 (§12). | Extracted values: `value_num`, `value_text`, `exam_no`, `attrs jsonb` (e.g. kV/mA, sensor L/C/R), `host_local` (device wall clock), `source_id` → gesys `id`. The upsert is idempotent and replaces a fact only when the rule version is newer (§12). |
| `insight.ge_ct_daily` | `(system_id, local_day, metric_key)` | n, sum, min, max, last. The day comes from the **device wall clock** (`host_local`), not `sites.time_zone_id`, which is NULL for 19 of 31 reporting systems (§12). Recomputed for touched days only. |
| `insight.ge_ct_exams` | `(system_id, exam_no, started_at)` | One row per exam: first/last activity, series, scans, images, aborts during exam. Basis for per-exam rates. |
| `insight.ge_ct_tube_segments` | `(system_id, segment_start)` | Tube lifetimes derived from the cumulative mA·s counter: start/latest mA·s, mA·s/day, readings, `ended_reason` (replacement). |
| `insight.system_capabilities` | `(system_id, metric_key)` | first_seen, last_seen, n. Separates **"this model doesn't log it"** from **"zero events"**. Required for the model-specific metrics. |
| `insight.findings` | `(system_id, finding_key, opened_at)` | status open/resolved, severity, window, observed vs baseline, `evidence jsonb` (fact ids, weekly series), `rule_version`, last_evaluated. |
| `insight.job_state` | `job_name` | Watermark (last processed gesys `id`), last run stats. This is the only DB-visible run record: on the production server (`vm-debian`) the app writes run logs to local JSON files, and `dbInsertLogEvents` is commented out in `index.js`. |
| `insight.unmatched_templates` | `(process, template_hash)` | Weekly digest of high-volume message templates no rule matches, so new firmware wording gets noticed. |

**Consumer contract = views in `api`** (schema already exists):
`api.ge_ct_system_summary_v`, `api.ge_ct_daily_v`, `api.ge_ct_findings_v`,
`api.ge_ct_tube_v`, `api.ge_ct_exams_v`. The viewer and later the frontend
read only these, so tables can change underneath them.

---

## 4. Metric catalog v1

Rule = (process filter, regex on `message`, value extraction). Patterns
below are confirmed present in prod. Coverage = systems seen emitting it.

### Core (fleet-wide)

| Key | Source template | Value | Cov. |
|---|---|---|---|
| `tube.mas_total` | scanmgr "tube usage data reports a total of N ma*S" | N (counter) | 34 |
| `tube.replacement` | derived, see "Tube replacement detection" below | event | derived |
| `exam.start` | scanRx "Start: Prospective Exam: E : Protocol: P" | exam_no, protocol | 33 |
| `exam.series` | scanRx "Series: S : Scans: N : Images: M" | scans, images | 33 |
| `scan.abort.operator` | "Operator Aborted Scanning", `exception_class='Operator Abort'` | event | 30+ |
| `scan.abort.system` | `exception_class='Abort'` + `ermes_number` | event, ermes | all |
| `scan.safe_state` | `exception_class='Safe State'` (e.g. 260116316 slip-ring comms down) | event, ermes | all |
| `error.ermes` | any row with `ermes_number` | code, class | all |
| `system.boot` | "Software Initialization Complete" **not** inside a process-restart burst | event | all |
| `system.shutdown` | "System shutdown started from desktop button" | event | all |
| `process.restart` | cupMonitor "An unexpected termination of X caused it to be restarted" | process name | all |
| `service.mode` | environmentMgr "System enter/exit service mode" | paired → duration | 24 |
| `prep.warmup` / `prep.fastcal` / `prep.aircal` / … | dailyPrepRx "Tube temperature before/after <Step> is T degrees" | step, temp °C | 30 |
| `service.calibration` | scanUtilsRx "Tube temperature before <Step> is T degrees" (Basis, Air, Water Phantom, Collimator, Interconnectivity Map…). These are service calibrations, not operator daily prep. | step, temp °C | tbd |
| `tube.identity` | orp_subsys "Current tube type is …"; fwmgr "GE tube has been verified" / "unrecognized X-Ray tube has been installed" / "initialized for an X-Ray tube without Smart ID" | type, verified flag | 17+ |

#### Tube replacement detection

There is no tube serial number for GE CT. `tube_serial_no` in the
metadata table is Siemens only, and the `dispatch` schema holds only
ultrasound PM forms and user activity. Detection therefore relies on the
log's own signature, verified on SME16618:

| When | Signal |
|---|---|
| 06‑02 17:32 | service mode entered; tube counter still at old value |
| 06‑02 19:03 | "Current tube type is Liquid Bearing tube"; "An unrecognized X-Ray tube has been installed" |
| 06‑02 19:13 → | burst of rotor management / rotor health messages |
| 06‑03 | full service calibration set (`scanUtilsRx` Basis/Air/Water Phantom) |
| 06‑04 05:55 | mA·s counter reset to 0, then climbing from ~500k |

Rule (as first drafted; **superseded by §13.2, 2026-11-04**):
- **Primary signal:** counter drops to ~0 and later readings climb from
  low values. A single 0 that returns to the prior level is a glitch
  (seen 4× on SME21873). *Wrong: SME21873's resets stay low; see §13.1.*
- **Corroboration:** within 7 days before the reset, look for tube
  identity messages, service mode, and a service-calibration burst.
- **Confidence:** `confirmed` if both are present, `counter_only`
  otherwise.
- **Install date** is the corroborating event's date when one exists, since
  the counter reset lagged the physical swap by ~2 days here. Otherwise it
  is the reset date.

Derived rates (computed in daily/exam tables, not separate rules):
exams/day, images/exam, aborts per 100 exams, mA·s/day, mA·s/exam,
daily prep compliance = scan days with Fast Cal ÷ scan days, busy-hour
profile, boots/week.

### Model-specific (include; gate by `system_capabilities`)

| Key | Source | Notes |
|---|---|---|
| `tube.rotor_unexpected_stop` | tgp_subsys "Liquid Bearing tube rotor is decelerating to stop unexpectedly" | 9 systems |
| `tube.rotor_not_at_speed` | "(40-0114)Rotor not at speed" | |
| `tube.rotor_sgb_slope` | orp_subsys "rotor health log. SGB Slope: N rpm/sec" | trendable |
| `tube.filament_aging` | orp_subsys "Filament aging saturated … Z#,Z#= #h,#h" | |
| `tube.unrecognized` | fwmgr "unrecognized X-Ray tube has been installed" | inventory flag |
| `op.scan_in_warmup_zone` | scanRx "confirmed … while the X-ray tube state was in the yellow warm up zone" | compliance |
| `op.warmup_skipped` | scanRx "Tube warm up was skipped. Limited mA … Max small spot mA = …" | compliance |
| `env.plenum_temp` | orp_subsys "Plenum … Out of Tolerance … Left: L, Center: C, Right: R" | values in attrs |
| `env.detector_temp_low` | orp_subsys "Detector Temperature Is Low … Current Reading: T" | |
| `env.humidity` / `env.psu_temp` | event_logger TempHumidity / Health Readiness | PET/CT digital |
| `das.link_errors` | orp_subsys "Optical high speed link dropped packets" | |
| `xfer.dicom_send` | dcserver "Start Sending: a/b (DEST)" ↔ "Sent: a/b (DEST)" | count + latency per destination |
| `inventory.product` | Svc_Notepad PRODUCT CONFIGURATION | product, sw_version, latest wins |
| `ui.start_scan_button` | tgp_subsys "[START SCAN] pushbutton was pressed" | hardware cycle counter |

Rule source: `insight/rules/ge_ct.js`, one object per rule with `key`,
`process`, `re`, `map(groups) → {value_num, value_text, exam_no, attrs}`,
`version`. Each rule has fixture tests built from real messages
(`insight/rules/__fixtures__/ge_ct/*.txt`), including firmware wording
variants, because templates differ by model (e.g. MRI vs CT "Function:"
prefixes, leading whitespace).

---

## 5. Findings v1

> **Re-evaluated 2026-11-04 against real data: see §14.** Once agreed, the
> §14.2 proposals replace the rules and thresholds below.

Evaluated after each run, per system, on deduped facts. A finding opens
when its rule trips and resolves after a quiet period, so it doesn't
open and close on every run. Each finding stores the evidence it used.

| Finding | Rule (initial thresholds, tune in validation) | Severity |
|---|---|---|
| `tube_rotor_instability` | rotor unexpected stops this week ≥ 5 **and** ≥ 2× trailing 8-wk median, or rising 4-wk trend | high |
| `process_restart_loop` | any single process restarted ≥ 50×/day | medium |
| `abort_rate_high` | system aborts per 100 exams (7d) ≥ 3× own 8-wk baseline and ≥ fleet p90 for that model | medium |
| `safe_state_recurrent` | same ermes Safe State ≥ N/week | medium |
| `prep_noncompliance` | scan days without Fast Cal (14d) > 50%, only for systems whose capability shows they log it | low |
| `tube_replaced` | replacement detected (§4), carries confidence + install date | info |
| `tube_usage_spike` | mA·s/day 7d avg ≥ 2× tube-segment baseline | low |
| `env_out_of_tolerance` | plenum/detector/humidity events on ≥ 3 of last 7 days | medium |
| `warmup_bypass_habit` | warm-up skipped or yellow-zone scans on ≥ 20% of scan days (14d) | low |

Baselines are per system first (systems differ a lot in volume and
model) and compared to the fleet second. "Reporting stopped" is already
covered by `alert.offline_hhm_conn`, so it isn't duplicated here.

Later integration: the existing alert engine
(`alert.models.pg_table/field_name` with `greater_than` / `delta_neg` /
…) can threshold a numeric column on `api.ge_ct_system_summary_v`, which
routes findings through the current notification path without new
plumbing. Confirm with whoever owns the alert processor before wiring it.

---

## 6. Code layout (this repo)

```
index.js              # on_boot(): after the system loop, if GE_CT → await run_ct_insight(run_log)
insight/
  index.js            # run_ct_insight(run_log, opts): lock → extract → derive → findings → release
  cli.js              # manual only: --backfill [--from-id N] [--system SME...] | --rebuild-metric KEY | --coverage
  db.js               # own pool as insight_writer (INSIGHT_PG_USER/INSIGHT_PG_PW), NOT utils/db/pg-pool
  rules/ge_ct.js      # rule registry
  rules/__fixtures__/ # real message samples per rule
  extract.js          # stream gesys by id batches → match rules → upsert facts
  rollup_daily.js     # touched (system, local_day) → ge_ct_daily
  exams.js            # build ge_ct_exams
  tube.js             # counter → segments, replacement detection
  capabilities.js
  findings.js         # rule evaluation, open/resolve
  unmatched.js        # template digest; also the Phase 2 --coverage report
  test/*.test.js      # node:test, no DB needed for rule tests
migrations/
  001_insight_schema.sql
  002_api_views.sql
```

Stage order inside `run_ct_insight`. Each step only touches systems and
days that got new facts this run:
1. extract new gesys rows since watermark → facts
2. advance the watermark in the same transaction as the fact upserts
3. rebuild daily rows, exams, tube segments, and capabilities for the
   touched systems and days
4. evaluate findings for the touched systems
5. once a day (first run after local midnight): the unmatched-template
   digest, plus a findings pass over every system so quiet systems can
   resolve

Batch sizing: 50k gesys rows per batch, ordered by `id`.

The upsert is `ON CONFLICT (natural key) DO UPDATE ... WHERE
excluded.rule_version > ge_ct_facts.rule_version`, so a fixed rule
replaces its old facts, while a re-run of the same version changes
nothing. A rule that stops matching would leave stale facts behind; for
that, use `cli.js --rebuild-metric KEY`, which deletes that metric's
facts in `insight` and re-extracts them (dry run first).

Each run re-reads gesys rows whose `capture_datetime` is within 2 h of
the watermark's, not a fixed `id` count. That way a late-committing
insert from an overlapping run can't be skipped. **(Not built: extract
reads `id > watermark` only. See §15.1 and §15.3 Q2.)**

The metric catalog is generated from the rule registry and upserted at
stage start, so labels can't drift and facts never reference a missing
key.

Full backfill is ~2.95M rows (after the 1b cleanup), expected to take
minutes, not hours. Run it off-peak with a `statement_timeout`.

Small cleanup on the existing path (optional, same PR or separate):
`extract_tube_usage`'s catch reads `data[0].system_id`, which throws
when `data` is empty and hides the original error.

---

## 7. Internal HTML viewer

**Recommended: a new report in `reports/sme_reports`**, not a new app.
It already has the render shell, branding, the external scrub
(`incident/scrub.js`), the one-file HTML app pattern
(`PLAN-SYSTEM-ACTIVITY-APP.md`), scheduled runs, and email delivery.
Build it internal-only first:

- **Fleet view:** one row per system with model, exams/day, mA·s/day,
  tube age (mA·s on current segment), abort rate, prep compliance, and
  open findings, sorted by attention.
- **System view:** tube counter chart with replacement markers;
  exams/day and busy-hour heatmap; aborts and errors by ermes code;
  daily prep calendar; environment series; findings with their evidence;
  and model-specific panels shown only when the system's capabilities
  include them.
- Reads only the `api.ge_ct_*` views.

**Customer visibility (decided 2026-11-03):** customers see every
processed or calculated datapoint (how long, how often, how much),
findings included. Cut back later as needed, using
`metric_catalog.customer_visible`, which defaults to `true`. What stays
internal is not datapoints but raw material: raw log text, exam numbers,
and internal identifiers (source row ids, hostnames). The existing
external scrub handles that.

---

## 8. Phases and exit criteria

| Phase | Work | Exit criteria |
|---|---|---|
| **0. Decide** | Answer §9 questions; freeze metric catalog v1 | Catalog agreed |
| **1. Schema** | `001`/`002` migrations, applied to **prod** through the §10 runner (pre-checks → dry run → explicit go) | Pre-checks pass ✅; dry run rolls back cleanly ✅; apply succeeds ✅ (2026-11-03 19:44 UTC); `down` script tested in a dry run ✅ (`roundtrip`) |
| **1b. Dedup root cause** | Find why records are re-ingested on a later capture (e.g. SME18531 epoch 1791178306 rnc 0 captured 10‑05 and again 10‑07; SME17371 30% dup). Likely the Redis file-size watermark vs. file rotation/truncation in `GE_CT_CV_MRI.js`. Fix in the parser; decide whether to clean existing duplicates in `log.ge_ct_gesys` (separate, reviewed step) | Repro explained ✅ (§11); new duplicates stop ✅ (fix live 2026-11-03 19:45 UTC); cleanup done ✅ (§11.6) |
| **2. Extract** ✅ 2026-11-03 | `insight_writer` login + migration 003 (§12). Rule registry (including the two new metrics), scrubbed fixtures, `extract.js`, `--coverage` report. Dry run against prod (read-only, counts only), then `--apply` into `insight.*` as `insight_writer` | Rule tests pass. Per (system, metric), fact counts **exactly** equal hand-run SQL counts of matching rows (the only allowed differences: the 49 kept duplicates and DST-hour key collisions). Every message template above 500 rows/30 d either has a rule or is listed as deliberately ignored. The writer login is verified unable to write outside `insight` |
| **3. Derive** ✅ 2026-11-04 | Migration 004 (daily `dim`, `system_clock`). Derived facts (`system.boot`, `tube.replacement`). Daily, exams, tube segments, capabilities, clock offsets (§13) | See §13.3; all met (§13.5). (The original "sanity-check exams with 2–3 sites" and "swaps spot-checked by field service" move to Phase 7.) |
| **4. Findings** ✅ 2026-11-04 | Migration 005, findings registry, open/resolve replay, `cli.js findings` / `verify-findings` (§14) | See §14.4; all met (§14.7) |
| **5. Prod** | Agreed in §15 (2026-11-04): the `run_ct_insight` stage (extract → derive touched → findings), the `index.js` hook (no new cron line), kill switch, a stage rehearsal, then deploy via dev → staging → prod and `git pull` on `vm-debian`. (The backfill was done in Phase 2 and the catch-up in Phase 4.) | §15.4 (keeps: 7 consecutive days of clean runs; watermarks advancing; `ge_ct` run time up by seconds, not minutes; ingest unaffected with `INSIGHT_ENABLED` off and on) |
| **6. Viewer** ✅ 2026-11-06 | `sme_reports` CT report, internal. Agreed in §16 (2026-11-05; Q6 settled at step 6) | §16.4 (agreed): verified numbers, checks, team review. All met (Status) |
| **7. Validate & extend** | FSE review of findings (start with SME21859 rotor), and of tube swaps (§13.3, incl. SME21873 2025-09-02); exam counts sanity-checked with 2–3 sites; threshold tuning; handoff notes: frontend (`api` views, after migration), `fse_dispatch` owner (`api.ge_ct_tube_v`), alert-engine owner (findings integration proposal) | Findings confirmed useful by field service; frontend has a stable contract |

---

## 9. Decisions and open questions

Decided 2026-11-03:
- Separate insight pipeline, run as a stage at the end of `npm run ge_ct`.
  No new cron line (§2).
- `insight` schema, with `api.ge_ct_*` views as the contract (§3).
- Viewer is a report in `reports/sme_reports`, not a new app (§7).
- Tube metrics are computed separately; the old `scan_seconds` path is
  left untouched (§2).
- No DB source of truth for tube swaps: `dispatch` has none, and GE CT
  has no tube serial. Detection uses the log signature (§4).
- Customers see every processed or calculated datapoint; cut back later
  as needed (§7).

Decided 2026-11-03 (continued):
- **`fse_dispatch` should move off `scan_seconds`** onto
  `api.ge_ct_tube_v`, but that app's owner has to make the change. Phase 7
  includes a handoff note describing the view and the mA·s vs "seconds"
  naming.
- **Keep `extract_tube_usage` → `scan_seconds` running indefinitely.**
  Writing to `insight` is never a reason to switch it off or change it.
  Retiring it is a separate decision for later.
- **We work directly in the prod DB; there is no staging step.** All
  writes go through the safeguards in §10.
- **Fix the re-ingest duplication at the source.** See Phase 1b. The
  insight layer still dedupes on the natural key, so it never depends on
  the fix.
- **Findings will go through the existing alert engine eventually, but
  we don't touch it.** We don't own it. Findings stay in
  `insight.findings` and the report until the process here is
  substantial and validated (Phase 7). Then we propose the integration
  to the owner.

Still open:
1. When the alert-engine proposal happens, does it work through `alert.models`
   thresholds on `api.ge_ct_system_summary_v`, or does it need a new
   operator type? Decide with the owner.

---

## 10. Prod safeguards

We develop against the prod DB, so every write path gets guard rails.

**Exploration and validation queries**
- Connect with `default_transaction_read_only=on` and a `statement_timeout`.
- Never use the app's normal pool for ad-hoc work.

**Migration runner (`migrations/run.js`): pre-checks, then abort on any
failure**
1. Print and confirm the target: `current_database()`, host, user. The
   operator must type the DB name to continue.
2. Expected state: the schemas and tables the migration creates don't
   exist yet, or match the recorded version in `insight.schema_migrations`.
   Objects the migration must not touch (`log.*`, `public.*`, `alert.*`,
   `api.hca_odata`…) are listed and checked unchanged afterward.
3. Statically scan the SQL. Refuse `DROP`/`TRUNCATE`/`DELETE`/`UPDATE`/
   `ALTER` on anything outside `insight.*` and `api.ge_ct_*`.
4. Session limits: `lock_timeout = '5s'` and `statement_timeout`, so DDL
   can't queue behind ingest locks and stall the parsers.
5. **Dry run by default.** Run the whole migration in a transaction and
   `ROLLBACK`. Commit only with `--apply`.
6. Every migration has a `down` file, which is itself dry-run tested.
7. Record the applied version and checksum in `insight.schema_migrations`.

**Pipeline writes (`run_ct_insight`)**
- Write only to `insight.*`, **enforced by the database** (decided
  2026-11-03). The stage connects as `insight_writer`:
  - `LOGIN`, nothing else (no superuser, createrole or createdb)
  - SELECT on `log.ge_ct_gesys`, `public.systems`, `public.sites`
  - DML on `insight.*`; no DDL rights

  The login is created by `maintenance/create_insight_writer.js`, run by
  the user on `vm-debian`. The password is generated there and goes only
  into that server's `.env` as `INSIGHT_PG_USER`/`INSIGHT_PG_PW`.
  Because the writer can't create partitions, migrations pre-create them
  and the stage warns when fewer than 6 months remain.
- Pre-check on start: the required tables exist and the schema version
  matches what the code expects. Otherwise log and skip, never fail the
  `ge_ct` run.
- Advisory lock; idempotent upserts; batch caps (50k rows); a
  per-run row-count ceiling that aborts the stage if exceeded, as a
  runaway-rule guard.
- `INSIGHT_ENABLED=false` kill switch.
- Existing behaviour stays byte-for-byte: `log.ge_ct_gesys` inserts,
  Redis update, `offline_hhm_conn` upsert, `extract_tube_usage`.

**Backfill**
- Off-peak only, with `--dry-run` (counts only) first, batched by `id`,
  resumable from the watermark, with an explicit `--apply`.

**Destructive operations** (e.g. removing existing duplicate rows from
`log.ge_ct_gesys` in Phase 1b) are never part of the normal runner. They
need:
- a written plan
- a row-count preview
- a copy of the affected rows to `archive_log` first
- explicit user approval of the exact statement

---

## 11. Phase 1b — duplicate re-ingestion (investigated 2026-11-03)

All queries were read-only (`default_transaction_read_only=on`). Prod
Redis was probed with `SCAN`/`GET`/`INFO` only. No rows were changed.

### 11.1 Root cause: GE gesys rotation carries the old tail into the new file

GE rotates `gesys_<host>.log` at about 7 MB. The new file is **not
empty**. It holds a 130‑byte header (`A <epoch>` plus padding), then a
byte-exact copy of the **last part of the old file**, then new records.
The parser sees a smaller file, `delta < 0` in
`acquisition/GE_CT_CV_MRI.js:getFileData`, treats it as a brand-new file,
and reads all of it. The carried-over tail is inserted a second time.

The evidence is byte-for-byte. `log.saved_files` keeps a gzip of every
capture, but only for about 48 h. Both shrink events in that window
match, and the carried-over record counts equal the DB's duplicate counts
exactly:

| System | Capture | Size before → after | Carried-over tail | Records in tail | Dups in that DB batch |
|---|---|---|---|---|---|
| SME18531 | 2026‑11‑02 20:48 | 7,003,571 → 1,093,255 | 1,014,531 B (old bytes 5,989,040…end) | 3,482 | **3,482** |
| SME21865 | 2026‑11‑02 13:18 | 7,386,982 → 169,769 | 22,486 B | 112 | **112** |

The fleet history fits the same pattern. Duplicates arrive in 1–10 large
batches per system and almost never anywhere else; within-batch
duplicates total 6 rows. The tail size varies, so a low-volume system
re-reads weeks:
- SME17371: one batch on 09‑21 re-read 09‑07…09‑21, 3,778 rows. That is
  30% of its unique 90‑day records.
- SME18531 (the 10‑05/10‑07 example): the 10‑07 10:18 batch re-read
  10‑02…10‑07, 3,481 of 3,679 rows.

The batch heuristic attributes **128,765 of 155,002 duplicate rows
(83%)** to this signature. The remaining 17% is in §11.2.

A related data-loss edge case follows from the same logic. If the new
file grows past the old watermark before the next capture, `delta > 0`,
and `tail -c delta` reads only the end of the new file. Its beginning is
silently skipped.

### 11.2 Secondary: partial-file reads (probable interrupted transfers)

9 batches, 26,237 dup rows. Examples: SME20594 05‑12 and
05‑21, SME21849 and SME21873 06‑09. These show a different signature:
- One batch holds the **oldest part** of the file, including history
  never seen before.
- The next batch holds the rest, which is mostly duplicates.

That is what a truncated file followed by a complete one produces. The
acquisition scripts write in place: `scp`, `lftp mget` with
`xfer:clobber`, and `ge_ct_21.sh`'s `timeout 55 lftp mirror`. An
interrupted transfer therefore leaves a short file that the parser
cannot tell apart from a rotation. **Not verified byte-for-byte**: no
snapshots survive from those dates.

### 11.3 Ruled out, and a caveat on the key

**Ruled out:**
- **Redis key loss.** Prod Redis uptime is 523 days, so there was no
  restart. All CT gesys watermarks equal the latest saved file size
  exactly. No zero-valued keys.
- **`hhm_log_rotator`.** Its CT systems are configured `v_2`, and its
  code only acts on `v_1` and `v_3`, so it does nothing for them.
- **Overlapping runs and within-file repeats.** Neither is a meaningful
  contributor.
- **SME17371's three configured gesys names.** Only `gesys_nbct1.log`
  exists. `gesys_NBCT1.log` and `gesys_nbls.log` are stale no-ops.

**Key caveat:** GE `epoch` is **local wall-clock seconds**.
`to_timestamp(epoch)` reads as site-local time. So
`(system_id, epoch, record_number_concurrent)` repeats in the DST
fall-back hour. Example: SME20608 2026‑11‑01 01:51:58 has two distinct
Plenum readings an hour apart. Fleet-wide, 8 keys collide with distinct
content, including SME20594 2025‑11‑03, where the clock replayed around a
hardware shutdown.
- Exact-copy duplicates: **154,994**.
- 3-column-key duplicates: 155,002.

This is negligible for metrics, so the §9 decision stands. Deletion must
match exact copies.

Impact beyond insight:
- `extract_tube_usage` is fed the duplicate tube records. There are 193
  duplicate `scan_seconds` rows in
  `public.logfile_event_history_metadata` since 05‑01, out of 2,916.
- 20,090 enabled `alert.models` rules read `log.ge_ct_gesys`, across 37
  systems.

### 11.4 Proposed fix (awaiting approval; not implemented)

**Step 1, parser (this repo, `jobs/CT/gesys_parser.js`). Drop
already-ingested records before insert.** Approved and implemented
2026-11-03.
- After parsing, select `(epoch, record_number_concurrent, sr, type,
  message)` from `log.ge_ct_gesys` for this system, with `host_datetime`
  between the batch's min and max. This is an index range scan on the
  existing `(system_id, host_datetime)` index: minutes for a normal
  batch, at most a couple of weeks for one system after a rotation.
- Drop parsed records whose key and content already exist. Insert the
  rest.
- This fixes rotation (§11.1), partial-file pairs (§11.2) and any future
  Redis reset in one place, and needs no schema change on `log.*`.
  Comparing content keeps the DST-hour records.

Everything else stays byte-for-byte:
- Skip the insert when nothing is new. `pgp.helpers.insert` throws on an
  empty array.
- The Redis update and the `offline_hhm_conn` upsert still run, from the
  last *parsed* row as today.
- `extract_tube_usage` is fed the same, unfiltered, tube rows as today.
  Whether to feed it only new rows (ending the 193 duplicate
  `scan_seconds` rows) is a separate decision, because `fse_dispatch`
  reads that table.

**Step 2, parser (closes the data-loss edge in §11.1). Approved and implemented 2026-11-03.**
- Store the file's header epoch (`A <epoch>`) in a new Redis key
  `<sme>.<file>.head`. The existing size key is unchanged.
- If the header changed since the last run, read the whole file even when
  `delta > 0`. Step 1 removes the overlap.

**Step 3, acquisition (`hhm_data_acquisition`, separate repo;
recommended).** Download to a temp name and `mv` it into place, so the
parser never sees a half-written file.

A unique index on `log.ge_ct_gesys` is **not** an option. It is a
protected table, 155k duplicates exist, and a partitioned unique index
would have to include `capture_datetime`, which defeats it.

### 11.5 Existing duplicates per system (exact copies; all history 2026‑05…11‑02)

| System | Dup rows | % of rows | In last 90 d (host time) | Dup batches | Last dup capture |
|---|---|---|---|---|---|
| SME18531 | 32,245 | 11.6 | 19,758 | 10 | 11‑02 |
| SME20594 | 21,417 | 37.5 | 0 | 4 | 05‑21 |
| SME14521 | 20,435 | 9.3 | 0 | 7 | 07‑26 |
| SME20608 | 20,266 | 7.6 | 11,258 | 10 | 11‑01 |
| SME14522 | 8,491 | 12.1 | 0 | 3 | 07‑23 |
| SME01434 | 6,353 | 0.7 | 444 | 2 | 10‑02 |
| SME00881 | 5,238 | 7.3 | 0 | 1 | 05‑11 |
| SME21855 | 4,422 | 2.4 | 2,164 | 2 | 08‑26 |
| SME16618 | 4,141 | 7.1 | 2,831 | 2 | 08‑27 |
| SME17371 | 3,778 | 8.8 | 3,778 | 1 | 09‑21 |
| SME21859 | 3,740 | 6.7 | 3,740 | 1 | 09‑18 |
| SME21853 | 3,699 | 7.9 | 0 | 1 | 07‑09 |
| SME01430 | 3,041 | 4.1 | 2,753 | 3 | 09‑24 |
| SME01431 | 2,835 | 1.5 | 670 | 4 | 10‑01 |
| SME21873 | 2,558 | 6.8 | 0 | 2 | 07‑06 |
| SME18536 | 2,140 | 4.7 | 0 | 1 | 07‑23 |
| SME21865 | 1,742 | 2.7 | 112 | 2 | 11‑02 |
| SME21870 | 1,518 | 6.8 | 1,518 | 1 | 10‑08 |
| SME21918 | 1,361 | 6.9 | 0 | 1 | 07‑06 |
| SME21858 | 1,232 | 10.0 | 1,232 | 1 | 08‑31 |
| SME21849 | 1,217 | 10.2 | 0 | 2 | 06‑09 |
| SME01429 | 613 | 1.4 | 613 | 2 | 09‑28 |
| SME21851 | 586 | 1.1 | 0 | 2 | 07‑30 |
| SME21866 | 535 | 1.3 | 273 | 2 | 10‑14 |
| SME21867 | 406 | 1.8 | 406 | 1 | 08‑20 |
| SME21869 | 307 | 0.8 | 307 | 1 | 10‑16 |
| SME21929 | 289 | 3.9 | 0 | 1 | 07‑20 |
| SME21864 | 184 | 0.4 | 0 | 1 | 07‑13 |
| SME15218 | 150 | 0.4 | 150 | 1 | 08‑25 |
| SME21854 | 63 | 0.3 | 0 | 1 | 07‑20 |
| **Total (30 of 34 systems)** | **154,994** (key-based 155,002) | **5.0** of 3,100,150 | 51,992 | 73 | |

By capture partition:

| Partition | Dup rows |
|---|---|
| 2026_05 | 40,233 |
| 2026_06 | 27,407 |
| 2026_07 | 28,455 |
| 2026_08 | 23,973 |
| 2026_09 | 19,824 |
| 2026_10 | 11,508 |
| 2026_11 | 3,594 |

SME00882, SME00875, SME21924 and SME11229 have none.

### 11.6 Cleanup: DONE 2026-11-03 19:54 UTC

Run log (cutoff `2026-11-03T19:45:00Z`, the first run on the fixed
parser):

| Step | Time (UTC) | Result |
|---|---|---|
| Preview | 19:53 | 154,994 duplicates, 49 kept, 154,945 to delete; identical to the approved numbers |
| Archive, dry run | 19:54 | 154,994 rows, rolled back |
| Archive, `--apply` | 19:54 | `archive_log.ge_ct_gesys_dups_20261103`, 154,994 rows (49 flagged `referenced_by_detection`) |
| Delete, dry run | 19:54 | all 7 partitions: pre-checks 0/0/0/0, deleted = expected, rolled back; table still 3,101,660 rows |
| Delete, `--apply` | 19:54:55–59 | all 7 partitions committed, **154,945 rows deleted** |

Deleted per partition:

| Partition | Rows |
|---|---|
| 2026_05 | 40,231 |
| 2026_06 | 27,406 |
| 2026_07 | 28,455 |
| 2026_08 | 23,927 |
| 2026_09 | 19,824 |
| 2026_10 | 11,508 |
| 2026_11 | 3,594 |

Verified afterwards:
- `log.ge_ct_gesys` = 2,946,715 rows, exactly 3,101,660 − 154,945.
- Remaining exact duplicates = 49, which are the kept rows.
- All 358 gesys detections still resolve to a source row.
- `verify`: 0 archived rows still in the log, 0 missing keepers.
- Restore path: insert from the archive table (SQL in the tool header).

Original plan (kept for the record):

Tool: `maintenance/dedupe_ge_ct_gesys.js`. It has separate steps, uses
typed confirmation, and runs as a dry run (BEGIN … ROLLBACK) unless
given `--apply`. `preview` prints the exact SQL.

Read-only preview, 2026‑11‑03 18:27 UTC:
- **154,994 exact duplicates**: every column except `id` and
  `capture_datetime` is equal.
- **49** of them are referenced by `alert.detections.row_id`. These are
  **kept**, so no detection loses its source row. (So 49 of the 358
  gesys detections fired on re-ingested copies.)
- **154,945 to delete.**

| Partition | Delete |
|---|---|
| 2026_05 | 40,231 |
| 2026_06 | 27,406 |
| 2026_07 | 28,455 |
| 2026_08 | 23,927 |
| 2026_09 | 19,824 |
| 2026_10 | 11,508 |
| 2026_11 | 3,594 |

Order of steps:
1. Deploy the step-1 fix to the prod server, so no new duplicates appear.
2. `archive --cutoff <ts> --apply`. This copies the duplicates captured
   before the cutoff into a new
   `archive_log.ge_ct_gesys_dups_YYYYMMDD`, with each row's keeper id and
   source partition. It does not touch `log.*`.
3. `delete --table … ` as a dry run, then with `--apply`. Each partition
   gets its own transaction. All four pre-checks must be 0:
   - the archived row is still identical to the live row
   - its keeper exists and is identical
   - the keeper is not itself archived
   - the row is not newly referenced by a detection

   Then it deletes by primary key, and commits only if the deleted count
   equals the expected count.
4. `verify`.

Restore path: insert from the archive table (the SQL is in the tool's
header). The fix and the cleanup can both be re-run later for any
duplicates that slip through before deploy.

Timing note for `--apply` and cleanup: fse_dispatch's odd-job
`add-pg-table-partitions.sql` creates next-month partitions on protected
tables. If it runs during a migration, the runner's catalog check will
(correctly) abort. Avoid month boundaries.

---

## 12. Phase 2 re-evaluation (2026-11-03, after Phases 1/1b)

Read-only checks on prod, after dedupe:
- The §4 templates match **37%** of rows (last 30 days, 28 reporting
  systems). The rest is mostly routine noise: db checkpoints, "service
  name not found", recon status, ecomm/IPC chatter.
- Every system logs `Start: Prospective Exam`. "Scan Prep" lines are a
  separate per-scan event on 3 newer-software systems, not a missing exam
  start.
- **19 of 31** reporting CT systems have NULL `sites.time_zone_id`. The
  parser silently used America/New_York for them, so their absolute
  `host_datetime` may be off by hours. This is a data gap for the
  `sites` owner; it affects the alert engine too, and is not fixed here.
- No patient identifiers found in 90 days: no DOB, MRN, accession or
  patient-name fields. Messages do contain exam numbers and hostnames,
  and `Svc_Notepad` is free text that people type.

Decisions (user, 2026-11-03):
1. **Rule-version-aware upsert** plus `--rebuild-metric` (§6).
2. **Day and hour come from the device wall clock** (`host_local`, built
   from `host_date` + `host_time`). It is what site staff experience and
   is immune to the missing zones.
3. **The catalog is generated from the rule registry** (§6).
4. **Run record = `insight.job_state`.** The app writes no DB run log on
   this line.
5. **Exact reconciliation** exit criterion (§8).
6. **Time-based overlap re-read** (§6).
7. **`--coverage` report in Phase 2**, with the "every template > 500
   rows/30 d has a rule or an explicit ignore" criterion.
8. **Two new metrics, now.** Both are data only until field service
   confirms what they mean.
   - `compliance.dose_display_disabled`: scanRx "Dose information
     database (Ctdi.cfg) read error. Disabled dose information display
     feature". 7 systems, all on sw 14BW25.15; up to ~1,300/month per
     system.
   - `calibration.air_overdue`: "Only large spot is allowed for patient
     scanning because no air ratio calibration was done more than N
     days". SME21918 (114/30 d) and SME21849 (76).
9. **Scrubbed fixtures.** Exam numbers, hostnames and serials are
   replaced. No `Svc_Notepad` free text except the `PRODUCT
   CONFIGURATION` line. The repo is on GitHub.
10. **Limited login `insight_writer`** (§10).
11. **Target Node v16.20.2** (`vm-debian`).

Migration 003, the schema follow-ups (insight only; the tables are still
empty):
- `ge_ct_facts.host_local timestamp NOT NULL`
- drop the now-unused `ge_ct_daily.time_zone`
- partitions through 2028‑12
- grants to `insight_writer`

It requires the login to exist first.

Considered and left as is: the facts natural key collapses DST
fall-back records that share epoch/rnc (8 historical keys). This is
negligible, and §9 stands.

### 12.1 Phase 2 build status and catalog as built (2026-11-03)

The rule registry `insight/rules/ge_ct.js` is the source of truth for the
catalog. Changes from §4, all driven by real message variants:
- **`system.boot` is now `system.sw_init_complete`, a raw fact.**
  "Software Initialization Complete" fires about 10×/system/day, after
  restarts too. Real boots are derived in Phase 3.
- **`prep.warmup` / `prep.fastcal` / … are now one `prep.tube_temp`**,
  with the step in `value_text` and before/after in `attrs`.
  `service.calibration` is the same, from `scanUtilsRx`.
- **`tube.unrecognized` is folded into `tube.identity`**
  (`value_text = unrecognized`).
- **The rotor "decelerating" message is split in two:**
  `tube.rotor_unexpected_stop` (a fault) and
  `tube.rotor_stop_no_random_position` (an operator habit GE says
  shortens tube life).
- **`scan.abort.operator` comes from the scanmgr message only.**
  `exception_class = 'Operator Abort'` records are separate ermes rows
  (`error.ermes`), so counting both would double count.
- **Plenum is normalized to °C** (one firmware logs 1/100 °C). Recovery
  notices go to their own `env.plenum_recovered`.
- **`xfer.dicom_send` is split** into `xfer.dicom_send_start` /
  `xfer.dicom_sent`, handling three formats (`a/b`, `a/b/...`, `a`).
- **`env.humidity` / `env.psu_temp` are split** into
  `env.psu_temp_out_of_spec`, `env.psu_voltage_out_of_spec` and
  `env.humidity_out_of_range`.
- **New:** `compliance.dose_display_disabled` and
  `calibration.air_overdue` (§12 item 8).

How it's verified (no DB needed):
- 183 real fixtures, built by `insight/tools/build_fixtures.js`. They are
  read-only, scrubbed (exam numbers, hostnames, host_id, DICOM
  destinations, UIDs and IPs), and labelled by an independent SQL
  classifier.
- Every fixture must produce exactly its label, plus class-based
  overlaps (ermes / Abort / Safe State). The "none" fixtures must
  produce nothing.
- Tests: `node insight/test/rules.test.js`, `node insight/test/scrub.test.js`.

Dry run (`node insight/cli.js dry-run`, read-only, 2026-11-03):

| Item | Result |
|---|---|
| Rows | 2,947,116 in 59 s |
| Facts | 1,251,255 |
| Rule errors | 0 |
| Skipped rows | 0 |
| Reconciliation | 585/585 system×metric cells equal the independent SQL (`insight/reconcile_sql.js`) |
| Coverage | 34.9% of rows produce a fact |

**Coverage triage: done 2026-11-03, criterion MET.** Agreed with the
user:
- New reliability metrics: `ipc.event_router_send_failed`, `ipc.sigpipe`,
  `storage.image_space_error`. The registry now has 37 metrics.
- Every template above 500 rows/30 d has a rule or an entry in
  `insight/rules/ge_ct_ignore.js`:
  - **watch** (kept visible as candidate metrics): thermal-state comm
    errors, recon "Removing ISR", Scan Prep, fwmgr lost communication,
    InSite sessions, view corrections
  - **ignore**: everything else, each entry with a reason

Dry run after triage:

| Item | Result |
|---|---|
| Facts | 2,163,661 |
| Coverage | 65.9% of rows |
| Reconciliation | 621/621 cells equal |
| Rule errors | 0 |

Original triage notes:
- **SME01434: 838,355 rows on 2026‑08‑06 alone.** EnvironmentMgr
  "received SIGPIPE, broken pipe" plus "send … to Event Router process
  failed". That is a single-day log storm and about 28% of the whole
  table. It is the real cause of the August row spike. Candidate metric.
- **SME00881: about 56k "Image space query failed" / "Updating image
  space, received a bad status code"** from 05‑08 to 06‑09 (≈1,700/day).
  Possibly an image-storage problem. Candidate metric.
- Other candidates:
  - examRxEnv "Failed to get thermal state from scanmgr" (25 systems)
  - recon_control "Removing ISR … can't even make # image" (29)
  - "Scan Prep" per-scan events (3)
- Likely ignore: db checkpoints, review/film-composer status, "Service
  name not found", ecomm internal errors, recon job progress, badchanmgr
  PASSED checks.

---

## 13. Phase 3 re-evaluation (2026-11-04)

Read-only checks against `insight.ge_ct_facts`, after the Phase 2
backfill. The decisions in §13.2 were agreed with the user on
2026-11-04.

### 13.1 Evidence

**Tube counter resets.** `tube.mas_total` drops below 50% of a prior
reading above 100k, and the following readings stay low. Corroboration
is taken from the 7 days before through 1 day after:

| System | Reset | Old tube life | `service.calibration` facts | Verdict |
|---|---|---|---|---|
| SME16618 | 2026‑06‑04 | 52.8M mA·s | 26 | confirmed |
| SME21864 | 2026‑07‑15 | 57.3M | 9 | confirmed |
| SME15218 | 2026‑05‑28 | 15.2M | 14 | confirmed |
| SME15218 | 2026‑09‑24 | 7.9M | 81 | confirmed (second tube) |
| SME21873 | 2025‑08‑14 | 34.1M | 17 | confirmed |
| SME21873 | 2025‑09‑02 | 0.7M | 0 | **counter only**, needs review |
| SME21873 | 2025‑12‑08 | 3.1M | 24 | confirmed |
| SME21873 | 2026‑01‑28 | 2.2M | 78 | confirmed |

- SME21873's resets are **not glitches**. The counter restarts near
  zero and keeps climbing. Its later tubes lasted only 2–3M mA·s.
- The `tube.identity` messages ("GE tube has been verified",
  "unrecognized X-Ray tube") repeat at boots, so they **don't
  corroborate a swap**. They do show the tube source of each segment:
  most replacement tubes are "unrecognized" (third-party or
  refurbished).
- The tube counter is reported about every 2 days per system.

**Boots.** `system.sw_init_complete`, last 60 days:
- 37,663 came less than 1 minute after the previous init, almost all
  right after a `process.restart` (mostly SME18531's restart loop).
- About 760 came more than 6 h after the previous init. That is roughly
  one per system per day, matching the ~760 `system.shutdown` in the
  same period (daily power cycling).

**Exams.** Last 60 days, 9,334 `exam.start`:
- 96.6% have exactly one `exam.series` before the next start, about 11
  minutes after the start (on average). That is the end-of-exam
  summary.
- 3% have two (a series added later).
- 8 have none.
- 9,334 starts against 9,137 distinct exam numbers: 197 re-opened exams.

**Clocks.** Per system, the smallest capture − newest-host lag over 30
days:
- The 19 systems with NULL `sites.time_zone_id` behave like Eastern
  (lags 2–16 min), so the parser's New York default is right for them.
  SME21854 sits at ~45 min and is ambiguous.
- **Consistently ahead:**
  - SME16618 ~45 min
  - SME21873 ~35 min
  - SME21929 ~10 min
  - **SME11229 ~4.6 h** (looks like a device set to UTC)
- **One-off negative lags** (SME20594, SME01431, SME20608, SME18536):
  probably clock jumps around the 2026‑11‑01 DST change.

### 13.2 Decisions (agreed)

1. **Tube replacement = counter reset that stays low + at least 3
   `service.calibration` facts** in [reset − 7 d, reset + 1 d] →
   `confirmed`. A reset without them is `counter_only`, flagged for field
   service review.
   - `install_date` = the first service calibration in that window, or
     else the reset date.
   - Each tube segment records its tube source (`verified` /
     `unrecognized` / `no_smart_id`): the most frequent `tube.identity`
     value in the segment's first 30 days.
   - The first segment per system is `initial`.
   - `tube.identity` is **not** used as swap evidence.
2. **Clocks: estimate and flag, don't correct (v1).** Store a per-system
   clock-offset estimate with a flag in `insight.system_clock`. Daily
   rollups keep the device wall clock (`host_local`), which is what site
   staff see; offsets under an hour only move events near midnight.
   Revisit if a flagged system matters (SME11229 barely reports).
3. **Daily breakdown column (migration 004).** `insight.ge_ct_daily`
   gets `dim text NOT NULL DEFAULT ''` in its primary key, and
   `api.ge_ct_daily_v` exposes it. It is filled per metric:
   - ermes code for `error.ermes`
   - step for `prep.tube_temp` / `service.calibration`
   - process for `process.restart`
   - destination for `xfer.*`
   - status for `ipc.*`
   - `''` otherwise

   It drives the viewer's errors-by-code, daily prep calendar and
   per-destination transfers.
4. **Derived events are stored as facts.** Phase 3 writes, with
   context:
   - `system.boot` (attrs: `clean` / `unclean`)
   - `tube.replacement` (attrs: confidence, install_date, old/new mA·s,
     tube source)

   Both go into `insight.ge_ct_facts`, keyed on their source record
   (the init row or the reset reading), with catalog entries. A boot is
   a `system.sw_init_complete` with no `process.restart` in the 5 min
   before and ≥ 10 min since the previous init. It is `clean` if a
   `system.shutdown` happened since the previous boot, else `unclean`.
5. **Exams.**
   - One row per (system, exam_no, started_at), from `exam.start`.
   - Series, scans and images come from the **last** `exam.series`
     before the next start (on the same system).
   - Aborts are the `scan.abort.*` facts in that window.
   - Re-opened exams (same exam_no started again) stay separate rows,
     marked `attrs.reopened = true`.
6. **Revised exit criteria** (§13.3). The site checks and field-service
   swap checks move to Phase 7.

### 13.3 Phase 3 exit criteria

- **Tube replacements** exactly as in the §13.1 table: 7 confirmed, 1
  `counter_only` (SME21873 2025‑09‑02), and no other replacements
  fleet-wide. Each has a tube-source value.
- **Exams:** rows = distinct (system, exam_no, started_at) starts, and
  ≥ 95% have a series summary.
- **Boots:**
  - ≈ shutdowns per system (within a reviewed tolerance);
  - the SME18531 restart loop contributes none;
  - unclean boots are listed per system for review.
- **Daily:** for every (system, local_day, metric, dim), n / sum / min
  / max / last reconcile exactly with an independent SQL aggregate of
  facts.
- **Capabilities:** one row per (system, metric) present in facts, with
  first/last seen.
- **Clock flags:** consistent with §13.1 (SME16618, SME21873, SME21929,
  SME11229 flagged ahead).
- **Process:** migration 004 passes the dry run and roundtrip and is
  applied by the user. All writes run as `insight_writer` through
  rehearse → apply → verify.

### 13.4 Handoff: where the next session starts

State at 2026-11-04:
- Phases 1, 1b and 2 are done.
- Prod holds 2,163,802 facts (watermark `ge_ct_extract` = 18543534),
  verified 621/621.
- Facts after the watermark aren't extracted yet. That waits for the
  Phase 5 hook, or a manual `node insight/cli.js backfill --apply`.
- `insight_writer` credentials are in this checkout's `.env`.
- Local `dev` is ahead of `origin` (insight code and plan only;
  nothing the parser runs).

Build order for Phase 3:
1. **Migration 004.**
   - `ge_ct_daily.dim` and its primary-key change (table empty)
   - `insight.system_clock` (system_id, est_offset_min, p10_lag_min,
     min_lag_min, flag, window_start/end, computed_at)
   - grants to `insight_writer`
   - `CREATE OR REPLACE VIEW api.ge_ct_daily_v` adding `dim`
   - add a `system_clock` read to the summary view if useful

   Then: scan → dry run → roundtrip → user applies.
2. **Derived-fact rules** (`system.boot`, `tube.replacement`) with
   catalog entries and fixtures built from the §13.1 cases. They are
   context-aware (they read facts), so they are a separate module from
   the per-row rule engine.
3. **`insight/derive/`**: daily (with dim), exams, tube segments,
   capabilities, clock. Each must support a full rebuild per system,
   and "touched systems/days" for the Phase 5 stage.
4. **`cli.js derive --rehearse | --apply`, plus `verify-derive`**
   (the §13.3 checks, independent SQL).
5. **Plan/status update; ask before committing; promote only when the
   user asks.**

Ground rules carried over:
- prod DB only, through the §10 guards
- read-only ad-hoc queries
- writes only as `insight_writer`
- don't touch the parser behaviour, `alert.*` or `fse_dispatch`

### 13.5 Phase 3 build status and results (2026-11-04)

**Code** (all on `dev`):
- `migrations/004_phase3_derive.sql`.
- `insight/rules/ge_ct_derived.js`: the derived-fact rules. Pure and
  separate from the per-row engine.
- `insight/derive/`:
  - stages: `derived_facts`, `daily`, `exams`, `tube_segments`,
    `capabilities`, `clock`
  - `index.js` (orchestration and scopes)
  - `run.js` (rehearse / apply)
  - `verify.js` and `verify_sql.js` (independent checks)
- `node insight/cli.js derive --rehearse | --apply [--system S | --systems
  A,B]` and `node insight/cli.js verify-derive`.
- Tests:
  - `insight/test/derived.test.js` (12): built on real fixtures in
    `insight/rules/__fixtures__/ge_ct_derived/`
  - `insight/test/derive.test.js` (12)

**Migration 004**, applied 2026-11-04 12:54:51 UTC:
- `ge_ct_daily.dim`, which joins the primary key.
- `insight.system_clock`, granted to `insight_writer`.
- `api.ge_ct_daily_v` with `dim`.
- Three additions approved by the user:
  - `ge_ct_tube_segments.tube_source`, shown in `api.ge_ct_tube_v` and
    the summary view
  - `reopened` in `api.ge_ct_exams_v`
  - `clock_flag` / `clock_est_offset_min` / `current_tube_source` in
    `api.ge_ct_system_summary_v`
- The views are dropped and re-created; none had grants or dependants.
- Runner change: a file may drop and re-create the same object, via
  `scanSql` `freshCreates` / `netDrops`. Functions are excluded (review
  F1 below).

**Implementation choices within the §13.2 decisions:**
- **Tube source (user decision 2026-11-04):**
  - the most frequent of `verified` / `unrecognized` in the segment's
    first 30 days, stopping at the next reset;
  - `no_smart_id` only when neither appears. It is a companion line
    logged next to the verdict at every boot, so a plain "most frequent"
    tied on several systems;
  - an exact tie goes to the value seen first, in record order. This
    affects only SME21873's 2025‑09‑02 `counter_only` segment
    (`verified`, 4 vs 4).
  - Five systems log no verdict at all, so their segments have no tube
    source: SME01429, SME01430, SME14521, SME11229, SME21854.
- **"Stays low":**
  - at least 2 later readings exist, and the next (up to) 3 are all below
    50% of the prior reading;
  - with fewer later readings, the reset is pending. It isn't emitted,
    and it's kept out of the current tube segment (noted in the segment's
    evidence) until a later run decides;
  - null / NaN / ±Infinity readings are ignored by both the JS and the
    SQL.
- **Dates:** `install_date` and `local_day` come from the device wall
  clock (§12), so SME15218's second tube shows install 2026‑09‑23 (the
  §13.1 table's UTC date is 09‑24).
- **`install_date`:** the first service calibration in [reset − 7 d,
  reset + 1 d] if there is one, else the reset day. This applies even for
  `counter_only`.
- **Clock:**
  - window: trailing 30 days, ending at the run time;
  - `ahead` if p10 lag < 0, with `est_offset_min` = −p10 (a lower bound);
  - `lagging` if p10 > 45 min;
  - `jumps` if min lag < −5 min;
  - else `ok`;
  - systems with fewer than 5 captures get no row (28 of 34 have one).
  - Informational only: nothing is corrected.
- **Daily:**
  - the sum is taken over `numeric`, so it's exact and independent of
    row order;
  - last = the latest fact in (host_datetime, epoch, rnc) order;
  - `ipc.sigpipe` has no status, so its `dim` is always `''`.
- **Exams:** `last_activity_at` = the latest start / series / abort in the
  exam's window. `attrs` = `{reopened, series_summaries}`.
- **Writes:**
  - derived facts are a replacement set per system: update only on a
    difference, and delete what's no longer derived;
  - the daily, exam, segment and capability tables are deleted and
    re-inserted per system, or per touched day.
- **Phase 5:**
  - `touched_from_source_range(old, new watermark)` gives the touched
    systems and device days;
  - a system with a new fact more than 14 h off its device clock is
    rebuilt in full instead;
  - exams rebuild from the last start before the earliest touched day;
  - derived facts, tube segments and capabilities are always whole-system
    (cheap).

**Codex reviews** (`REVIEW-PHASE3-*-CODEX.md`), all fixed:
- **004 F1:** function overloads were treated as the same object by the
  drop/re-create exemption. Functions are now excluded from it.
- **Derived F1:** same-second tube-source ties ignored record order.
- **Derived F2:** the verify SQL kept non-finite readings that the JS
  drops.
- **Stages F1:** the touched-day scan bound relied on an unstated
  invariant. It is now enforced: affected systems get a full rebuild, and
  verify checks the invariant.
- **Stages F2:** a derived fact moving to another day didn't report its
  old day.

**Review of the run / verify code** (`REVIEW-PHASE3-RUN-VERIFY-CODEX.md`,
after the apply). All fixed 2026-11-04; none affected the written data:
- **F1:** `derive --apply --system`, with no value given, would have run
  fleet-wide. Every value flag now requires a value.
- **F2:** the exam check didn't compare `protocol` / `local_day`. Now it
  does.
- **F3:** the boot and tube checks keyed on (system, epoch, rnc) without
  `host_datetime`, and didn't fail on a count mismatch. Both fixed.

Re-running the stricter `verify-derive` on the committed data: ALL CHECKS
PASS.

**Found by the rehearsal:** PostgreSQL can't return `xmax` from
`INSERT ... ON CONFLICT` on a partitioned table. Inserted vs updated is
now told from the keys that existed before the upsert.

**Boots: tolerance accepted as listed (user, 2026-11-04); revisit when
more information arrives.**
- Fleet: 3,385 boots, 2,993 desktop shutdowns, 432 unclean.
- Eleven systems have boots/shutdowns outside 0.8–1.25. The largest:

  | System | Boots / shutdowns |
  |---|---|
  | SME01429 | 66 / 9 |
  | SME01430 | 110 / 34 |
  | SME21918 | 8 / 4 |
  | SME00875 | 13 / 7 |

What the 432 unclean boots are (read-only analysis):
- **6 are a rule artifact:** the first boot of a system in our data, with
  no earlier shutdown to find.
- **About 81% (345 of 426) followed a silence of 30 min or more in the
  device log.** The scanner stopped logging without logging a desktop
  shutdown, so power was most likely removed: switch, breaker,
  disconnect, outage or emergency off.
- **About 19% came up while still logging:** a software restart without
  a desktop shutdown.
- **30% had service mode entered in the prior 12 h** (vs 4% for clean
  boots), so field-service work contributes.
- **SME01430, SME01429 and SME01431** (three different sites) hold 173 of
  them. SME01430 and SME01429 go quiet in the evening and come back
  mid-day after 5–8 h; SME01430's clean boots start at 04–05 h instead.
  That looks like routine switch-off without the desktop shutdown.
  SME01430 also logs "Database was abruptly shutdown last time" 5 times.
- **Data loss** (a lost shutdown line, §11.2) can't be ruled out event by
  event, but it would be scattered at random, not patterned by system and
  time of day.

**Follow-ups:**
- **Phase 4 candidate finding:** "powered off without shutdown" (unclean
  boots per week).
- **Phase 7:** confirm the SME01429 / SME01430 / SME01431 practice with
  the sites or field service, together with the SME21873 2025‑09‑02
  `counter_only` reset.
- **Optional rule change (not made):** mark each system's first boot as
  unknown instead of unclean (6 boots).
- **Facts after watermark 18543534 aren't extracted yet,** so derive hasn't
  covered them. Both wait for the Phase 5 hook, or a manual `backfill
  --apply` followed by `derive --apply`.
- **`verify-derive` hard-codes the §13.1 acceptance list.** A new tube
  replacement will (correctly) make it fail until the list is reviewed
  and updated.

## 14. Phase 4 re-evaluation (2026-11-04)

Read-only checks against the Phase 3 tables: `ge_ct_daily`,
`ge_ct_exams`, derived facts and segments. Data runs through watermark
18543534 (device days up to 2026‑11‑03).

**Agreed with the user 2026-11-04:** the §14.2 rules and design as
written, and the §14.3 answers below. The user is not in a position to
confirm how the scanners behave. Thresholds rest on the §14.1 evidence;
field service confirms the meaning in Phase 7, and the thresholds are
tuned then.

### 14.1 Evidence

**Data freshness.** Six systems have sent nothing for 44–160 days:

| System | Last device day |
|---|---|
| SME00875 | 05‑28 |
| SME00881 | 06‑09 |
| SME00882 | 06‑09 |
| SME14521 | 08‑03 |
| SME14522 | 08‑03 |
| SME17371 | 09‑21 |

"This week" rules need an as-of day per system, and must not resolve or
open anything on systems that send no data.

**Rotor stops** (`tube.rotor_unexpected_stop`, per device week):
- **SME21859:** 6–21 every week since its data starts (2026‑04‑27);
  average 13.3, recent weeks 13–21. It is **chronic**: twice its 8-week
  median (about 26) is never reached, so the §5 rule (≥ 5 **and** ≥ 2×
  its own median) would never fire. It also has `tube.rotor_not_at_speed`
  on 129 days.
  - Correction to §1: the deduped device-week series is about 13 → 20,
    not 12 → 26.
- **Isolated spikes elsewhere:**
  - SME18536: 8 in the week of 06‑15, 5 in the week of 08‑10;
  - SME01430: 7 in the week of 07‑06.
- **No rotor stops in the 28 days before any of the 8 tube
  replacements.**

**Process restarts.** Only SME18531 ever exceeds 50 a day
(`device_eventlog`, 2026‑09‑12 → 14, peak 17,222 a day). Every other
system peaks at 6 a day. The §5 rule works as written.

**System aborts** (`scan.abort.system`, which is `exception_class =
'Abort'`), per 100 exams:
- **SME21867 is chronic:** 410 per 100 exams over all history, and ≥ 50 in
  18 of 26 rolling 28-day windows (median 288). The causes are DAS
  power-supply errors (260007391, 1,361) and DCB errors (260101023,
  1,035): a hardware fault.
- **Episodic bursts elsewhere** (28-day windows with ≥ 20 exams):

  | System | Peak rate | Notes |
  |---|---|---|
  | SME21873 | 820 | CCB, open filament, aperture faults |
  | SME21851 | 460 | |
  | SME21866 | 196 | |
  | SME15218 | 136 | |
  | SME21864 | 93 | |
  | SME14521 | 74 | median 46; CCB and filter A homing faults |

- **"Fleet p90 for that model" isn't usable:** there are only 1–7 systems
  per model. A p90 rule also always flags the top 10% by construction.
- **Aborts tend to rise before a tube replacement and fall after it:**
  - this held in 6 of the 8 replacements: 21–235 per 100 exams in the 28
    days before, 0–7 in days 7–34 after;
  - SME21864 is the exception (21 before, 64 after), and SME21873's
    2025‑12‑08 reset showed 0 both before and after.

  This is a candidate tube-failure signal for later, not for v1.
- **Operator aborts** run at 20–98 per 100 exams on many systems. That's
  normal workflow, not a finding.

**Safe state** (`scan.safe_state`):
- **260116316, "Slip-Ring Communications are DOWN"**, is 3,110 of 3,331
  events. 95% (2,964) fall within 30 minutes of a boot or shutdown: it's a
  power-cycle side effect, logged at about the same count as boots per
  system.
- **Other codes:**
  - 260112009, "Emergency Off button has been pressed": 221 (SME21873
    28, SME15218 21, SME16618 20; the first two are tube-replacement
    systems);
  - 260116313, TGP–host LAN communication down: 163;
  - 260111018, GUIF communication: 16.

**Prep compliance.** Fast Calibration is logged on all 34 systems, as
`Fast Calibration` or `Cold Tube Warmup (Fast Calibration)`. The share of
scan days (days with an exam) without one separates cleanly:

| System | Scan days without Fast Cal |
|---|---|
| SME21855 | 87% |
| SME01429 | 83% |
| SME16618 | 74% |
| next highest, SME17371 | 31% |
| SME18536 | 26% |
| all others | ≤ 20% |

The three outliers run `Cold Tube Warmup` daily, and Fast Calibration and
the rest of the daily sequence only on 17–50 days.

**Environment.** Mostly chronic on specific systems:
- SME20608: plenum, PSU temperature and PSU voltage out of spec on every
  one of its 188 days;
- SME01430: plenum on 175 days;
- SME18531: plenum on 135 days, humidity on 40;
- detector temperature low is episodic: SME21873 on 14 days, SME21867 on
  13, SME20594 on 10.

A "≥ 3 of the last 7 days" rule therefore leaves a few findings
permanently open.

**Warm-up habit.** Of the 17 systems that can log it, the share of scan
days with a skipped warm-up or a yellow-zone scan is 98% (SME14521), 92%,
87%, 84%, 79%, 74%, 63%, 60%, 58%, then 40% and below. The §5 threshold of
≥ 20% flags 12 of the 17.

**Tube usage spikes.** A week's counter delta at ≥ 2× its trailing 8-week
median happens on 15 systems (SME21873 in 13 of 69 weeks). The counter
reports only about every 2 days, so weekly deltas are noisy, and a busy
week isn't a fault.

**Powered off without a shutdown** (unclean boots, §13.5). Weeks with ≥ 3:
SME01430 10, SME01429 8, SME01431 8, then SME15218 4 and SME21873 3.
Everything else ≤ 2. Many of the occasional ones follow service mode.

**Other chronic or episodic signals** (data only for now):

| Metric | Systems |
|---|---|
| `calibration.air_overdue` | SME21849 214 days, SME21873 172, SME15218 162, SME21918 48 |
| `das.link_errors` | SME01429, 146 days |
| `tube.filament_aging` | SME21918, 33 days |
| `storage.image_space_error` | SME00881, 6 days with 56k events |
| `compliance.dose_display_disabled` | 8 systems daily (data only until field service confirms, §12 item 8) |

### 14.2 Changes (agreed 2026-11-04)

**Evaluation model**
1. **As-of evaluation.** Each rule is a pure function of (system, as-of
   device day D) over `ge_ct_daily`, `ge_ct_exams`, facts and segments.
   - Windows are device days: 7 d = D−6..D; baselines are the 8 weeks
     before that.
   - A run evaluates each system as of its latest device day ≤ today.
   - A system with no data in the last 7 device days isn't evaluated:
     findings keep their state, and the API shows `data_through`.
     Offline detection stays with `alert.offline_hhm_conn`.
2. **Open / resolve.**
   - A finding opens when its rule trips, and resolves after a quiet
     period of 14 evaluated days without tripping (7 for the daily
     rules).
   - At most one open finding per (system, finding_key); this is already
     enforced by an index. A re-trip after it resolves opens a new row.
   - Severity may rise while a finding is open, never fall.
   - `evidence` holds the series, counts, top ermes codes, the thresholds
     used, and `rule_version`.
3. **Replay.** The same evaluator runs day by day over all history, to
   build `insight.findings` with real `opened_at` / `resolved_at`. That's
   needed both for the exit review and for history in the viewer. It's
   idempotent: re-running a day changes nothing.

**Rules**

| # | Finding | Proposed rule | Severity | Expected from replay |
|---|---|---|---|---|
| 1 | `tube_rotor_instability` | **sustained:** ≥ 5 rotor stops in ≥ 3 of the last 4 weeks → high. **spike:** this week ≥ 5 and ≥ 2× the trailing 8-week median → medium. Drops the undefined "rising trend". Evidence includes `rotor_not_at_speed` | high / medium | SME21859 (high, from the start); spikes on SME18536 and SME01430 for review |
| 2 | `process_restart_loop` | unchanged: one process ≥ 50 restarts in a device day | medium | SME18531 2026‑09‑12 → resolves after the quiet period |
| 3 | `abort_rate_high` | **chronic:** 28-day system aborts ≥ 50 per 100 exams (≥ 20 exams) → medium. **spike:** 7-day rate ≥ 30 per 100 and ≥ 3× the system's own 8-week baseline (≥ 10 exams) → medium. Drops the "fleet p90 per model" condition. Evidence: top ermes codes | medium | SME21867 (chronic); episodes on SME21873, SME14521, SME21851, SME15218 and others for review |
| 4 | `safe_state_recurrent` | the same safe-state code ≥ 3 times in 7 days, **excluding 260116316 and any safe state within 30 min of a boot or shutdown** | medium | E‑off and TGP-LAN episodes, for review |
| 5 | `prep_noncompliance` | in the last 14 days, > 50% of scan days have no Fast Calibration (`Fast Calibration` or `Cold Tube Warmup (Fast Calibration)`); needs ≥ 5 scan days | low | SME21855, SME01429, SME16618 |
| 6 | `tube_replaced` | opens on a `tube.replacement` fact (`opened_at` = install date); resolves after 30 days | info (confirmed) / low (`counter_only`, needs field-service review) | the 8 replacements |
| 7 | `env_out_of_tolerance` | split by sensor family (`env_plenum`, `env_detector_temp`, `env_humidity`, `env_psu`): ≥ 3 of the last 7 days | medium | chronic: SME20608, SME01430, SME18531 (permanently open; field service to review whether it's the sensor or the site); episodic detector-temperature findings |
| 8 | `warmup_bypass_habit` | **≥ 50%** of scan days in 28 days (§5 had 20%), only on systems with the capability | low | about 9 systems: a habit, likely customer-visible |
| 9 | `powered_off_without_shutdown` (**new**, §13.5) | ≥ 3 unclean boots in 7 days, not counting boots with service mode entered in the 12 h before | low | SME01430, SME01429, SME01431 |
| 10 | `air_calibration_overdue` (**new**) | `calibration.air_overdue` on ≥ 3 of the last 7 days. The message itself says the system limits scanning to the large focal spot | low | SME21849, SME21873, SME15218, SME21918 |
| — | `tube_usage_spike` | **drop as a finding**; keep mA·s/day as a viewer metric (noisy, and not a fault) | — | — |

Data only, not findings in v1 (shown in the viewer, revisited in Phase
7): `das.link_errors`, `tube.filament_aging`, `storage.image_space_error`,
`compliance.dose_display_disabled`, the abort-before-replacement pattern,
and E‑off counts outside rule 4.

**Schema (migration 005, small).**
- `insight.finding_catalog`: `finding_key` PK, label, description,
  category, default severity, `rule_version`, `customer_visible`. It's
  generated from the findings registry, like `metric_catalog`, so the
  viewer and the frontend get labels.
- `findings.data_through date`.
- `api.ge_ct_findings_v` joins the catalog for labels.
- Grants to `insight_writer`.

**Code.**
- `insight/findings/`: a registry of pure rules (`evaluate(ctx, D) →
  {trip, severity, observed, baseline, evidence} | null`), the
  open/resolve state machine, a replay driver, and `verify_sql.js`.
- `cli.js findings --rehearse | --apply [--replay]` and
  `verify-findings`, through the same rehearse → apply → verify path as
  derive.
- Phase 5: after derive, evaluate the touched systems; once a day, all
  systems.

### 14.3 Questions and answers (2026-11-04)

1. **Rules 1–10, including dropping `tube_usage_spike` and adding
   `powered_off_without_shutdown` and `air_calibration_overdue`:**
   **agreed** by the user.
2. **Warm-up habit:** **a low finding at ≥ 50%** of scan days in 28 days,
   as in rule 8. It's a habit that customers can act on; low severity
   keeps it out of the medium/high review.
3. **Chronic environment findings:** **medium, as proposed**, and left
   open. Each chronic case is listed for field service in Phase 7 (sensor
   vs site). If they turn out to be sensor faults, the rule gets a
   chronic exception then.
4. **Catch-up first: yes.** The first implementation step (§14.5 step 1)
   runs `backfill --rehearse` → `--apply`, then `derive --rehearse` →
   `--apply`, then `verify` + `verify-derive`. Findings then use data up
   to the day of the run.
5. **Exit review:** the user can't judge system behaviour, so the review
   is **evidence-based**:
   - every medium/high finding outside the three named problems is shown
     with its log evidence (codes, messages, series), and is either
     explained by that evidence or its rule is tuned;
   - the user accepts the list on that basis;
   - **field service confirms the findings in Phase 7**, starting with
     the SME21859 rotor and the chronic environment cases.

### 14.4 Phase 4 exit criteria (agreed)

- **The three named problems:** the replay opens
  - `tube_rotor_instability` (high) on SME21859,
  - `process_restart_loop` on SME18531, opened 2026‑09‑12 and resolved
    after the loop,
  - `abort_rate_high` (chronic) on SME21867.
- **The full replayed list is reviewed with the user, per rule, with log
  evidence** (§14.3 Q5).
  - Every medium/high finding outside the three above is either explained
    by its evidence or its rule is tuned.
  - Low/info findings are listed, not individually reviewed.
  - Field-service confirmation is Phase 7, not an exit criterion here.
- **Every open finding reproduces from independent SQL** at its as-of
  day (`verify-findings`).
- **Evaluation is idempotent:** re-running replay or the same day changes
  nothing.
- **Process:** migration 005 passes the dry run and roundtrip and is
  applied by the user. All writes go through rehearse → apply → verify as
  `insight_writer`.

### 14.5 Build order

1. **Catch-up** (§14.3 Q4): `backfill --rehearse` → `--apply`, then
   `derive --rehearse` → `--apply`, then `verify` + `verify-derive`.
   - `verify-derive`'s §13.1 acceptance list fails if a new tube
     replacement appears in the new data. If that happens, review it and
     update `EXPECTED_REPLACEMENTS`.
   - The clock flags may also move with the new 30-day window.
2. **Migration 005:** scan → dry run → roundtrip → the user applies.
3. **Findings registry + evaluator + state machine,** with fixture tests
   from the §14.1 cases.
4. **Replay + `cli.js findings --rehearse | --apply` + `verify-findings`.**
   Show the rehearsal and the replayed list before applying.
5. **Plan/status update.** Ask before committing.

### 14.6 Handoff: where the Phase 4 implementation starts

State at 2026-11-04:
- **Phases 1–3 are done.** Phase 3 was applied and verified (§13.5) and
  reviewed by Codex (4 reviews, 8 findings, all fixed).
- **Prod data:** 2,163,802 per-row facts (extract watermark 18543534)
  plus 3,393 derived facts; derived tables are filled; `job_state`
  `ge_ct_derive` = 18543534.
- **Data after 2026‑11‑03 isn't extracted yet.** That's §14.5 step 1.
- **Branch:** `dev` was pushed to `origin` at `4fe02b1` (staging and prod
  branches untouched). The plan update with §14 comes after it.
- **Credentials:** the `insight_writer` credentials are in this
  checkout's `.env`.

Start with §14.5 step 1. Stop for the user's go-ahead after migration
005's dry run and roundtrip (the user applies it), and before any
findings `--apply`. Reuse the Phase 3 patterns:
- pure rules + fixtures from real cases;
- independent verify SQL;
- rehearse (rolled back, with an idempotency pass) → apply → verify;
- a Codex review handoff per step;
- ask before committing; push or promote only when the user asks.

Ground rules carried over:
- prod DB only, through the §10 guards;
- read-only ad-hoc queries;
- writes only as `insight_writer`;
- schema only through `migrations/run.js`;
- don't touch parser behaviour (`jobs/`, `acquisition/`, `persist/`,
  `read/`, `redis/`, `index.js`), `alert.*`, `fse_dispatch` or `utils/`.
- The Phase 5 `index.js` hook isn't part of Phase 4.

### 14.7 Phase 4 build status and results (2026-11-04)

**Code** (all on `dev`):
- `migrations/005_phase4_findings.sql`: `insight.finding_catalog`, the
  `findings → finding_catalog` FK, `findings.data_through date NOT NULL`,
  `api.ge_ct_findings_v` with catalog labels, grants to `insight_writer`.
- `insight/findings/`:
  - `rules.js`: the registry, rules 1–10 as 13 finding keys (rule 7 split
    into `env_plenum`, `env_detector_temp`, `env_humidity`, `env_psu`). Pure
    `evaluate(ctx, D)`; `tube_replaced` is event-driven. Generates the
    catalog.
  - `context.js`: per-system inputs as dense day arrays; `state.js`: the
    open/resolve fold and replay; `load.js`: inputs (read-only).
  - `run.js`: reconcile / rehearse / apply; `verify.js` and `verify_sql.js`:
    the independent SQL; `report.js`: the per-rule review list.
- `node insight/cli.js findings --rehearse | --apply [--replay] [--system S
  | --systems A,B] [--report FILE]` and `node insight/cli.js
  verify-findings`.
- Tests: `insight/test/findings.test.js` (30), on fixtures from 13 §14.1
  systems in `insight/rules/__fixtures__/findings/` (built by
  `insight/tools/build_findings_fixtures.js`; expected findings come from
  the independent SQL).

**Implementation choices within the §14.2 decisions:**
- **Evaluated days are data days** (days with any fact) up to `today`.
  Production can only evaluate a day it has data for, so replay gives what
  daily runs would. Data on later device days (a clock ahead) is ignored,
  including boots, shutdowns and service-mode entries.
- **Every run recomputes from history** (~0.2 s per system) and reconciles
  the table. `--replay` makes the table exactly the replay. The default run
  (the Phase 5 path) evaluates only systems with data in the last 7 device
  days and never changes a resolved finding; a disagreement on any column
  is reported as drift. Each system's as-of date is kept in
  `job_state.last_run_stats.as_of_by_system`; `verify-findings` checks each
  system at its own date.
- **Times:** `opened_at` / `resolved_at` = the instant of the device day's
  local midnight (offsets are whole hours on every system). Every finding
  opens and resolves on a data day. `last_evaluated` = newest fact on
  `data_through`. Nothing depends on the run's clock, so runs are
  idempotent.
- **Quiet period:** 14 evaluated days, 7 for `process_restart_loop`.
- **Rule readings:**
  - rule 1: weeks are rolling 7-day blocks ending at D; the 8-week median
    uses prior weeks with data and needs ≥ 4 of them;
  - rule 3: integer threshold comparisons; no spike without baseline exams;
  - rule 4: ±30 min of a boot or shutdown; safe states without a code are
    excluded;
  - rule 5: only `Fast Calibration` and `Cold Tube Warmup (Fast
    Calibration)` (not `GSI Fast Calibration`, 2 systems);
  - rule 6: opens on the first data day on or after the install date;
    resolves on the first data day ≥ install + 30, or at the next
    replacement (SME21873, 19 days);
  - rule 8: no minimum scan days;
  - rule 9: service mode `enter` in [boot − 12 h, boot).
- Categories: `powered_off_without_shutdown` and `air_calibration_overdue`
  are `compliance`.
- No raw log text in evidence: codes and counts only.

**Tuning from the replay evidence** (user approved the recommendations
2026-11-04; still `rule_version` 1, nothing had been written):
- **`abort_rate_high`:** the count is abort log lines, and one exam can
  carry hundreds (SME21851: 322 lines in one exam in 43 min; 12 spikes
  rested on 3–9 lines). An exam-based rate was ruled out: SME21867 peaks
  at 10.1% of exams, so it would lose its agreed chronic finding. Change: a
  spike needs ≥ 10 abort lines, and both variants need aborts on ≥ 2 days
  of the window. 38 → 24 findings; SME21867 still chronic.
- **`safe_state_recurrent`:** 7 of 19 opened on a single incident logged
  as 3–34 lines within minutes. Change: count incidents (the same code
  again within 30 min of its previous event is the same incident). 19 →
  11.

**Rehearsal** (one transaction, rolled back) before the apply: pass 1
(replay) 112 findings; pass 2 changed nothing; a default run after the
replay changed nothing, 0 drift; incremental consistency (replay as of
10-07, then default runs a week apart to 11-04) ended identical to the full
replay, 0 drift; `verify-findings` PASS inside the transaction.

**Replayed list** (as of 2026-11-04; 112 findings, 29 open):

| Finding | Findings (open) | Severity |
|---|---|---|
| `tube_rotor_instability` | 4 (1) | 1 high (SME21859), 3 medium spikes (SME01430, SME18536 ×2) |
| `process_restart_loop` | 1 (0) | medium (SME18531) |
| `abort_rate_high` | 24 (4) | medium |
| `safe_state_recurrent` | 11 (0) | medium, all Emergency Off (260112009) |
| `env_plenum` / `env_humidity` / `env_psu` / `env_detector_temp` | 10 (5) / 3 (1) / 1 (1) / 2 (1) | medium |
| `prep_noncompliance` | 6 (3) | low (SME21855, SME01429, SME16618 open) |
| `tube_replaced` | 8 (0) | 7 info, 1 low (SME21873 `counter_only`) |
| `warmup_bypass_habit` | 16 (10) | low, 12 systems |
| `powered_off_without_shutdown` | 16 (0) | low, mostly SME01429/30/31 |
| `air_calibration_overdue` | 10 (3) | low |

**Evidence review of the 53 medium/high findings outside the three named
ones** (§14.3 Q5): each is explained by the codes and series in its
evidence.
- Environment (16): ≥ 3 out-of-range days in 7. Chronic and open: SME20608
  plenum + PSU (187 trip days), SME01430 plenum (186), SME18531 plenum
  (145). Episodic: SME18531 humidity, SME01431, SME14521, SME14522 (open
  until they stopped sending 08-03), SME16618 (tube install day), detector
  temperature on SME00881 and SME21851.
- Rotor spikes (3): 5–9 stops a week against a median of 0–1.
- Aborts (23): 6 around a tube replacement (SME15218 ×2, SME16618,
  SME21864, SME21873 ×2: the §14.1 pre-replacement pattern); 9 dominated
  by one code; 7 recurring low-level codes 260118236 / 260118238; SME21859
  chronic at its data start.
- Safe state (11): Emergency Off pressed in ≥ 3 separate incidents. 10 of
  the 11 had service mode entered in the 7 days before, 4 at a tube
  install. **For Phase 7:** ask field service whether E-off during service
  work should be excluded.

**Codex reviews**, all fixed:
- `REVIEW-PHASE4-RULES-CODEX.md`: **F1** raw safe-state message text in
  customer-visible evidence (now codes only); **F2** later boots /
  shutdowns could change an as-of result (now cut at the as-of day, JS and
  SQL); **F3** the SQL dropped a replacement whose install day had no data
  (now both open on the first data day on or after it).
- `REVIEW-PHASE4-RUN-VERIFY-CODEX.md`: **F1** safe states without a code
  were grouped as one code (now excluded); **F2** `verify-findings` used
  the last fleet date after a `--systems` apply (now per-system as-of
  dates); **F3** `--report` could omit stale systems (now requires
  `--replay` and states its scope).
- Also fixed before the second review: the drift check compared only
  status and evidence; it now compares every stored column.

**Notes:**
- `insight_writer` can't read the `api` schema (by design); check the
  views with another login.
- **Phase 5:** after derive, run the default findings path for the touched
  systems; once a day, all systems (`findings --apply` without `--replay`).
- **Phase 7:** field service to confirm, starting with SME21859's rotor and
  the chronic environment cases; plus the E-off-during-service question and
  whether the abort spike/day minimums are right.

## 15. Phase 5 re-evaluation (2026-11-04, after Phase 4)

**AGREED with the user 2026-11-04:** the §15.2 design, the recommended
answer to every §15.3 question, the §15.4 exit criteria and the §15.5
build order. Phase 5 puts the pipeline into the `ge_ct` run.
Phases 2–4 built every step as a manual CLI command; this section records
what the stage needs on top, from the code and from prod (read-only).

### 15.1 Evidence

**Run cadence** (capture times, 2026-11-04): `ge_ct` runs every 30 min
(:18 and :48 UTC). A run brings 210–420 gesys rows from 14–20 systems:
about 12k rows a day, as §2 assumed (350k/month).

**Measured costs** (Phases 3–4, against prod):

| Step | Measured |
|---|---|
| extract | 4,102 rows in 0.8 s (one batch) |
| derive, full rebuild | 27–31 s for 34 systems: too slow for every run |
| derive, touched days | 11.8 s for the last 150k gesys ids (28 systems, 444 days); a 30-min run touches ~20 systems × 1–2 days |
| findings, all systems | 7–9 s (about 0.2–0.3 s per system, mostly loading) |

**What exists:**
- `run_extract` (`load.js`): apply resumes from the `ge_ct_extract`
  watermark, one transaction per 50k batch.
- `run_derive` (`derive/run.js`): apply rebuilds **whole systems** only.
  The touched path (`touched_from_source_range`, a scope with days, the
  full-rebuild promotion when a fact is > 14 h off its device clock) is
  built and proved identical to a full rebuild, but is only used by the
  rehearsal's pass 3.
- `run_findings` (`findings/run.js`): the default mode is the Phase 5
  path (fresh systems, resolved history kept, per-system as-of dates).
- Each of the three takes and releases the shared advisory lock itself.

**What doesn't exist:**
- `insight/index.js` / `run_ct_insight`, the `index.js` hook, the
  `INSIGHT_ENABLED` switch.
- **The §6 late-commit re-read.** Extract reads `id > watermark` only. If a
  `ge_ct` run overlaps another (e.g. one hangs), rows the other run inserted
  with lower ids but committed later are skipped for good. Derive's touched
  scope is a source-id range too, so a re-read alone wouldn't mark their
  days as touched.
- A per-run ceiling on the stage's own work (only the per-batch "≤ 3 facts
  per row" runaway guard exists).
- The unmatched-template digest (§6 step 5).

**Data since the last catch-up** (watermark 18547636) accumulates until
the stage is live, about 12k rows a day.

### 15.2 Design (agreed)

1. **`insight/index.js` `run_ct_insight(run_log)`**, called from
   `on_boot()` after the system loop, for `GE_CT` only, inside its own
   try/catch: it logs to `run_log` and never fails the `ge_ct` run.
   - Off unless `INSIGHT_ENABLED=true`.
   - Connects as `insight_writer` (own pool, closed at the end).
   - Preflight: schema version ≥ 5, the writer role; otherwise log and
     skip.
   - **One advisory lock held for the whole stage.** The three run
     functions get lock-free cores; the CLI keeps its current behaviour.
     If the lock is held (a manual CLI run), the stage skips and the next
     run catches up.
2. **Steps, each catching up from its own watermark** (self-healing: a
   failed or skipped step is redone by the next run):
   1. extract from `ge_ct_extract` (at most one 50k batch per run, Q5);
   2. derive the touched days since `ge_ct_derive`, one transaction per
      system, then the clock; advance `ge_ct_derive`;
   3. findings, default mode, for the systems derive touched; once a day
      (Q3) all systems, which also writes the fleet row of
      `ge_ct_findings`.

   A step runs only if the one before it succeeded. Each step's counts and
   ms go to `run_log`.
3. **Late commits (Q2):** re-read rows with `id ≤ watermark` and
   `capture_datetime` ≥ the watermark's capture time − 2 h that produced
   no facts. Take derive's touched days from the facts each upsert actually
   inserted (`RETURNING`), recorded in `job_state ge_ct_derive` stats until
   derive has covered them, not from the source-id range alone.
4. **A stage rehearsal before deploy:** `cli.js stage --rehearse` runs the
   whole stage on the current pending range in one rolled-back
   transaction. It reports per-step time and proves that derive touched =
   full rebuild and findings default = replay (as the Phase 3–4
   rehearsals did). This is the evidence for "seconds, not minutes".
5. **Deploy:** dev → staging → prod (fast-forward), the user pulls on
   `vm-debian`. Deploy first with `INSIGHT_ENABLED` unset and confirm
   ingest is unchanged. Then set `INSIGHT_ENABLED=true` in
   `/home/prod/hhm_rpp_ge/.env` (the writer credentials are already
   there). The first live runs catch up the backlog one batch at a time.
6. **Monitoring for the 7 days:** the run-log events per step; once a day,
   `verify`, `verify-derive` and `verify-findings` by hand.
   `verify-derive`'s §13.1 list fails on a new tube replacement (review and
   update it, §13.5), and its clock flags may move.

### 15.3 Questions and answers (agreed 2026-11-04: the recommendation in each)

1. **Kill switch default: AGREED, off unless `INSIGHT_ENABLED=true`**, so deploying the code changes nothing until it's
   switched on.
2. **Late commits: AGREED, build the re-read** as in §15.2 item 3 (≤ 2 h
   of rows, ~1k, mostly no-ops). Not chosen: accepting the risk because
   runs rarely overlap.
3. **Daily all-systems findings pass: AGREED, the first run whose UTC
   date differs from the last fleet run's `today`** (no new cron line).
4. **Unmatched-template digest: AGREED, deferred to Phase 7.** The
   Phase 2 coverage criterion was met, and `cli.js dry-run` prints the
   same report on demand.
5. **Per-run ceiling: AGREED, at most one 50k-row extract batch per run**,
   so a backlog is caught up over several runs instead of one long one.
   Not chosen: a hard skip above N rows plus a manual CLI catch-up.

### 15.4 Exit criteria (agreed)

- The stage rehearsal (§15.2 item 4) passes; a typical 30-min run adds
  seconds to `ge_ct`, measured.
- 7 consecutive days of clean runs; all three watermarks advance and stay
  equal at the end of each run.
- `verify`, `verify-derive` and `verify-findings` pass at the end (any
  `verify-derive` failure is a reviewed new tube replacement or clock
  flag).
- Default findings runs report 0 drift.
- Ingest is unaffected with `INSIGHT_ENABLED` off and on (`log.ge_ct_gesys`
  inserts, Redis, `offline_hhm_conn`, `extract_tube_usage` unchanged).

### 15.5 Build order (agreed)

1. Lock-free cores for extract, derive and findings (CLI unchanged);
   derive's touched-scope apply path.
2. The late-commit re-read and the inserted-keys touched scope (if Q2 is
   agreed).
3. `insight/index.js` (stage, switch, daily trigger, ceiling) and `cli.js
   stage --rehearse`; tests.
4. Stage rehearsal against prod; Codex review.
5. The `index.js` hook (the only change outside `insight/`); review.
6. Deploy off, check ingest, switch on, monitor 7 days.

Checkpoints for the user's go-ahead: after step 1–3's tests and review,
after the stage rehearsal (step 4), before the `index.js` hook (step 5),
and before each deploy action (step 6). The user promotes branches and
pulls on `vm-debian` only when they say so.

### 15.6 Handoff: where the Phase 5 implementation starts

State at 2026-11-04 16:10 UTC:
- **Phases 1–4 are done** (§14.7). Prod: 2,166,335 per-row facts + 3,407
  derived; derived tables filled; 112 findings (29 open), 13 catalog rows.
  Watermarks `ge_ct_extract` = `ge_ct_derive` = `ge_ct_findings` =
  18547636. Migrations 001–005 applied.
- **New gesys rows accumulate** after 18547636 (~12k a day) until the stage
  is live; the first live runs catch up one batch at a time (Q5), or a
  manual `backfill` → `derive` → `findings` catch-up can be run first.
- **Branch:** `dev`, not pushed since `4fe02b1` (Phase 4 commits
  `4d8a345`, `3420fcf`, `63377f7` and the plan update are local).
  `staging` / `prod` untouched.

Start with §15.5 step 1. Reuse the Phase 3–4 patterns: pure cores with
tests; rehearse (rolled back) → apply → verify; a Codex review handoff per
step; ask before committing; push or promote only when the user asks.

Ground rules carried over:
- prod DB only, through the §10 guards; ad-hoc queries read-only;
- writes only as `insight_writer`; schema only through `migrations/run.js`
  (the user applies migrations); none is expected for Phase 5;
- `index.js` gets only the hook (§15.5 step 5); don't change parser
  behaviour (`jobs/`, `acquisition/`, `persist/`, `read/`, `redis/`),
  `alert.*`, `fse_dispatch` or `utils/`;
- `/home/prod/hhm_rpp_ge` is the production checkout: don't touch it; the
  user edits its `.env` and pulls.

---

## 16. Phase 6 re-evaluation (2026-11-05, during Phase 5 monitoring)

**AGREED with the user 2026-11-05:** the §16.2 design, the recommended
answer to §16.3 Q1–Q5, the §16.4 exit criteria and the §16.5 build order.
Q6 (the review set) was settled at step 6. **DONE 2026-11-06** (see
Status). Phase 6
builds the internal viewer from §7. This section records what the
`api` views and `sme_reports` actually offer, both read-only, on
2026-11-05. It also records where that changes §7. Phase 6 only reads
from prod, and it doesn't touch the `hhm_rpp_ge` pipeline. It can
therefore run during the Phase 5 monitoring window.

### 16.1 Evidence

**What the contract holds.** The five `api.ge_ct_*` views exist and are
current: migrations 004 and 005 rebuilt them for the new columns.

| View | Rows | Systems | Notes |
|---|---|---|---|
| `ge_ct_daily_v` | 105,064 | 34 | 2025-05-06 to 2026-11-05. The last 180 days are 88.5k rows (32 MB as JSON). `error.ermes` has 451 distinct codes |
| `ge_ct_exams_v` | 42,095 | 34 | The last 180 days are 37.6k rows (9.6 MB as JSON) |
| `ge_ct_tube_v` | 42 | 34 | |
| `ge_ct_findings_v` | 113 | 27 | `evidence` is 102 kB in total, 1.6 kB at most for one finding. No raw log text (review PHASE4-RULES F1) |
| `ge_ct_system_summary_v` | 34 | 34 | |

**What §7 asks for that the views can't give:**
1. **Identity.** The views carry only `system_id`. Model, site and
   customer come from `public.systems` → `sites` → `customers`, as in
   `sme_reports/sql/get-system-identity.sql`. All 34 systems resolve (GE,
   CT): Intelas 27, Lee Health 4, Piedmont HealthCare 3.
2. **Local time of day.** `ge_ct_exams_v` has `started_at` (an instant)
   and `local_day`, but nothing that gives the device's local hour. Local
   midnight per device day exists only in the facts (findings
   `DAYS_SQL`), and the busy-hour heatmap needs it. A fleet-wide
   aggregate over the facts takes 0.4–0.6 s (5,057 system-days, 4
   distinct clock offsets).
3. **Capabilities.** The difference between "this model doesn't log it"
   and "zero events" (§3) lives only in `insight.system_capabilities`.
   Coverage is very uneven:
   - `env.plenum_temp`: 9 systems;
   - rotor metrics: 3–13 systems;
   - humidity and PSU: 1 system each;
   - `exam.start`, `tube.mas_total`, `system.boot`: all 34.

**Data that changes the §7 fleet view:**
- **Systems not reporting.** 6 of the 34 have had no data for more than 7
  device days:
  - SME00875, since 05-28;
  - SME00881 and SME00882, since 06-09;
  - SME14521 and SME14522, since 08-03;
  - SME17371, since 09-21.

  They still hold open findings, frozen by design (§14.2: they are no
  longer evaluated). Sorted by attention, they would top the list.
- **Tubes that predate the data.** For a current tube whose
  `install_confidence` is `initial`, the install date is null and
  `current_tube_mas` counts only from the start of our data. "Tube age"
  (§7) must say "since data start".
- **`tube_replaced` findings** stay open as info/low for 30 days after a
  replacement. They are news, not a problem, and shouldn't drive
  attention.
- **Clock flags** are in `system_summary_v.clock_flag` (for example
  SME20608 `jumps`, SME20594 ahead).
- **88 GE CT systems in `public.systems`** have no gesys data in
  `insight`.

**`sme_reports` today** (reports repo `~/hep3/reports`, branch `DEV` at
`2e060cb`):
- **One-file app.** The System Activity app (`incident/system_app.js`)
  is a dashboard plus per-system views held as inert templates/JSON, each
  opened on click. Measured dashboard load: 0.9 s for 25 systems, 3.1 s
  for 108.
- **One-off runner** (`oneoff/`, `npm run report:*`). It writes to
  `sme_reports/out/` and sends email only when asked.
- **Internal/external marking** exists. But `incident/scrub.js` only
  removes Avante users from notification rows. **It does not cover CT
  raw material** (exam numbers, protocol names, source ids), contrary to
  §7. A customer-facing CT view needs its own scrub.
- **DB access** is the shared `utils/db/pg-pool` as `avantehs_admin`,
  read-write, with no read-only mode.
- **Work in progress:** 44 uncommitted paths on `DEV` (2026-11-04/05).
  They include the integration points a new report would normally touch:
  - `oneoff/{cli,config,args}.js` and `oneoff/jobs.config.json`;
  - `render/*`;
  - `incident/system_page.js`;
  - `index.js`, `periods.js`.

  `package.json` is not among them.
- **Checks:** Node 16, as on this box; headless Chromium checks
  (`dev/shoot.js`, `dev/check_system_pages.js`).

### 16.2 Design (agreed)

1. **One self-contained HTML file: "GE CT Insights — Internal".**
   - Built on demand with `npm run report:ct` (a script in the reports
     repo's `package.json`). It writes
     `sme_reports/out/Avante-GE-CT-Insights-Internal-<date>.html`.
   - It uses the System Activity app pattern: a dashboard, per-system
     views as inert JSON, and a way back to the list. Avante brand bar.
   - "Internal" appears in the title, header and file name.
   - Deterministic for a given as-of date.
   - Not emailed unless `--email` is passed, with recipients given on
     the command line. Not scheduled.
2. **New `sme_reports/ct/` directory** with its own CLI, data, model,
   render and client modules. It edits no in-progress file; the only
   shared change is one script line in `package.json`. It imports, and
   doesn't copy, the brand assets (`render/assets/`) and the HTML escape
   helper; `dev/check_ct.js` catches an import that a WIP change breaks.
   The CLI joins `oneoff/` later (Phase 7).
3. **Reads:**
   - the `api.ge_ct_*` views;
   - identity from `public.systems` / `sites` / `customers`;
   - the two migration 006 views (Q1).

   The builder uses its own connection with
   `default_transaction_read_only=on` (same credentials), so it can't
   write.
4. **The builder aggregates; the page only renders.**
   - Per-system compact daily series per metric.
   - Error codes as the top 10 plus "other".
   - Exams reduced to day-of-week × local-hour counts.

   The whole history is embedded, with a period selector (30d / 90d /
   6mo / all; default 90d, Q4). Budget: a file of 10 MB or less, and a
   dashboard ready in 2 s or less on the DEV VM.
5. **Fleet view.**
   - **Two groups.** *Reporting* means data in the last 7 device days,
     the window findings uses. *Not reporting* shows the last data date,
     and its findings are labelled "as of <date>" (Q5).
   - **Columns:**
     - system, model, customer / site;
     - last data;
     - exams/day;
     - mA·s/day;
     - current tube: mA·s since install, or "since data start <date>"
       for a tube that predates the data;
     - abort rate per 100 exams (28 d);
     - prep: share of scan days without Fast Cal (14 d);
     - open findings by severity;
     - clock flag.
   - **The same definitions as the rules.** Abort rate and prep take the
     `abort_rate_high` and `prep_noncompliance` computations (§14.2), so
     a column never contradicts a finding. Exams/day = exams per data day
     over the 30 device days ending on the system's last data day.
   - **Order:** highest open severity, ignoring `info`; then the number
     of open findings; then exams/day. The Not reporting group comes
     below.
   - **Footer:** "88 GE CT systems in inventory have no log data", with
     the list collapsed.
6. **System view.** A panel appears only when the system logs its metric
   (from capabilities):
   - **Header:** identity, last data, clock flag, current tube.
   - **Findings:** open first, then resolved. Each shows its evidence in
     readable form (thresholds, observed vs baseline, windows, top
     codes). The raw evidence JSON sits behind a toggle.
   - **Tube:** the mA·s counter over all history, with replacement
     markers and their confidence; mA·s/day.
   - **Utilization:** exams/day, series and images per exam, and a
     busy-hour heatmap (day of week × local hour).
   - **Reliability:**
     - aborts per 100 exams (operator / system);
     - errors by ermes code (top 10 plus other);
     - safe states;
     - boots (clean / unclean) and process restarts.
   - **Compliance:** a prep calendar (Fast Cal / tube warm), warm-ups
     skipped, scans in the warm-up zone, air calibration overdue, dose
     display disabled.
   - **Environment:** plenum and detector temperature, humidity, PSU.
   - **Rotor:** SGB slope and unexpected stops.
7. **Internal only in Phase 6.** The customer version moves to Phase 7,
   with delivery and scheduling. It needs a CT scrub (exam numbers,
   protocol names, any ids) and the `customer_visible` filter.

### 16.3 Questions and answers (2026-11-05)

1. **Contract gaps: AGREED, migration 006, views only.**
   - `api.ge_ct_days_v`: system, device day, the local-midnight instant,
     first and last fact time.
   - `api.ge_ct_capabilities_v`: system, metric, first/last seen, n,
     catalog labels.

   It adds no table, no grant, and nothing the stage reads. The user
   applies it through the §10 runner, like 001–005. The frontend will
   need both views too.

   Not chosen:
   - the viewer reads `insight.*` directly (bypasses the contract);
   - drop the heatmap and infer capabilities from `ge_ct_daily_v` rows.
2. **Where to build, given the in-progress reports work: AGREED,
   `sme_reports/ct/` plus one `package.json` line, committed on reports
   `DEV` with only those paths staged.** Join `oneoff/` once the WIP
   lands.

   Not chosen: wait for the WIP to be committed first.
3. **Delivery: AGREED, an on-demand file, no email, no schedule in
   Phase 6.** The user shares the file with the team.

   Not chosen: an internal email job now.
4. **Period: AGREED, embed the whole history, with a 30d / 90d / 6mo /
   all selector, default 90d.**

   Not chosen: a fixed 30 days like the magnet reports. It's too short
   for tube wear and the 28-day rules.
5. **Systems not reporting: AGREED, a separate group below the
   reporting systems, with findings shown as of their last data.**

   Not chosen: mixed into the attention order, or hidden.
6. **Review set: AGREED (asked again at step 6, 2026-11-05).**
   - **Systems:** the fleet view plus SME21859 (rotor, high), SME18531
     (restart loop) and SME21867 (chronic aborts). These are the §14.4
     named problems, with known expected findings. They are also
     `ct/verify.js`'s default panel set (`--systems`).
   - **Reviewer:** the user, for now. A wider team review waits until the
     user shares the file. Feedback is recorded here; anything about
     scanner behaviour goes to the Phase 7 field-service list.

   Not chosen: three systems picked by customer; the fleet view only; the
   three plus a quiet system; adding Remote Solutions or field service
   now.

### 16.4 Exit criteria (agreed)

- **`dev/check_ct.js`** (no DB; the page is built from fixtures):
  - the build is deterministic;
  - headless Chromium reports zero page errors;
  - nothing scrolls sideways at 390 px, on the dashboard or any system
    view;
  - "Internal" appears in the title, header and file name;
  - panels are hidden where the capability is absent.
- **A real build** is 10 MB or less. The dashboard is ready in 2 s or
  less, and the largest system view in 2 s or less, on the DEV VM.
- **Numbers are verified, not eyeballed.** A read-only `ct/verify.js`
  recomputes, with independent SQL:
  - every fleet column for all 34 systems;
  - every panel total for the 3 verification systems (Q6).

  There are zero differences. The abort-rate and prep columns equal the
  rule's values on the days a finding trips.
- **Migration 006** (if agreed) passes the runner's pre-checks, dry run
  and roundtrip, and is applied by the user.
- **Team review** of the fleet view and the systems chosen at Q6, with
  feedback recorded here. Feedback on scanner behaviour goes to the Phase 7
  field-service list rather than blocking Phase 6.

### 16.5 Build order (agreed)

1. Migration 006 and its tests; dry run and roundtrip; the user applies
   it (if Q1 is agreed).
2. `ct/data.js` (read-only queries) and `ct/model.js` (pure: fleet rows,
   series, heatmap), with tests on fixtures taken from prod.
3. `ct/verify.js` (independent SQL), run against prod read-only.
4. Render and client (fleet, system view, panels), and
   `dev/check_ct.js`.
5. A real build; measure size and timing; Codex review handoff.
6. Settle Q6, team review, then fixes, then a plan status update.

**Checkpoints for the user's go-ahead:**
- agreement on this section;
- before migration 006 is applied;
- after step 3 (numbers verified);
- after the step 5 review;
- before any commit, in either repo.

### 16.6 Effect on Phase 7

Phase 7 gains:
- the customer version (a CT scrub plus `customer_visible`);
- delivery and scheduling (a one-off email job, or the planned
  `alert.sme_reports` table);
- joining `oneoff/` after the reports WIP lands.

The frontend handoff note also covers the 006 views.

Ground rules carried over:
- During Phase 5 monitoring, don't change the `hhm_rpp_ge` pipeline
  (`insight/` stage code, `index.js`).
- Read-only DB, apart from migration 006, which the user applies.
- Don't edit the in-progress files in the reports repo.
- `/home/prod/hhm_rpp_ge` stays untouched.

### 16.7 Handoff: where the Phase 6 implementation starts

State at 2026-11-05 ~15:30 UTC:
- **Phase 5 is in its monitoring window.** The 7 clean days end
  2026-11-11 19:48 UTC. The 0-drift window restarted at the deploy of
  `b09674e` (2026-11-05 13:00 UTC), so it ends 2026-11-12 13:00 UTC.
  Phase 6 must not change the pipeline (`insight/` stage code,
  `index.js`) during the window.
- **Prod:** migrations 001–005 applied; 34 systems, 113 findings. The
  stage runs every 30 min (:18/:48 UTC) and holds the advisory lock while
  it runs. Viewer reads don't take that lock.
- **hhm_rpp_ge:** branch `dev`. `b09674e` is pushed; this plan update is
  committed locally.
- **reports repo** (`~/hep3/reports`): branch `DEV` at `2e060cb`, with 44
  uncommitted in-progress paths (§16.1). Never stage, edit or revert
  them. Stage only `sme_reports/ct/**`, `sme_reports/dev/check_ct.js` and
  the `package.json` script line.

Start with §16.5 step 1, migration 006:
- `migrations/006_*.sql` and its `.down.sql`, in the style of 004/005;
- view definitions only, built on the same day definition as findings
  `DAYS_SQL`;
- run `migrations/run.js scan`, then dry run and roundtrip. The user
  applies it.

Then steps 2–6. Reuse the Phase 3–5 patterns:
- pure cores with tests;
- read-only probes against prod;
- independent-SQL verification;
- a Codex review handoff (`REVIEW-PHASE6-*-HANDOFF.md`) per step;
- ask before every commit; push or promote only when the user asks.

Ground rules carried over:
- prod DB only, and read-only, apart from migration 006, which the user
  applies with the §10 runner;
- the viewer reads as `avantehs_admin` on its own connection with
  `default_transaction_read_only=on`;
- don't open or print any `.env`;
- don't touch `/home/prod/hhm_rpp_ge`, `alert.*` or `fse_dispatch`;
- don't ask the user to judge scanner behaviour. Reviews are evidence
  with a recommendation; field service confirms in Phase 7.
