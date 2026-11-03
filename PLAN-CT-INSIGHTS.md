# Plan — GE CT insights: metrics, findings, and an internal viewer

Drafted 2026-11-03. Goal: turn `log.ge_ct_gesys` (raw GE CT gesys log
records) into customer-meaningful data — utilization, tube wear,
reliability, operator compliance, environment — plus **findings** that
call out systems needing attention. Backend first, built to be the
contract the frontend team consumes after the server migration. Until
then, an internal HTML viewer reads the same contract.

Out of scope for v1: MRI and CV. The design keeps them in mind (shared
schema, rule registry per source), but nothing is built for them yet.

## Status (2026-11-03)

- **Phase 0 done.** Decisions in §9.
- **Phase 1 built, dry-run verified on prod, NOT applied.** Waiting for
  the go-ahead to run `--apply`. `migrations/run.js` (guarded runner,
  §10), `001_insight_schema.sql` (+down), and `002_api_views.sql` (+down,
  v0 placeholder views) are written. `node migrations/test/sqlscan.test.js`
  passes 8/8 (no DB needed). Verified against prod:
  - static scan ok on all 4 files
  - dry run of up 001→002: 166 in-scope objects created; all 2,892
    protected catalog fingerprints unchanged; the migration statements
    take no locks on protected relations; ROLLBACK; a fresh connection
    shows the catalog identical, so nothing persisted
  - `roundtrip` (up 001→002, then down 002→001, in one transaction): the
    catalog is restored exactly (2,892 objects, including `api`); rolled
    back

  To apply: `node migrations/run.js up --apply` (type `prod`, then
  `APPLY`).
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
  **Step 2 approved and implemented on `dev`, not yet deployed.**
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

  Cleanup (§11.6) is approved, keeping the 49 rows referenced by
  detections. It waits until the user confirms the fix is live in prod.
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
| SME18531 | Discovery MI | 37,666 `cupMonitor` "unexpected termination of device_eventlog … restarted": a process restart loop. Accounts for the 2026-08 row spike. |
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
versioned.

| Table | Grain / key | Purpose |
|---|---|---|
| `insight.metric_catalog` | `metric_key` | Label, unit, category (utilization / tube / reliability / compliance / environment / inventory), description, `customer_visible`, `rule_version`. Drives labels in every consumer. |
| `insight.ge_ct_facts` | one row per (log record × metric). Unique `(system_id, epoch, rnc, metric_key, host_datetime)`. Monthly partitions on `host_datetime` (same convention as `alert.detections`). | Extracted values: `value_num`, `value_text`, `exam_no`, `attrs jsonb` (e.g. kV/mA, sensor L/C/R), `source_id` → gesys `id`. Idempotent upsert = free dedupe + safe re-runs. |
| `insight.ge_ct_daily` | `(system_id, local_day, metric_key)` | n, sum, min, max, last. Day is **site-local** (`sites.time_zone_id`). Recomputed for touched days only. |
| `insight.ge_ct_exams` | `(system_id, exam_no, started_at)` | One row per exam: first/last activity, series, scans, images, aborts during exam. Basis for per-exam rates. |
| `insight.ge_ct_tube_segments` | `(system_id, segment_start)` | Tube lifetimes derived from the cumulative mA·s counter: start/latest mA·s, mA·s/day, readings, `ended_reason` (replacement). |
| `insight.system_capabilities` | `(system_id, metric_key)` | first_seen, last_seen, n. Separates **"this model doesn't log it"** from **"zero events"**. Required for the model-specific metrics. |
| `insight.findings` | `(system_id, finding_key, opened_at)` | status open/resolved, severity, window, observed vs baseline, `evidence jsonb` (fact ids, weekly series), `rule_version`, last_evaluated. |
| `insight.job_state` | `job_name` | Watermark (last processed gesys `id`), last run stats. Run logs go to `util.app_run_logs` like the rest of the app. |
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

Rule:
- **Primary signal:** counter drops to ~0 and later readings climb from
  low values. A single 0 that returns to the prior level is a glitch
  (seen 4× on SME21873).
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
  cli.js              # manual only: npm run ct_insight -- --backfill [--from-id N] [--system SME...]
  db.js               # pool + column sets (NOT under utils/)
  rules/ge_ct.js      # rule registry
  rules/__fixtures__/ # real message samples per rule
  extract.js          # stream gesys by id batches → match rules → upsert facts
  rollup_daily.js     # touched (system, local_day) → ge_ct_daily
  exams.js            # build ge_ct_exams
  tube.js             # counter → segments, replacement detection
  capabilities.js
  findings.js         # rule evaluation, open/resolve
  unmatched.js        # weekly template digest
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

Batch sizing: 50k gesys rows per batch ordered by `id`, upserts with
`ON CONFLICT DO NOTHING`. Each run reprocesses a small `id` overlap for
safety, which costs nothing because upserts are idempotent. Full backfill is ~3.1M rows,
expected minutes not hours; run it off-peak with a `statement_timeout`.

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
| **1. Schema** | `001`/`002` migrations, applied to **prod** through the §10 runner (pre-checks → dry run → explicit go) | Pre-checks pass ✅; dry run rolls back cleanly ✅; apply succeeds ⏳ (awaiting go); `down` script tested in a dry run ✅ (`roundtrip`) |
| **1b. Dedup root cause** | Find why records are re-ingested on a later capture (e.g. SME18531 epoch 1791178306 rnc 0 captured 10‑05 and again 10‑07; SME17371 30% dup). Likely the Redis file-size watermark vs. file rotation/truncation in `GE_CT_CV_MRI.js`. Fix in the parser; decide whether to clean existing duplicates in `log.ge_ct_gesys` (separate, reviewed step) | Repro explained ✅ (§11); new duplicates stop ⏳ (fix proposed §11.4, awaiting approval); cleanup decision recorded ⏳ |
| **2. Extract** | Rule registry + fixtures + `extract.js`; dry-run against prod (read-only reads, extract counts only, no writes), then `--apply` into `insight.*` | Rule tests pass; per-system fact counts reconcile with hand-run SQL from this investigation (±dedupe) |
| **3. Derive** | daily, exams, tube segments, capabilities | Replacements detected on SME16618 (installed 06‑02, confirmed), SME15218, SME21864 (~07‑15); SME21873's 0-glitches are not counted as swaps; exam counts sanity-checked with 2–3 sites; swaps spot-checked with field service, since there's no DB source of truth |
| **4. Findings** | rules + open/resolve | Flags SME21859, SME18531, SME21867; false-positive review across the fleet ≤ a handful |
| **5. Prod** | Apply migrations to prod; one-off backfill via `ct_insight -- --backfill` off-peak; deploy the `index.js` hook (no new cron line); run-log monitoring | 7 consecutive days of clean runs; watermark advancing; `ge_ct` run time up by seconds, not minutes; ingest unaffected with `INSIGHT_ENABLED=false` and `true` |
| **6. Viewer** | `sme_reports` CT report, internal | Team reviews fleet + 3 system views |
| **7. Validate & extend** | FSE review of findings (start with SME21859 rotor); threshold tuning; handoff notes: frontend (`api` views, after migration), `fse_dispatch` owner (`api.ge_ct_tube_v`), alert-engine owner (findings integration proposal) | Findings confirmed useful by field service; frontend has a stable contract |

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
- Write only to `insight.*`. The DB role/grants should enforce this
  where possible. Ask the DB owner whether an `insight_writer` role is
  feasible.
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

### 11.6 Cleanup: approved 2026-11-03 (keep the 49 detection-referenced rows); runs after the user confirms the fix is live

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
