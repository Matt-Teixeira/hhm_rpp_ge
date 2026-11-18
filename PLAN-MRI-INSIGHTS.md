# GE MRI Insights — plan

**Current state (2026-11-18; read this first):**
- **MRI-0 (decide): AGREED 2026-11-13.** The user took the
  recommendation in each of Q1–Q7 (§3) and the §2 design. The evidence
  (§1) is read-only and was gathered against prod on 2026-11-13. Nothing
  is built yet.
- **MRI-2a (code inventory): AGREED 2026-11-13** (the recommendation in
  each of Q-M1–Q-M10). §5 and `PLAN-MRI-INSIGHTS-CODES.md`: 361 codes
  above the cut, 22 named metrics + `mri.error`.
- **MRI-1 (migration 009): BUILT 2026-11-13, rehearsed on a local
  throwaway DB** (§6). **Codex review CLOSED 2026-11-13: no blocking
  defect** (`REVIEW-MRI1-SCHEMA-CODEX.md`, §6.6); 009 unchanged. Applied
  by the user after the CV-5 close-out (§6.5).
- **MRI-2 (extract): BUILT 2026-11-13, uncommitted** (§7): new files in
  `insight/mri/`. Prod dry run (read-only) equal to the independent SQL on
  every cell; write path rehearsed on the local DB. Committed 2eb7ea0.
  **Codex review 2026-11-13: two P2s, both fixed and re-rehearsed** (§7.6;
  `REVIEW-MRI2-EXTRACT-CODEX.md`); review closed (4345243).
- **MRI-3 (derive): BUILT 2026-11-13, uncommitted** (§8): daily, code
  labels, and derived queries (capabilities, inventory, sessions, deaths
  with a restart mark). Local rehearsal: every check equal; labels equal
  JS vs SQL on prod's PG 16 (read-only). Q-D1–Q-D5 AGREED 2026-11-13
  (§8.5). Committed b4522c8. **Codex review 2026-11-13: two P2s, fixed
  and re-rehearsed** (§8.6); labels now only for the 361 reviewed codes.
- **MRI-4a (findings groundwork): AGREED 2026-11-16** (the recommendation
  in each of F1–F12; §9): the series of every candidate, 11 proposed rules
  replayed on the local copy refreshed to 2026-11-16 (69 findings, 26
  open; 8 open on the 6 current systems), decisions F1–F12. The shared
  findings tables need no migration (§9.4).
- **MRI-4 (findings): BUILT 2026-11-16** (§9.7): new files in
  `insight/mri/findings/`. Local rehearsal: the §9.2 list exactly, every
  check 0; verify-findings PASS; CT / CV rows untouched. `--apply` is
  refused until C1-MRI. Committed 4b0b0a7. **Codex review CLOSED
  2026-11-16: one P2, withdrawn in round 2** (§9.8;
  `REVIEW-MRI4-FINDINGS-CODEX.md`): no code change, a regression test
  added.
- **C1-MRI (CT verifiers scoped to CT rows): BUILT 2026-11-16, uncommitted,
  in a worktree** (§10.5; branch `c1-mri-aware` from d563c75, outside the
  repo directory; the main checkout and prod unchanged). Tests and the
  local rehearsal pass. **Codex review CLOSED 2026-11-16, no findings**
  (`REVIEW-C1-MRI-CODEX.md`, §10.6). **Committed on `dev` 2026-11-18,
  after the CV-5 close-out** (§10.7): suites 343 / 343; the CT verifiers
  pass on prod with it. Deployed with the MRI push (§10.4).
- **MRI-5 (the stage, shared wrapper): AGREED 2026-11-16 (§11),** every
  §11.3 recommendation. **Step 1 BUILT 2026-11-16 (§11.6):** the shared
  `insight/stage_wrapper.js` (identical to the CT and CV wrappers in 24
  harness scenarios), `insight/mri/{index,stage}.js`, `stage --rehearse`;
  suites 340 / 340; local rehearsal and live path OK. **Codex review
  MRI5-STAGE CLOSED 2026-11-17** (§11.7): one P3 (an early rehearsal
  failure gave a TypeError), fixed with a regression test. **Step 2
  (the `index.js` hook) BUILT 2026-11-17, uncommitted, in a worktree**
  (§11.8; branch `mri5-hook` from 95797ea): the isolation test and the
  hook harness pass. **Codex review MRI5-HOOK CLOSED 2026-11-17, no
  findings** (§11.9). **Committed on `dev` 2026-11-18** after C1-MRI
  (end of §11.9): suites 344 / 344; the hook harness is identical to
  11-17.
- **MRI on prod: LIVE since 2026-11-18 16:43 UTC** (§11.10). Pushed at
  886c0e5; 009 applied; backfill, derive and findings applied (71
  findings, 28 open); the stage rehearsal OK; the user set
  `INSIGHT_MRI_ENABLED=true`. The first live run (`GE_MRI` 16:48) was
  clean: 162 rows, 13.7 s, the watermarks equal at the source max. The
  CT and CV stages and all nine verifiers pass. **Monitoring: 5 days,
  to 2026-11-23 16:48 UTC** (§11.4), then the close-out. Code 2227004
  (1 row) stays unreviewed until after the window.
- MRI-2's first prod write only after
  009, C1-MRI and C2-MRI (§7.5).
- **Found while building MRI-1 (§6.4): the CT verifiers are not
  MRI-safe.** They exclude `cv.*` rather than select CT keys, so the first
  `mri.*` catalog row on prod would fail them. A CT code change (C1-MRI),
  after the close-out and before MRI-2's first prod write.
- **Timing:** GE CV CV-5 closed out early on 2026-11-18
  (PLAN-CV-INSIGHTS.md §12.10). Until then, MRI work was limited to
  investigation, planning, and new files that nothing in the CT or CV
  run loads, as for CV during CT Phase 5. Migrations, shared `insight/`
  code and `index.js` were changed only after that close-out.
- **Collection gap (in parallel, another repo):** only 6 of the 46
  configured GE MRI systems send data today (§1.1). The diagnosis runs in
  a separate `hhm_data_acquisition` session. The prompt is
  `~/cv_d3b_evidence/mri/PROMPT-COLLECTION-GAPS.md`. It ends in that
  repo's `PLAN-COLLECTION-GAPS.md`.

Related plans: `PLAN-CT-INSIGHTS.md` (the architecture, the `insight`
schema, and the stage), `PLAN-CV-INSIGHTS.md` (the second modality,
which followed the same path).

Evidence scripts and logs (read-only) are in `~/cv_d3b_evidence/mri/`:
- **Probes:** `probe0.js`–`probe4.js` (`probe3.log`, `probe4.log`);
- **Coverage:** `coverage.js`;
- **Code inventory:** `codes.js` (`codes.json`, `codes.log`);
- **Run logs:** `runlogs_mri.js` (`runlogs_mri.log`).

The DB probes need the read-only admin session (`INSIGHT_PG_USER=` empty),
because `insight_writer` cannot read `log.*`.

## 1. What the data supports (verified against prod, read-only, 2026-11-13)

### 1.1 Coverage: 6 systems send data today

The table counts GE MRI systems with `run_group = 1`, by the age of their
last row in `log.ge_mri_gesys`:

| Configured | Current (≤ 2 d) | 2–30 d | > 30 d | Never (since data start 2026-04-27) |
|---|---|---|---|---|
| 46 | 6 | 2 | 9 | 29 |

- **Current:**
  - SME19647 (EXPLORER), SME21914 (Signa 1.5T), SME02582
    (SIGNAEXCITE1.5T);
  - SME21920 (Optima MR360), SME21932 (ECHOSPEED1.5T), SME21284 (SIGNA).
- **2–30 days:** SME16380 (SIGNA EXCITE 3T, last 11-09) and SME21824
  (MR450W, 10-23).
- **More than 30 days:** 9 systems, last rows between 05-11 and 08-11.
- **Never:** 29 systems.
- **The prod run logs agree.** Each `GE_MRI` run logs
  `getCurrentFileSize: File not present` 14 times (9,870 in 705 runs), so
  14 configured systems have no file on disk at all.
- **For comparison:** CV has 2 of 19 systems current, CT 28 of 75. The
  cause is upstream, in collection (see the current state above).
- **Each system joins as soon as its file arrives.** No code change is
  needed.

### 1.2 The source: `gesys_<host>.log`, the same format as CT

- **Ingest:** `jobs/MRI/gesys_parser.js` loads it into `log.ge_mri_gesys`,
  with the same `SR … EN` blocks, acquisition class (`GE_CT_CV_MRI`) and
  near-identical regex as CT. `config.log` holds one `gesys` file per
  system and nothing else.
- **Size:** 374,333 rows (329,480 after dedupe). Monthly partitions on
  `capture_datetime`. Ids run from 4,749,153 to 5,123,485.
- **Natural key `(system_id, epoch, record_number_concurrent)`, as in
  CT.** `epoch` is the device's local wall clock in seconds, not UTC. The
  latest row on every system has `to_timestamp(epoch)` equal to
  `host_date`/`host_time`.
- **`type` is `<host>\t<process>`, as in CT.** Processes, by rows:
  - `NSP` 146k, `scn` 96k;
  - `ifcc` 31k (3 systems, mostly one "Data Mining" error);
  - `autoview` 16k, `hostMonitor` 13k, `diagCoord` 13k, `cim`, `psc`,
    `LxMxConsumer`, `mrt_commentator`, `envMon`, `sdm`.
- **Mostly empty fields:**
  - `severity` is NULL or `Unknown` on every row;
  - `exception_class` is `Unknown` or NULL on 98%;
  - `misc_param_1` is always 1.

  So the class of a record comes from its code (`message_number`, 823
  distinct) and its process, not from these fields. That's the CV
  approach (a reviewed code mapping), not CT's exception classes.
- **Scan context: `psd` / `coil` / `scan` are filled on 139k rows
  (37%).** Pulse sequence, coil (`HNS Head` 37k, `8Ch Body FullFOV` 12k,
  `HD BodyFull` 10k, …) and scan. This supports coil and protocol usage.

### 1.3 Data quality

- **Duplicates:** 45k old duplicate rows on SME02582 (41,240),
  SME16342, SME16380 and SME21932. The last one was captured 2026-08-14,
  and there are none after the CT dedup fix (2026-11-03, shared
  acquisition class). The extract dedupes on the key, as CT and CV do.
- **No NULLs** in `host_datetime`, `epoch`, `type` or `message`.
- **Time zones:** 8 of 17 systems with rows have no `sites.time_zone_id`.
  The parser then defaults to `America/New_York`
  (`processing/generateDateTimes.js`).
  - **Lag (capture minus `host_datetime`, last 14 days):** typically 7–35
    min, which fits a :00/:30 collector and the :18/:48 parser.
  - **SME21284 is the exception (time zone NULL):** p50 75 min, minimum
    52 min. Either it is in Central time, with a clock about 8 min ahead,
    or it is in Eastern time, with a clock about 45 min behind.
  - **This doesn't affect day buckets,** which come from `epoch`, the
    device wall clock (as in CT). It only affects real-time comparisons,
    and none is proposed.

### 1.4 What the text supports (deduped, all history)

**The code inventory** (`codes.json`): 823 codes. 55 appear on 10 or
more systems, 335 on only one, and 297 were seen in the last 30 days. The
top 25 codes cover 70% of rows, the top 100 cover 91%, and the top 200
cover 97%.

| Area | Signal (code, process) | Coverage |
|---|---|---|
| **Utilization: scans** | `Scn: No of Successful Scan = N , No of Failed Scan = M` (2218650, `scn`) | 17 systems, 1,851 system-days. Last 90 days: 41,265 scans OK, 781 failed (1.9%) |
| **Utilization: exams** | `New Exam Started` (2218714, `scn`) | **14 of 17**. SME21284 logs scans but no exam starts, so this has to be gated by capability, as CT does |
| **Coil / protocol use** | the `psd`, `coil` and `scan` fields | 37% of rows |
| **Software start / stop** | `The System Software is starting` (200002347), `… has terminated` (200002348), `Signal 15 … system shutdown` (200002364), `msgView … initialized` (5600) | 16–17 systems |
| **Inventory** | `System Up. sw=DV25.1_R05_2131.a … fieldStrength=15000 … RFampType … gradientAmp …` (2227566, `mrt_commentator`) | 17 systems; the same code also carries license and config lines |
| **TPS resets** (system electronics reset) | `Reset/Download TPS In progress / was successful` (2227557 / 2227555), `StartupCondition error … TPS reset failure` (2256925) | 15 systems |
| **Process deaths** | `dsserver died unexpectedly` (200002356), `Process X exited with status` (200002379), `terminated by unexpected signal` (200002381) | 9–17 systems |
| **Prescan / shim** | `Auto Prescan failed, <reason>` (2224666), `Autoshim results inconclusive` (2224708), `Unable to start prescan! Table not at scan plane` (2224727) | 16–17 systems |
| **Coil faults** | `Invalid coil connected` (2277604), `Not all connectors … connected` (2277563), coil-check packet failures (2223625) | 6–16 systems |
| **Cooling / environment** | HEC coolant temperature out of spec (2261733), BRM water-flow failure (2266425), HEC cryogen compressor flow too high / low (2261732 / 2261731), cooling cabinet low-power (2261661) | 1–4 systems, about 5k rows |
| **RF / gradient / driver** | `Driver Module Has Detected a Fault` (2252293), RF Amp serial-link failure (2254342), Power Monitor 85% (2257260), receiver / RRX / IRF3 module faults | 3–17 systems |
| **Patient table** | home switch moved (103453), table speed (103413), cradle oscillation (103466), table motion stopped (2224842) | 1–8 systems |
| **Service and PM** | GE-Service mode on / off (2218663 / 2218664, 2218702 / 2218703), PM overdue (2218671, 2218673), DART diagnostics (101200 / 101201) | 6–16 systems |
| **GE's own image-quality warning** | `This system has a failure that could significantly degrade Image Quality` (2218672) | 2 systems, 459 system-days |
| **Door sensor** | `Door sensor is not working` (2218716) | 9 systems |

**Probably noise, for the viewer only:**
- `Low signal detected …` (2224725), 55k rows on all systems, an
  operator prompt;
- PURE / ASSET calibration-volume prompts;
- `Caution, Investigational Device`;
- `Data Mining: IFCC failed …` (20k rows, 3 systems);
- `message key 0 was not found`;
- the 1-Wire sensor-discovery notifications.

The code mapping (§2, MRI-2) decides each code with evidence, as CV did.

**Not in this log:** helium level, magnet status, quench and cold head.
No row mentions them. The only cryogen signal is the HEC compressor
flow (2 systems). Magnet health would need another file from the
scanner, which is a question for collection (§3 Q7).

### 1.5 The ingest run (prod run logs, 2026-10-30 → 11-13, read-only)

- **705 `GE_MRI` runs,** at :18 / :48 UTC: the same minutes as `GE_CT`
  and `GE_CV`.
- **Ingest:** p50 18.4 s, p90 28.5 s, max 45.6 s. Most of the time goes
  to file checks and `gzip_n_save` for 46 configured systems.
- **Rows per run:** p50 6, p90 82, p99 194, max 344. 418 runs had rows.
- **0 ERROR events.** The only WARNs are the 14 missing files and "no new
  data".
- **The incremental stage is small,** as for CV (a few seconds). That
  gets measured for MRI-5.

### 1.6 Existing consumers

- `alert.models` has no GE MRI rule (it has Philips MRI only).
- The parser upserts `alert.offline_hhm_conn` (reporting freshness);
  nothing changes there.
- No `insight` or `api` object reads `log.ge_mri_gesys`.

## 2. Proposed design

The CV path, on CT's architecture:
- **Read by id watermark.** Dedupe on the natural key, and use device
  wall-clock days.
- **Write as `insight_writer`,** in one tx per system.
- **Rehearse before every apply.** The user applies migrations.

- **A new module, `insight/mri/`.**
  - It is new files, like `insight/cv/`. CT and CV code don't require it,
    and an isolation test checks that.
  - Shared tables: `metric_catalog`, `finding_catalog`, `findings`,
    `job_state`.
  - MRI's own keys use the prefix `mri.` (metrics) and `mri_` (findings).
    Its job names are `ge_mri_extract`, `ge_mri_derive` and
    `ge_mri_findings`. **Correction (2026-11-13, §6.4):** the CV verifiers
    select `cv.*` and ignore MRI rows, but the three CT verifiers only
    *exclude* `cv.*` / `cv_`, so MRI rows would fail them (C1-MRI).
- **Facts: `insight.ge_mri_facts`,** one row per (record × metric). Key
  `(system_id, epoch, rnc, metric_key)`, monthly partitions as CT. The
  rules come from a reviewed code mapping, plus regex extractors for the
  numbers:
  - scans OK / failed per series;
  - the prescan failure reason;
  - the coil;
  - `sw` and `fieldStrength` from `System Up`.
- **Derive:**
  - `insight.ge_mri_daily` (system, device day, metric): n and sum;
  - capabilities, so that "doesn't log it" is not the same as "zero".
    **Not in `system_capabilities`** (corrected 2026-11-13, §6.4): CT's
    derive verifier counts every row there as CT. Computed from
    `ge_mri_facts`, as CV's capabilities view;
  - software sessions (start → terminate), TPS resets, service-mode
    sessions;
  - inventory (latest `sw`, field strength, gradient / RF amp type).
- **Findings v1** (thresholds come from a replay over the history, as CV
  §10; candidates only, not decided):

  | Candidate | Rule (draft) |
  |---|---|
  | `mri_failed_scans_high` | failed-scan share well above the system's own baseline |
  | `mri_cooling_fault` | HEC, water-flow or compressor-flow alarms |
  | `mri_tps_reset_failures` | TPS reset failures |
  | `mri_process_crash_loop` | a process dying repeatedly |
  | `mri_prescan_failures` | prescan failures well above baseline |
  | `mri_coil_fault` | coil faults on several days |
  | `mri_image_quality_warning` | GE's own warning (2218672) |
  | `mri_pm_overdue` | GE's PM-overdue message (info) |
  | `mri_table_fault` | patient-table faults |
  | `mri_error_storm` | as CV |
- **Stage (MRI-5): `run_mri_insight`** after the `GE_MRI` ingest. Its own
  kill switch `INSIGHT_MRI_ENABLED`, its own lock `insight_ge_mri`, never
  failing the run.
  - **This is the third stage, so the copied wrapper becomes one shared
    helper** (PLAN-CV-INSIGHTS.md §12.3 Q2 said to do it then). That is a
    shared change, with CT and CV stage rehearsals and verifiers.
- **Viewer (MRI-6):** "GE MRI Insights — Internal" in `sme_reports`, as
  CT and CV.

## 3. Questions for the user (AGREED 2026-11-13: the recommendation in each)

1. **Build now on 6–8 systems, or wait for collection? Recommended:
   build now,** as for CV. The collection diagnosis runs in parallel in
   the other repo, and each system joins when its file arrives.
2. **Module: a new `insight/mri/`, or generalize CT's code to take a
   modality? Recommended: a new module.** It copies the CT/CV patterns
   but leaves CT's closed-out code alone. The only shared change is the
   stage wrapper at MRI-5 (§2). Not chosen: generalizing now, which
   would reopen the CT stage and its rehearsals for little gain.
3. **Classification: a reviewed code mapping (CV style), not exception
   classes (CT style)? Recommended: code mapping.** `severity` and
   `exception_class` are empty here (§1.2). There are 823 codes. I'd map
   every code on 3 or more systems or with 100 or more rows (roughly the
   top 200, 97% of rows) with evidence, and leave the long tail as
   `mri.error` with the raw code. A `PLAN-MRI-INSIGHTS-CODES.md`, as for
   CV.
4. **Metric scope v1: the §1.4 areas without the noise list.
   Recommended:**
   - utilization: scans OK / failed, exams where logged, coil use;
   - reliability: software sessions, TPS resets, process deaths,
     prescan / shim;
   - hardware: coil, cooling, RF / gradient / driver, table;
   - service: service mode, PM overdue, DART;
   - inventory: `sw`, field strength.

   Noise codes stay countable in `mri.error` but get no metric and no
   finding.
5. **Time: device wall clock from `epoch` for days. Recommended: yes**
   (as CT). The 8 missing site time zones and SME21284's offset (§1.3)
   then don't matter for v1. List SME21284 for field service (time zone
   vs. clock) and don't fix it in code.
6. **The 45k old duplicate rows: leave them in `log.ge_mri_gesys`.
   Recommended: leave them.** The extract dedupes on the key, and
   `log.*` is not ours to change. Not chosen: a CT-style cleanup, which
   needs a reviewed delete on a log table for no gain in the insight
   output.
7. **Magnet health (helium, cold head, quench) is not in `gesys`.
   Recommended: out of scope for v1.** Add it as a question to the
   collection plan: does the GE MR host keep a magnet-monitor log we
   could collect? Keep the HEC cryogen-compressor flow alarms as the
   only cryogen signal in v1.

## 4. Proposed phases (exit criteria in the CV style; each phase planned in detail when it starts)

| Phase | Content | Exit | Earliest |
|---|---|---|---|
| **MRI-0 Decide** ✅ 2026-11-13 | this section, §3 answered | the user's answers recorded | done |
| **MRI-2a Code inventory** ✅ 2026-11-13 (§5) | `PLAN-MRI-INSIGHTS-CODES.md`: every code above the §3 Q3 cut, with category, metric and evidence (read-only) | the mapping agreed | now (read-only) |
| **MRI-1 Schema** (built 2026-11-13, §6) | migration 009: `ge_mri_facts`, `ge_mri_daily`, catalog rows, new objects only | tests, a local rehearsal, a Codex review (closed 2026-11-13, no blocking defect), applied by the user | built now, applied after the CV-5 close-out |
| **MRI-2 Extract** | `insight/mri/` rules + extract + backfill CLI (dry run, rehearse, apply), as CV-2 | dry run equals independent SQL per system × metric; review closed | built 2026-11-13 (§7); written to prod after 009, C1-MRI, C2-MRI |
| **MRI-3 Derive** | daily, capabilities, sessions, inventory; `verify_derive` | verifiers pass; review closed | built 2026-11-13 (§8); prod after MRI-2's backfill |
| **MRI-4 Findings** | replay the history, propose rules with evidence, agree, build, `verify-findings` | replay drift 0; review closed | after MRI-3 |
| **MRI-5 Stage** (LIVE 2026-11-18, §11.10) | `run_mri_insight` after `GE_MRI`, shared wrapper, `INSIGHT_MRI_ENABLED` | as CV §12.4: 5 days clean (§11.4), CT and CV unchanged | window to 2026-11-23 16:48 UTC |
| **MRI-6 Viewer** | "GE MRI Insights — Internal" report | as CT §16.4 | after MRI-5, or after CV-6 |

**Build order now (within the freeze):**
1. ~~Your answers to §3.~~ Done 2026-11-13.
2. MRI-2a, the code inventory: read-only, for your review. Drafted
   2026-11-13 (§5).
3. Migration 009 and the `insight/mri/` extract as new files, with tests
   and a local rehearsal on the throwaway DB.
4. Apply after 2026-11-19, after the CV-5 close-out.

## 5. MRI-2a: code inventory and proposed mapping (2026-11-13, read-only)

**Evidence:**
- All 374,333 rows of `log.ge_mri_gesys` (329,480 after dedupe on the
  natural key), 17 systems, ids up to 5,123,485.
- Only the code, the process, the message, `epoch`, `host_datetime` and
  counts of `coil` / `psd` / `scan` were read.
- The per-code tables (all 823 codes) are in `PLAN-MRI-INSIGHTS-CODES.md`.
  The probe scripts, the draft classifier (`mapping.js`) and the
  generator are in `~/cv_d3b_evidence/mri/mri2a/`, outside the repos.

### 5.1 What the inventory shows

- **The cut is 361 codes, not about 200.** The agreed rule (§3 Q3) has two
  conditions: 187 codes have 100 or more rows, and 311 appear on 3 or more
  systems (many with a handful of rows each). Together: 361 codes, 323,698
  rows (98.2%). Each one has a category and, where proposed, a metric. The
  other 462 codes (5,782 rows) are the long tail (codes doc §7).
- **By category** (codes above the cut): noise 90 codes / 161,021 rows
  (half of all rows); reliability 117 / 61,208; hardware 117 / 39,177;
  utilization 4 / 38,183; service 31 / 19,943; inventory 2 / 4,166.
- **The exam summary is the reliable utilization signal.**
  - `Scn: No of Successful Scan = N , No of Failed Scan = M` (2218650) is
    one row per exam, on all 17 systems. The regex matches 18,428 of
    18,428 rows: 166,540 scans OK, 3,665 failed (2.2%), 663 exams with
    0 / 0.
  - `New Exam Started` (2218714) is on 14 systems. SME02524, SME21284 and
    SME21922 log summaries but no starts. On SME01096, SME12152 and
    SME16380 there are about twice as many starts as summaries; on the
    other 11 the counts are within about 2% on 9 (SME21920 310 vs 321,
    SME16617 35 vs 38). 99% of starts have a summary within
    6 h.
- **The `coil` / `psd` / `scan` columns describe the scan in progress,
  not a use count.** They are filled on 116,125 rows, all NSP messages
  logged during a scan; 0 of the 18,428 exam summaries carry them, and
  45% are the 'Low signal' prompt. `scan` is numeric only (`#/#`); `psd`
  and `coil` are sequence and coil names (144 coils).
- **22 companion codes are the same event as a counted one** (codes doc
  §3), e.g.:
  - 5600 'msgView initialized' with every software start (1,303 / 1,303
    within 5 min);
  - 2277562 / 2277563 / 2277605, the second line of 'Invalid coil
    connected' (100% within 10 s);
  - 2224580 'Signal was too small' with the prescan failure of the same
    reason (356 / 372 within 10 s);
  - 2218702 / 2218703, the coil-ID line of service mode on / off (100%);
  - 2252293 'Driver Module Has Detected a Fault', a header whose detail
    line (coil bias, TR, PSU) is counted (426 / 443);
  - 2244570 'Y axis gradient amplifier failed to go to Ready', which
    follows a GP fault (245 / 248 within 1 min).
- **Process deaths are mostly shutdown.**
  - 'Process X exited with status=N' (200002379): 5,008 of 5,413 within
    10 min of a software stop, 327 of a start.
  - 'dsserver died unexpectedly' (200002356): on all 17 systems, about
    once per software session; 819 of 1,256 near a stop, 173 near a start.
  - 'terminated by unexpected signal' (200002381): `diagCoord`, `envMon`,
    `DHI` and `app` (3 systems) are killed at shutdown (184 of 185 each);
    `autoview` (173) is not.
  - 'unexpected death … caused it to be restarted' (200002354: autoview,
    RtpHost, irm, AUTOVOICE): 12% near a stop or start, so real crashes.
- **TPS resets are clean.** Every 'Reset/Download TPS In progress'
  (2227557) is followed within 30 min by 'successful' (2227555) or 'not
  successful' (2227556): 585 / 590. 'StartupCondition error … TPS reset
  failure' (2256925) is near a logged failure in only 103 of 175 rows (86
  rows on SME21824).
- **Receiver-chain faults come in bursts** (IRF / RRX / VRF / clock /
  fibre): 10 of the 12 counted codes have ≥ 97% of their rows within
  2 min of another receiver-chain code (2267432: 76%, 2267637: 72%), and 50–100% within
  15 min of a TPS reset or start. Read them by episode or day, not by row.
- **Inventory: `System Up` (2227566) gives one software version per
  system** over the whole history (11 versions). The field strength is
  1.5 T on 16 systems and 3 T on SME16342 (Discovery MR750).
  **SME16380 is configured as "SIGNA EXCITE 3T" but logs
  `fieldStrength=15000` (1.5 T)** on all 148 System Up lines, with an
  `HDE15.0` (HDe) software line.
- **History before the data start.** The first capture read each
  device's whole log: SME02582 has 48,730 rows on device days from
  2025-05-02, SME21914 7,297 from 2025-12-09, SME19647 19. No row's
  device time is more than a day after its capture.
- **The natural key holds in today's data:** 329,480 keys, none with two
  different codes or messages. As in CT, `epoch` is the device wall clock,
  so it is not unique by construction (the DST fall-back hour); MRI-1
  takes that up (Q-M9).
- **Messages carry identifiers.** Host names, PACS AE titles, remote host
  names, MAC addresses and serials, and on 3 rows of code 0 free text
  typed by the operator. So no fact stores message text, and every label
  is a masked template (host, MAC / IP / serial, digits, dates, AE titles).
  A check of the generated codes doc found none of the 17 host names and
  none of the AE titles seen.

### 5.2 Proposed mapping

Per deduped source row:
1. **`mri.error`, always:** dim = the code; attrs `proc` (the second field
   of `type`), plus `coil` and `psd` when filled (Q-M3).
2. **Plus the named metrics its code lists,** matched on code + message.
   One row gives at most two (the exam summary gives `mri.scans_ok` and
   `mri.scans_failed`), so up to 3 facts per row.
3. **No ignore list.** Unlike CV's relays, no MRI row repeats another
   row; the dedupe on the key handles the old duplicate rows. Companion
   codes stay in `mri.error` and get no named fact.

**Totals:** 438,116 facts (329,480 `mri.error` + 108,636 named).

| Metric | Category | Codes | Rows | Dims | Systems (most of any code) | Value / dim |
|---|---|---|---|---|---|---|
| `mri.scans_ok` | utilization | 2218650 | 18,428 | 1 | 17 | value = scans OK in the exam (sum 166,540) |
| `mri.scans_failed` | utilization | 2218650 | 18,428 | 1 | 17 | value = scans failed in the exam (sum 3,665) |
| `mri.exam_started` | utilization | 2218714 | 18,223 | 1 | 14 | gated by capability |
| `mri.sw_start` | reliability | 200002347 | 1,323 | 1 | 17 | |
| `mri.sw_stop` | reliability | 200002348 | 1,120 | 1 | 16 | |
| `mri.tps_reset` | reliability | 2227557 | 590 | 1 | 15 | started |
| `mri.tps_reset_failed` | reliability | 2227556 | 37 | 1 | 9 | |
| `mri.process_death` | reliability | 5 | 1,289 | 29 | 12 | dim = process (Q-M2) |
| `mri.prescan_failed` | reliability | 3 | 2,389 | 17 | 17 | dim = reason (17 reviewed + `other`, 35 rows); attrs.mode auto / manual |
| `mri.autoshim_inconclusive` | reliability | 2224708 | 1,678 | 1 | 16 | |
| `mri.coil_invalid` | hardware | 2277604 | 3,610 | 5 | 8 | dim = not all connected / not compatible / … |
| `mri.coil_fault` | hardware | 8 | 1,687 | 7 | 9 | dim = bias open circuit, transmit, TR driver, coil ID, … |
| `mri.cooling_fault` | hardware | 8 | 11,299 | 8 | 4 | dim = BRM / cabinet water flow, HEC coolant temp, HEC cryo-compressor flow high / low, leak sensor, RF coil airflow, gradient coil temp |
| `mri.rf_amp_fault` | hardware | 6 | 281 | 5 | 7 | dim = fault, serial link broken, … |
| `mri.gradient_fault` | hardware | 13 | 1,027 | 11 | 7 | dim = SGA PSU faults, current distortion, overtemp, clock stop, … |
| `mri.receiver_fault` | hardware | 12 | 434 | 10 | 4 | dim = RRX / VRF / IRF clock / fibre |
| `mri.table_fault` | hardware | 14 | 11,766 | 10 | 8 | dim = home switch, speed, oscillation, clutch slip, no start, … |
| `mri.door_sensor_fault` | hardware | 2218716 | 1,332 | 1 | 9 | |
| `mri.service_mode` | service | 2 | 1,487 | 2 | 16 | dim = on / off |
| `mri.pm_overdue` | service | 2 | 4,333 | 2 | 8 | dim = scheduled / unscheduled |
| `mri.iq_warning` | service | 2218672 | 6,596 | 1 | 2 | GE's own image-quality warning |
| `mri.system_up` | inventory | 2227566 | 1,279 | 11 | 17 | dim = software version; value = field strength (T); attrs gradientAmp, RFampType, … |

Codes behind each metric, with dims and regexes: codes doc §1–§2.

### 5.3 Questions for the user (AGREED 2026-11-13: the recommendation in each)

- **Q-M1 Mapping: adopt §5.2** (`mri.error` + 22 named metrics, the
  companions in `mri.error` only). **Recommended.**
- **Q-M2 Process deaths and shutdown.** **Recommended:** leave out of
  `mri.process_death` the two shutdown signatures (dsserver 'died
  unexpectedly' and every 'exited with status' line; both stay in
  `mri.error`), and count the rest with dim = process. MRI-3 derive then
  marks deaths within ±10 min of a software stop or start, using the
  sessions it builds anyway, so the viewer and MRI-4 can tell a shutdown
  kill (`diagCoord`, `envMon`, `DHI`) from a crash. Not chosen: a list of
  process names to drop in the rules, which would encode one software
  version's shutdown order.
- **Q-M3 Coil use: no v1 metric.** The `coil` column is the scan context
  of a message, not a use count (§5.1). **Recommended:** keep `coil` and
  `psd` as attrs on every fact where filled, so coil faults and prompts can
  be cut by coil; revisit a use measure (e.g. coils seen per day) at MRI-3
  as a derived view. This narrows §3 Q4's "coil use".
- **Q-M4 Exams.** **Recommended:** the viewer's exam count = n of the exam
  summaries (`mri.scans_ok` n, all 17 systems). `mri.exam_started` stays,
  gated by capability, and the 2× starts on 3 systems is a data note,
  not a fault.
- **Q-M5 DART: no metric.** 'DART Start' (101200) is exactly one row per
  system-day on 5 systems, with no result line: a schedule marker.
  **Recommended:** `mri.error` only, service category. This narrows §3
  Q4's "DART".
- **Q-M6 Watch list out of v1** (codes doc §4: scan stopped by error,
  DICOM push failures, worklist failures, autoview bad image, TPS startup
  condition, DART, remote-service login, CAN network, SRI comms). They
  stay countable by code in `mri.error`; MRI-4 revisits them with the
  findings replay. **Recommended.**
- **Q-M7 The reviewed-code set.** **Recommended:** `codes_reviewed.js`
  lists all 823 codes seen up to id 5,123,485: the 361 above the cut one
  by one, the 462 below as a group (`mri.error` only). A code first seen
  later is still counted in `mri.error`, and verify lists it as
  unreviewed (as CV).
- **Q-M8 Code labels.** **Recommended:** add `insight.ge_mri_codes` to 009
  (one row per code: masked label, label share, process, n, systems,
  first / last), built by MRI-3 derive with the masking used here, as
  CV's `ge_cv_codes`. No raw message text anywhere in `insight`.
- **Q-M9 009 scope (affects MRI-1; answer now or at the MRI-1 checkpoint).**
  - **Fact key:** `(system_id, epoch, rnc, metric_key)` as you specified.
    It holds today, but as in CT it is not unique by construction (DST
    fall-back hour). **Recommended:** keep it (it is CT's key, and the
    dedupe uses it); verify reports any key that would hold two different
    records, as CV-2 does for its repeats. Not chosen: CV's source-row key
    `(source_id, source_capture_datetime, metric_key)`, which would keep
    the 45k old duplicate rows as separate facts.
  - **Catalog rows:** you listed them for 009, but 007 writes no rows: the
    `cv.*` rows come from the registry, upserted by the extract, and the
    migration tests pin "no row writes". **Recommended:** the same for
    MRI (the registry is the single source of truth, and the version gate
    stays in one place). If you want them in 009, a test pins 009's rows
    to the registry.
  - **`api` views:** the runner refuses `api.ge_mri_*` today, and widening
    its scope changes `migrations/lib`, which the freeze doesn't cover.
    **Recommended:** 009 creates `insight` objects only; the `api` views
    and the runner scope come with MRI-6 (the viewer), after the
    close-out.
- **Q-M10 Field service (a D4-style note, not code).** **Recommended:**
  add two items:
  - SME16380 configured as SIGNA EXCITE 3T, logging 1.5 T (asset data or
    scanner config?);
  - SME21284 time zone vs clock (§3 Q5).

**Checkpoint passed 2026-11-13:** the user took the recommendation in
each of Q-M1–Q-M10.

## 6. MRI-1 schema: migration 009 (built 2026-11-13, uncommitted)

**Files** (all new; nothing the CT or CV run loads):
- `migrations/009_mri_schema.sql`, `migrations/009_mri_schema.down.sql`;
- `migrations/test/m009.test.js`.

**Unchanged:** the runner and its scope (`migrations/lib`, `run.js`), and
001–008. Everything 009 creates is in `insight.*`, which the runner
already allows.

### 6.1 What 009 creates (new objects only)

| Object | What |
|---|---|
| `insight.ge_mri_facts` (+ id sequence, 2 indexes) | One row per (gesys record × metric). Holds:<br>• unique key `ge_mri_facts_natural_key (system_id, epoch, record_number_concurrent, metric_key, host_local)`: the CT natural key + metric. `host_local` is there only because a partitioned table's unique key must contain the partition column; a CHECK ties it to `epoch` (`host_local = 1970-01-01 + epoch s`), so the key is the 4-column natural key + metric;<br>• `host_local` (device wall clock), `host_datetime` (the parser's zone guess), `message_number`, `dim`, `value_num` / `value_text`, `attrs` (proc, coil, psd, rule detail; never message text);<br>• `source_id` + `source_capture_datetime` (the log row's primary key), `rule_version`;<br>• `CHECK (metric_key LIKE 'mri.%')`. |
| 44 monthly partitions `ge_mri_facts_2025_05` … `_2028_12` | **Partitioned by range on `host_local`**: device-day months, bounds without a zone. 2025-05 is the first device day in the data (§5.1). No default partition (as CT): a record outside the range is skipped and counted by the extract. `insight_writer` can't create partitions, so months after 2028-12 come by migration (as CT 003). |
| `insight.ge_mri_daily` | `(system_id, local_day, metric_key, dim)` → n (> 0), value sum / min / max / last, `first_at` / `last_at` (device wall clock; CHECK they fall on `local_day`). `mri.*` CHECK. |
| `insight.ge_mri_codes` | One row per message code: process, `category` (the six §5 groups; NULL = not yet reviewed), label (masked template) and its share, n, systems, first / last seen (device time). Q-M8. |
| Grants | `insight_writer`: DML on the three tables, USAGE / SELECT on the sequence. |

**Left out on purpose** (all agreed in §5.3 Q-M9):
- **No row writes:** the `mri.*` catalog rows come from the MRI registry,
  upserted by the extract, as CV.
- **No `api` views:** they come with the viewer (MRI-6), with the runner
  scope change.
- **No functions, no capabilities table** (§6.4).

**Catalog categories (for MRI-2).** `insight.metric_catalog.category`
allows only utilization / tube / reliability / compliance / environment /
inventory, so the registry maps the §5 groups:
- hardware → reliability, except `mri.cooling_fault` → environment;
- `mri.pm_overdue` → compliance, `mri.service_mode` → utilization,
  `mri.iq_warning` → reliability.

The six-way group stays in `ge_mri_codes.category`. Changing the shared
CHECK was not considered: that would be a CT table change.

### 6.2 Tests (no DB): `node --test migrations/test`, 29 of 29 pass

7 new in `m009.test.js`:
- 009 creates exactly its 51 objects:
  - no drop, no re-create;
  - the only ALTER is the sequence's OWNED BY;
  - grants and comments name only `insight.ge_mri_*`;
  - no CT, CV, `log`, `public`, `alert` or `api` name;
  - no row writes, no views or functions;
  - shared tables only as the FK target.
- The partitions are 44 contiguous months with zone-less bounds, and
  there is no default partition.
- Keys are pinned:
  - the natural key and the `epoch` tie;
  - `mri.%` on both tables, the daily day CHECK and the code categories;
  - no message-text column.
- The grants are exact, and the down file revokes exactly them.
- The down file drops exactly the three tables, in order, with no CASCADE.
- **001–008 are unchanged:** the files' sha256 equal the checksums in prod's
  `insight.schema_migrations` (read 2026-11-13); 009 is the only new
  version.
- **Runner scope unchanged:** `api.ge_mri_*` is still refused.

The CT and CV suites still pass (unchanged): `insight/test` (8 files),
`insight/cv/test` (4) and `test/` (6).

### 6.3 Rehearsal on a local throwaway database (2026-11-13)

**Setup:**
- PostgreSQL 14.11 (prod is 16.15) in the session scratchpad.
- Unix socket only, mode 0700, no TCP.
- Stub `api` / `log` / `alert` / `public` objects and the role
  `insight_writer`.
- The real runner, with the target given by environment variables. The
  prod DB was not touched by the runner.
- Logs: `<scratchpad>/m009/`.

**Runner:**
- 001–008 applied: protected objects unchanged, `+279 -0 ~0`.
- **`roundtrip`** (009 up then down, rolled back): no locks on protected
  relations; after up `+231 -0 ~0` (no existing object changed); down
  restored all 292 catalog objects exactly.
- **`up` dry run:** clean, `+231 -0 ~0`, nothing persisted.
- **`up --apply`:** clean; 9 migrations recorded with matching checksums.

**Behaviour, as `insight_writer`:**
- Inserts a fact; a second insert with the same natural key (a duplicate
  source row) adds 0.
- **Refused:**
  - a CT key (`tube.mas_total`) or a CV key (`cv.error`), in facts and in
    daily;
  - a `host_local` that doesn't match `epoch`;
  - a daily row whose times fall on another day;
  - an unknown code category;
  - device months before 2025-05 or after 2028-12 ("no partition").
- **Can't:** TRUNCATE, ALTER, DROP, create a partition, or read `api`.

**The agreed §5.2 mapping on real data:**
- All 374,355 `log.ge_mri_gesys` rows (ids to 5,123,507) were copied
  read-only into the local stub. The draft classifier then loaded them as
  `insight_writer`.
- **438,145 facts:** 59,007 facts from old duplicate source rows were
  deduped by the natural key. A second full pass inserted 0. Every fact
  passed the `epoch` CHECK with `host_local` computed in JS.
- 329,502 source records = 329,502 `mri.error` facts. `mri.error` per
  (system, code) equals a plain SQL count on 2,667 of 2,667 cells.
- Facts landed in 19 partitions (2025-05 → 2026-11). Size: 168 MB with
  indexes.
- A daily build as `insight_writer`: 69,882 rows whose n sum to all
  438,145 facts; every day CHECK held.
- No natural key holds two different records (0). Load time: 40 s per
  full pass.

### 6.4 Before MRI-2 can write on prod (found 2026-11-13; not part of 009)

- **C1-MRI: the CT verifiers count MRI rows as CT.** C1 (CV §7.4) scoped
  them by *excluding* CV, not by selecting CT:
  - `insight/verify_facts.js` `CATALOG_SQL`: `metric_key NOT LIKE 'cv.%'`;
  - `insight/derive/verify.js` `INVARIANTS_SQL`: the same;
  - `insight/findings/verify.js` `CATALOG_SQL`: `left(finding_key, 3) <> 'cv_'`.

  The first `mri.*` catalog row would fail the first two, and the first
  `mri_*` finding the third. The CT stage rehearsal gates on all three.
  **Proposed:** select CT keys explicitly (exclude `cv.` and `mri.`, or
  better, match the CT registry's prefixes), export `MRI_AWARE = true`,
  and make MRI's `backfill --apply` refuse until all three do (the CV
  interlock pattern). This is a CT code change, so after the CV-5 close-out,
  with its own review, the stage rehearsal and a deploy.

  The change also updates two tests that pin today's CV-only filters:
  `insight/test/cv_scope.test.js` (its in-memory catalog would add `mri.*`
  / `mri_` rows) and `insight/cv/test/cv.test.js` "C1: every CV catalog
  row is one the CT verifiers' filters leave out" (it matches the exact
  `NOT LIKE 'cv.%'` text). `insight/mri/test/mri.test.js` "C1-MRI
  interlock" pins that the CT verifiers are not MRI-aware yet; it flips in
  the same change.

  The CV verifiers already select `cv.*` and are MRI-safe.
  `insight/cv/stage.js`'s "CT unchanged" fingerprints exclude only `cv.`,
  so MRI rows count as "CT" there. They stay constant during a CV run,
  unless MRI writes at the same minute; the shared stage wrapper (MRI-5)
  takes that up.
- **C2-MRI: `insight_writer` can't read `log.ge_mri_gesys`** on prod
  (checked read-only 2026-11-13: false; true for the CT and CV tables). As
  CV's C2, it is a grant the user runs, before MRI-2's rehearse on prod.
- **Capabilities: not in `insight.system_capabilities`.** CT's
  `derive/verify.js` `check_capabilities` compares every row there with
  `ge_ct_facts`, so MRI rows would be "extra". The CT derive also deletes
  and rebuilds a system's rows (by `system_id` only, so it would not touch
  MRI systems, but the verifier still fails). **Proposed:** MRI-3 computes
  capabilities from `ge_mri_facts`, as CV's view, and gets an `api` view at
  MRI-6. §2 is corrected.

### 6.5 Applying 009 on prod (the user, after the CV-5 close-out)

After 2026-11-19 20:18 UTC (the Codex review is closed, §6.6), once 009
is committed. From the checkout whose `.env` targets prod:
```
node migrations/run.js status
node migrations/run.js roundtrip     # up + down, catalog identical, rolled back
node migrations/run.js up            # dry run: type the DB name
node migrations/run.js up --apply    # type the DB name, then APPLY
```

**What to expect:**
- 51 objects created, version 9 recorded.
- Protected objects unchanged; in-scope `+231 -0 ~0`. The count may differ
  slightly on PG 16; any `~` or `-` is a stop.
- The foreign keys briefly lock `insight.metric_catalog`. If a CT or CV
  stage run holds it, `lock_timeout` (5 s) aborts cleanly; rerun away
  from :18 / :48.

**After the apply** (I verify read-only):
- the three tables exist and are empty;
- the writer's grants are as above;
- `schema_migrations` has 9 rows;
- the CT and CV verifiers still pass. 009 writes no rows, so C1-MRI
  doesn't bite yet.

### 6.6 Codex review (closed 2026-11-13): `REVIEW-MRI1-SCHEMA-CODEX.md`

**No blocking schema or rollback defect; 009 unchanged.** Codex confirmed:
- 009 changes no existing object: its only references to shared objects
  are the two FKs to `metric_catalog`;
- the key is exactly the natural key + metric. The `host_local` CHECK is
  correct for integer-second `epoch`, negative values included;
- zone-less range partitions prune correctly on `host_local`. Having no
  default partition matches CT;
- the daily CHECK is safe for device-day rollups;
- the down file removes everything 009 creates;
- C1-MRI, C2-MRI and the capabilities rule are the complete list of
  shared-table interactions. The CT findings `api` view is already
  source-filtered by 008.

**Carried into later phases (adopted):**
- **The DST fold fails the run instead of only being reported** (stronger
  than Q-M9's "verify reports"). If one natural key maps to two different
  source records, the MRI-2 extract refuses `--apply`, and `verify` fails
  with the key and both source ids. The schema can keep only one of them.
  The source primary-key columns stay available to the check. 0 such keys
  exist today.
- **CV stage rehearsal (MRI-5):** `insight/cv/stage.js` puts future MRI
  shared rows in its "non-CV" fingerprint. They come from a
  repeatable-read snapshot, so this doesn't fail on its own. An MRI write
  at the same minute is for the shared stage wrapper to coordinate.
- **Partition horizon:** 2028-12 is a maintenance point. The extract
  counts records outside the partitions, and MRI-3's verify flags any. A
  migration adds months before 2028-06.

## 7. MRI-2 extract: `insight/mri/` (built 2026-11-13, uncommitted)

**Files** (all new; nothing in the CT or CV run loads them, pinned by the
isolation tests):
- `rules.js`: the agreed mapping (§5.2) as a registry: `mri.error` + the
  22 named metrics, each with `version`, catalog `category`, MRI `group`
  and its code → matcher map. `validate()` refuses a non-`mri.` key, a bad
  group, or a code in two metrics (except 2218650, the two scan counts).
- `codes_reviewed.js`: the 823 reviewed codes (Q-M7).
- `extract.js`: stream `log.ge_mri_gesys` by id (50k batches). `host_local`
  = 1970-01-01 + `epoch` (the 009 CHECK). Dedupe on the natural key: the
  first source row (lowest id) gives the facts, later copies are counted
  as duplicates. Unstorable rows are counted by reason (no system, key,
  code, `host_datetime`, or outside the partitions).
- `load.js`: the write path, modelled on `insight/cv/load.js`:
  - insight_writer only, advisory lock `insight_ge_mri`;
  - per batch, one transaction: the conflict check, the upsert on
    `ge_mri_facts_natural_key` (DO UPDATE only for a higher rule version;
    the key and the first source row are never changed), the
    `ge_mri_extract` watermark, and the touched device days in
    `ge_mri_derive.pending` for MRI-3;
  - late-commit re-read (rows below the watermark captured within 2 h of
    it whose record has no facts yet), as CT and CV;
  - preflight: not a superuser, schema ≥ 9, C2-MRI (schema USAGE, then
    SELECT on the source), and for `--apply` the C1-MRI interlock (each CT
    verifier exports `MRI_AWARE = true`); it warns when fewer than 18
    months of partitions are left.
- **The conflict rule (§6.6):** one key with two different records
  (md5 of code, type and message) is a conflict. Within a batch it is
  found in JS; against earlier batches through the facts' unique index and
  the source primary key. A conflict refuses the batch (nothing written,
  watermark unchanged, job status `error`) and fails `verify` and the dry
  run. A re-sent identical copy is a duplicate, not a conflict.
- `reconcile_sql.js`: the independent SQL, written from §5.2's definitions
  (not from `rules.js`): per (system, metric), `mri.error` per (system,
  code), the scan sums, coverage (counted + duplicates + unstorable =
  rows) and conflicts.
- `verify.js`: the exit check over the watermark range: all of the above
  equal, coverage, 0 conflicts, the `mri.*` catalog = the registry.
- `cli.js`: `dry-run` (read-only, no prompt), `backfill --rehearse`
  (asks for the DB name; one transaction, rolled back, with a second pass
  and verify), `backfill --apply` (DB name, then APPLY), `verify`
  (read-only).
- `tools/build_fixtures.js` + `__fixtures__/` (22 files, 281 samples):
  real rows of the 84 named codes, labelled by the independent SQL, with
  host names, system ids, MAC / IP addresses, serials, UDIs and AE titles
  masked; a sample is kept only if it classifies exactly as the unmasked
  row. Only the rule inputs are kept (code, `HOST\t<process>`, message,
  coil, psd).
- `test/mri.test.js`: 21 tests (no DB).

### 7.1 Tests

`node insight/mri/test/mri.test.js`: 21 of 21. Every other suite still
passes (272 tests in 22 files): CT 110, CV 71, migrations 29, parsers 41.

### 7.2 Prod dry run (read-only, 2026-11-13 19:23 UTC)

`INSIGHT_PG_USER= node insight/mri/cli.js dry-run`, 22 s; log in
`~/cv_d3b_evidence/mri/mri2/dry_run_prod.log`:

| | |
|---|---|
| source ids | 0 … 5,123,766 |
| rows | 374,614 = 329,761 records + 44,853 duplicates + 0 unstorable |
| facts | 438,469 |
| per (system, metric) | 303 cells, 0 differences |
| `mri.error` per (system, code) | 2,668 cells, 0 differences |
| scan sums (ok / failed) per system | 34 cells, 0 differences |
| natural-key conflicts | 0 (JS and SQL) |
| rule errors | 0 |
| codes | 823, 0 unreviewed |

Prod state, read-only: `insight_writer` has USAGE on `log` but no SELECT
on `log.ge_mri_gesys` (C2-MRI open); schema version 8 (009 not applied);
no `mri.*` catalog or `ge_mri_*` job rows.

### 7.3 Write path on the local throwaway DB (2026-11-13)

The real code (`run_extract`, `verify`, `dry_run`) through a harness on
the local socket (`db.js` needs SSL, which a socket doesn't offer).
374,355 copied prod rows, 009 applied. Logs and harness:
`~/cv_d3b_evidence/mri/mri2/`.
- **Refused:** without C2-MRI (also without schema USAGE), with a clear
  message; `--apply` with the real CT verifiers (C1-MRI not done), naming
  all three.
- **Rehearsal:** 438,145 facts, second pass 0, verify PASS on the
  uncommitted facts (303 + 2,667 + 34 cells equal, coverage, 0 conflicts,
  catalog 23 = 23), pending days for 17 systems; after the rollback 0
  facts, 0 catalog rows, 0 jobs. 131 s.
- **Apply** (C1-MRI simulated in memory in the harness only): 3 batches,
  verify PASS to the watermark; resumed to the end, verify PASS on all
  374,355 rows; a run with nothing new: 0.
- **Edge cases** (synthetic rows in the local copy):
  - a late commit below the watermark: re-read and stored;
  - a re-sent identical copy: counted as a duplicate, 0 facts written;
  - a different record on an existing key: the dry run reports it (JS and
    SQL) and fails; `--apply` refuses the batch, the watermark stays,
    status `error`;
  - after removing the synthetic rows: verify PASS, 438,145 facts.

### 7.4 Open points for the review

- ~~Facts are never deleted~~: fixed with review P2-2 (§7.6): a complete
  replay prunes facts the registry no longer produces.
- `stats.facts` counts facts sent, including no-op re-sends from earlier
  batches; `upserted` is what was written.
- The stage entry (`extract_step`) comes with MRI-5; `apply_range` is the
  lock-free core it will use, as CV's.

### 7.5 First prod write (after the CV-5 close-out; the user runs it)

In order: 009 applied (§6.5); the C2-MRI grant; C1-MRI (a CT change with
its own review and deploy); then
```
node insight/mri/cli.js backfill --rehearse     # DB name; rolled back
node insight/mri/cli.js backfill --apply        # DB name, then APPLY
node insight/mri/cli.js verify                  # read-only
```
Then the CT and CV verifiers, which must still pass with `mri.*` rows in
the catalog (that is what C1-MRI makes true).

### 7.6 Codex review (2026-11-13): `REVIEW-MRI2-EXTRACT-CODEX.md`

Codex confirmed the mapping fidelity (registry = §5.2, the independent SQL
covers the same metric / code set), the dedupe, per-batch atomicity, the
preflight, the rehearsal's catalog writes being rolled back, the fixture
masking, and the shared imports' lack of side effects. Two P2s, both
fixed:

- **P2-1: late conflicting rows bypassed the conflict check.** The late
  re-read took only rows whose natural key had no facts, so a late copy of
  a stored key (identical or different) was never looked at.
  **Fix:** `LATE_SQL` now takes rows in the window that are no fact's
  source row (by the source primary key), and all of them go through
  `check_conflicts`. A different record refuses the run; an identical copy
  counts as a known duplicate and writes nothing. The re-read moved inside
  `apply_range`'s error handling, so a late conflict records status
  `error` (watermark unchanged).
- **P2-2: verify could pass with stale facts after a version bump.**
  **Fix:** `verify` fails on any fact not at its metric's registry version
  (`rule_versions.stale`, with the fix "replay: `backfill --apply
  --from-id 0`"). A complete replay (from id 0, every batch, to the
  current end) ends by deleting facts still below their registry version,
  that is, facts the rule no longer produces, and records their days for
  derive.

**Re-checked:** tests 23 of 23 (2 new: the late-conflict path through
`apply_range` with status `error`, and stale versions / replay / prune).
On the local DB with the real code:
- a late conflicting copy below the watermark: refused, status `error`,
  watermark unchanged; made identical: a known duplicate, 0 written,
  verify PASS;
- `mri.system_up` bumped to version 2 in memory (same output): verify
  FAIL with 1,279 stale facts and the catalog mismatch; after a full
  replay: 1,279 upserted, 0 pruned, verify PASS;
- then `mri.door_sensor_fault` bumped to version 2 emitting nothing: the
  full replay pruned all 1,332 old facts (9 systems) and recorded their
  days for derive; 0 stale facts left. Verify's only differences were
  door-sensor against the unchanged independent SQL, as intended: a real
  rule change updates `reconcile_sql.js` in the same commit;
- the local DB was then reset and re-applied at version 1 (§7.3 state).

Logs: `~/cv_d3b_evidence/mri/mri2/13_*` … `18_*`.

## 8. MRI-3 derive (built 2026-11-13, uncommitted)

**Files** (new in `insight/mri/`, nothing in the CT or CV run loads them):
`labels.js`, `derive.js`, `derived_sql.js`, `verify_derive.js`,
`test/derive.test.js`. Changed MRI files: `codes_reviewed.js` (+ the
reviewed categories), `cli.js` (+ `derive`, `verify-derive`),
`test/mri.test.js` (one usage example).

### 8.1 What it builds

- **`insight.ge_mri_daily`** (as CV's `ge_cv_daily`): per system, device
  day, metric and dim: n, value sum / min / max / last, first / last
  device time. Scope: the days the extract recorded as pending (§7), or
  the whole system when more than 31 days or `--full`; one transaction per
  system that also clears its days and marks the codes as owed
  (`codes_pending`, as CV review CV3-DERIVE P2).
- **`insight.ge_mri_codes`**, rebuilt in full when owed: per message code
  of the `mri.error` facts: n, systems, first / last device time, the most
  common process, the **reviewed category** (`codes_reviewed.js`
  `CATEGORY_CODES`: the 361 codes above the MRI-2a cut, totals equal to
  `PLAN-MRI-INSIGHTS-CODES.md` §6, pinned by a test; NULL for the 462
  long-tail codes and for new codes), and the **label** = the most common
  masked template with its share, **only for the 361 reviewed codes**
  (§8.6 P2-2).
- **Labels** (`labels.js`): the MRI-2a masking in one function, with one
  change: **every host name seen in the source** is masked, not only the
  record's own (a message can name another system). ASCII first, 200
  characters, empty → no label.
- **Derived queries** (`derived_sql.js`), read-only SQL, **no tables**
  (Q-D2); MRI-4 uses them and MRI-6 turns them into `api` views:
  - capabilities per system × metric (first / last day, days, n), from
    `ge_mri_daily`;
  - inventory per system: the latest System Up (software version, field
    strength, hardware attrs), when that version was first seen, versions
    and field strengths seen;
  - software sessions: a start ended by a stop (`sw_stop` or its companion
    200002364), by the next start with no stop (`no_stop`), or `open`;
  - service-mode sessions: an 'on' (not preceded by 'on') to the next
    'off';
  - process deaths with `at_restart` (Q-D1).
- **Commands:** `cli.js derive --rehearse` (database name; one
  transaction, rolled back), `derive --apply [--full]` (name, then APPLY),
  `verify-derive` (read-only). Same lock as the extract.

### 8.2 The check (`verify_derive.js`)

| Check | Compares |
|---|---|
| A | daily per (system, device day, metric) with the independent source count (§7 conditions on the deduped records; **device day from `host_date`**, not `epoch`) |
| B | `mri.error` daily per (system, day, code) with the source |
| C | daily with a plain GROUP BY over the facts, every column, both directions |
| D | `ge_mri_codes`, every field, rebuilt from the source in SQL: the label masking rewritten as PostgreSQL regexes (not the JS function); first / last from `host_date` + `host_time`; ties smallest under `COLLATE "C"` |
| E | no label holds a host name, an IPv4 / MAC address or a system id |
| F | each derived query = an independent JS computation from the facts |

### 8.3 Evidence (local throwaway DB, the §7.3 facts; logs in `~/cv_d3b_evidence/mri/mri3/`)

| Step | Result |
|---|---|
| `derive --rehearse` | 69,882 daily rows, 823 codes (all labelled; 462 uncategorized = the long tail). Second pass identical; the last-7-days rebuild equals the full one. Verify: A 17,011 cells, B 52,917 cells, C both ways, D 823 codes, E 0 leaks in 823 labels, F capabilities 303 / inventory 17 / sw sessions 1,323 / service sessions 742 / deaths 1,289 rows, **all 0 differences**. Rolled back. 88 s. |
| `derive --apply` (pending from the extract: 13 systems "full", 4 by day) | 9 s; pending cleared; `verify-derive` PASS from a read-only session |
| again | nothing pending, nothing done |
| a synthetic record on a new device day with a new code → extract → derive | only that day pending; with the code rebuild made to fail: status `error`, `codes_pending` kept; the next run rebuilt the codes (a planted stale label replaced) and cleared it; the run after: nothing. The new code: label `Synthetic MRI-# test # at <ip>`, category NULL. Verify PASS |
| `derive --apply --full` | byte-identical to the pending path |
| cleanup, `--full`, verify | PASS; the daily fingerprint equals the rehearsal's |
| **prod, read-only (PG 16.15)**: D's SQL vs the JS derive over the same deduped source rows (ids ≤ 5,123,858) | **823 codes, 0 differences** (labels, shares, processes, categories, first / last). 23 s SQL, 7 s JS. |

Tests: `insight/mri/test/derive.test.js` 14 of 14; every suite 288 of 288.

### 8.4 What the derived queries show (local, all history)

- **Inventory:** one software version per system over the whole history
  (no upgrades seen); 16 systems at 1.5 T, SME16342 at 3 T (SME16380:
  1.5 T, the Q-M10 configuration question).
- **Software sessions:** 1,323 starts: 1,240 ended by a stop, 67 by a new
  start with no stop between (crash or power loss), 16 still open.
  Median session 618 min.
- **Service mode:** 742 sessions, 740 closed, median 3 min.
- **Deaths:** 823 of 1,289 at a restart (Q-D1).

### 8.5 Questions (AGREED 2026-11-13: the recommendation in each)

- **Q-D1 The restart mark (refines Q-M2).** Q-M2 planned "±10 min of a
  software stop or start". On the data that marks only 446 of 1,289 deaths:
  the shutdown kills (DHI, diagCoord, envMon die together in the same
  minute, 185 times) are mostly hours from any logged `sw_stop`, because
  the stop is often logged only as its companion 200002364 (1,252 rows vs
  1,120 `sw_stop`). **Recommended:** restart events = `sw_start`,
  `sw_stop`, System Up **and 200002364**, ±10 device minutes. Then 823 of
  1,289 are marked: DHI 185 of 186, diagCoord / envMon 184 of 185, WavDisp
  155 of 155, app 15 of 15; while the likely crashes stay unmarked
  (autoview 338 of 347, vre:dpserver 20 of 20, AUTOVOICE 10 of 10,
  vre:prescanserver 47 of 66). No change to the facts: the mark is
  computed.
- **Q-D2 Derived queries, not tables.** **Recommended:** capabilities,
  inventory, sessions and deaths stay read-only SQL until MRI-6 makes them
  `api` views (with the runner scope change agreed in Q-M9). They are small
  (all history in under 200 ms), always consistent with the facts, and need
  no migration now. Not chosen: a migration 010 with tables, which would
  need its own derive, verify and review for no gain at this size.
- **Q-D3 Long-tail category.** **Recommended:** `category` NULL for the
  462 long-tail codes and for new codes (009's comment: "NULL = not yet
  reviewed"; the long tail was reviewed as a group only, Q-M7). A later
  category pass fills them without a schema change.
- **Q-D4 Device clock (as CV K1).** **Recommended:** no clock table in
  v1. Days, sessions and the restart window are all in device time, and
  every comparison is within one system. The viewer labels times as
  device time. SME21284's time zone / clock (Q-M10) is for field service.
- **Q-D5 Labels mask every known host.** **Recommended** (already built):
  stricter than MRI-2a's own-host masking; the leak check (E) enforces it.
  Cost: a host name that is also an ordinary word (none today; names
  shorter than 3 characters are never masked) would be masked in labels.

### 8.6 Codex review (2026-11-13): `REVIEW-MRI3-DERIVE-CODEX.md`

Codex confirmed the daily rebuild and pending / `codes_pending` protocol,
device times, deterministic ties, the source-retention handling, the JS /
SQL label equivalence, that the derived queries match Q-D1–Q-D5, and that
derive writes only MRI rows. Two P2s, both fixed:

- **P2-1: check F compared sets, not row counts.** Two identical output
  rows on one side and one on the other passed. **Fix:** `same_rows`
  compares multisets (diffs = Σ |count_sql − count_js|); the deaths
  comparison includes `message_number`. Re-check: still 0 differences.
- **P2-2: labels for unreviewed codes could store unread text.** A new or
  long-tail code's label is its most common template, which nobody has
  read; operator free text or a site name could be stored. **Fix:**
  - **a label is stored only for the 361 reviewed (categorized) codes**,
    whose templates were read in MRI-2a; the long tail and new codes get
    `label` NULL until a review categorizes them;
  - check E extended: no digit (every digit run is masked, so a digit
    means a leak), no unmasked serial, no unmasked AE phrase, no label on
    an uncategorized code.

  **The extended check found three real leaks**, all fixed: AE titles in
  codes 11010, 11011, 600220200 and 600220203, where the title is framed
  by double spaces or a line break. `labels.js` ran the phrase masks before
  collapsing whitespace (MRI-2a's doc scrub ran on collapsed text, so the
  doc never showed them). **Fix:** whitespace is collapsed right after the
  line-break step, and the "… from / remote host" phrases skip ` | `
  separators; same in the SQL rewrite; `LABEL_VERSION` 2.

  A test in the MRI-3 commit (`derive.test.js`) used one of those real AE
  titles as a sample string. That commit had not been pushed; it was
  rewritten (16b91c8 → b4522c8, only that string changed) before this fix,
  so the title is in no pushed or reachable commit.

**Re-checked:** tests 288 of 288. Local: rehearsal all checks 0 (E: 0 of 8
leak kinds in 361 labels; 462 codes unlabelled = the long tail); `--full`
changed only the code rows; verify PASS. Prod, read-only (PG 16.15): SQL vs
JS 823 codes, 0 differences; the leak checks on the prod-built labels: 0,
including the three titles. Logs: `~/cv_d3b_evidence/mri/mri3/30_*` …
`37_*`.

## 9. MRI-4a: findings groundwork (2026-11-16, read-only on facts)

**Evidence:**
- The local throwaway DB (§6.3), refreshed read-only from prod on
  2026-11-16 14:08 UTC: 2,547 new `log.ge_mri_gesys` rows (ids to
  5,126,054; the 374,355 older rows matched prod's count). The committed
  extract and derive then ran on it: 441,043 facts, extract `verify` PASS;
  70,105 daily rows, `verify-derive` PASS (every check 0 differences).
- 17 systems, 1,919 data days, device days 2025-05-02 → 2026-11-16.
- Each candidate was replayed day by day with CT's own fold
  (`insight/findings/state.js` `step`, loaded read-only), as CV §10: a
  14-evaluated-day quiet period, severity never falls, at most one open
  finding per key. Inputs: `ge_mri_daily` and the MRI-3 derived queries
  (deaths with `at_restart`, software sessions). Nothing was written.
- Scripts and logs: `~/cv_d3b_evidence/mri/mri4/` (`copy_new.js`,
  `pull.js` → `data.json`, `series.js`, `deaths.js`, `sess.js`,
  `scans.js`, `storm.js`, `sim.js`; `sim_final.log` is the §9.2 list,
  `final.json` the same as data).

### 9.1 What the series show

Per system over its whole history; "active" = data days with ≥ 1 event.

| Candidate (input) | Systems that log it | Shape |
|---|---|---|
| **Failed-scan share** (exam summaries, `mri.scans_ok` / `_failed` sums) | 17 | 0.8–5.9% per system over the history. 7-day share (≥ 20 scans) p50 0.4–6.0%; peaks 9.7% (SME21284 08-06, 22 of 226), 25.5% (SME21920 07-28, 12 of 47), 10.2% (SME21914 09-11, 9 of 88). Max failed scans per day 5–20 |
| **Cooling** (`mri.cooling_fault`) | 7 | Three shapes. **Chronic:** SME21824 every data day (171 of 171; HEC coolant temp high 3,989, cryo-compressor flow high 745 / low 295; median 35 a day); SME21923 RF-coil airflow 43 of 44 days (~13 a day); SME16342 HEC cryo-compressor flow low 32 of 56 days (1–4 a day). **Bursts:** SME21920 BRM water flow 1,547 (05-19) and 3,210 (07-29), leak sensor 636 (09-02); SME16617 BRM 237 (05-07). **Singles:** SME16380, SME19647 (≤ 4 a day) |
| **TPS reset failures** (2227556 'not successful' + 2256925 'StartupCondition … TPS reset failure', a day with either) | 11 | Rare: 1–10 failure days per system. Clustered on SME21824 (06-18, 07-16/17, 07-25, 08-07/10, 08-21/22) and SME21920 (07-23/24/27). Resets started (2227557): 15 systems, up to 10 a day (SME16339) |
| **Process deaths not at a restart** (Q-D1: 466 of 1,289) | 10 | **SME21914 `autoview`: 332 deaths on 79 days, up to 14 in 24 h and 28 in 7 days.** Elsewhere small: SME02582 `vre:prescanserver` 42 over 18 months (≤ 3 a week), SME16380 `RtpHost` 10 on 04-28, SME21284 8 + 8 (≤ 2 a week) |
| **Prescan failures** (`mri.prescan_failed`, by reason) | 17 | Active on 1–150 days; median 1–5 on an active day. Bursts of 13–69 in a day with one reason: driver module error, IRF clock / fibre (SME16339), RF hub setup (SME16342), RF-coil air temperature (SME21824 07-15: 51), data acquisition error (SME21284), gradient not ready (SME21923). Chronic low 'try again' on SME21914 (340) |
| **Coil faults** (`mri.coil_fault`) | 16 | Mostly 'bias open circuit' at 1–10 a day. **SME19647: 166 of 199 days** (coil-ID comm 588, bias transmit 124); SME02582 87 of 408; SME21824 51 of 171 (coil ID missing). No coil name on these rows (the `coil` attr is empty), so the coil itself can't be named |
| **Table faults** (`mri.table_fault`) | 16 | **Chronic:** SME19647 197 of 199 days (median 39, max 419: home switch moved 5,707, cradle oscillation 2,757); SME16342 53 of 56 (clutch slip, median 12); SME21284 133 of 140 at ~5 a day (unexpected motion). Episodes elsewhere (SME21914, SME21920, SME21923, SME02582) |
| **GE image-quality warning** (2218672) | 2 | **Every data day:** SME02582 390 of 408 since 2025-05-02 (median 15 a day), SME21922 70 of 77 |
| **PM overdue** (2218671 / 2218673) | 9 | Daily runs that end: SME21914 'scheduled' 04-06 → 06-18 then never again; SME21920 05-01 → 06-30. Still running at the last data day on 7 (SME21284 139 of 140 days) |
| **Error storm** (residual, §9.2 rule 10) | 17 | Residual p50 8–79 a day per system. Storm days are one code: SME21914 `autoview` 'bad format or corrupted image' (100055: 5,088 on 04-02, 1,401 on 11-14), SME21824 coil-config edge parameter (2220018: 1,142 on 09-30), SME19647 Z-gradient data overrange (2250082 / 2250420 / 2250421: ~790 on 07-28), SME21923 worklist network (600100013: 579 on 05-19), SME02582 diagnostics VxWorks error (2252700: 760 on 04-28) |
| **Unclean restarts** (software sessions ended by a new start with no stop) | 14 | 67 of 1,326 sessions; at most 4 in a week (SME02582 2025-05-12/13, its first captured days; SME21824 07-17 ×3 + 07-20; SME19647 06-02 ×3) |
| **Service-mode sessions** | 16 | 745 sessions; median 1–7 min and p90 ≤ 10 min on 14 of the 16 (SME21284 and SME21922 longer). The long ones are not sessions: SME16380 1,507 h and SME21284 793 h have no 'off' for weeks; SME21922 three of 25–67 h |

**Episodes cross candidates.** SME21920 07-23 → 07-30 has TPS failures,
the failed-scan peak, driver-module prescan failures, an SGA power-supply
overcurrent burst and the 3,210 BRM water-flow alarms. SME21284 08-05 →
08-10 has the failed-scan peak, data-acquisition prescan failures and
56 bias-open-circuit coil faults. As in CV §10.2, each is a different
subsystem's evidence of one event; linking them is a viewer concern.

### 9.2 Proposed rules (replayed)

Windows are device days (7 d = D−6..D, 28 d = D−27..D). "Days" are data
days (days with any MRI fact). A baseline is the median of the data days
in D−28..D−1 and needs ≥ 7 of them (CV). Quiet period: 14 evaluated days
for every rule. Keys `mri_`.

| # | Finding key | Rule | Severity | Replay (as of each system's last data day) |
|---|---|---|---|---|
| 1 | `mri_failed_scans_high` | 7-day failed share ≥ 5% and ≥ 3× the baseline share, with ≥ 10 failed scans in the 7 days. Baseline = failed / all scans pooled over D−34..D−7 (the 4 weeks before the window), needs ≥ 100 scans | medium | 3: SME21284 08-06 → 08-31, SME21920 07-24 → 08-19, SME21922 08-05 → open |
| 2 | `mri_cooling_fault` | cooling alarms on ≥ 3 data days of 7, or ≥ 50 on one day | **high** with a burst day or any HEC cryo-compressor alarm in the 7 days, else medium | 7, 4 open: SME21824 05-01 → open (high, HEC), SME16342 05-28 → open (high, cryo flow low), SME21923 05-05 → open (medium, RF-coil airflow), SME16617 05-07 → open (high, BRM burst); SME21920 three bursts (high), all resolved |
| 3 | `mri_tps_reset_failures` | ≥ 2 data days in 7 with a TPS reset failure (2227556 or 2256925) | high with ≥ 4 such days in 28 | 5, 0 open: SME21824 07-17 → 08-07 and 08-10 → 09-11 (high), SME21920 07-24 → 08-21, SME16342 05-02 → 05-22, SME21914 09-08 → 09-29 |
| 4 | `mri_process_crash_loop` | one process dies ≥ 5 times in 7 days, counting only deaths not at a restart (Q-D1) | high with ≥ 20 in 7 | 3: **SME21914 `autoview` 2026-02-09 → open (high)** and 2025-12-16 → 2026-01-29; SME16380 `RtpHost` 04-28 → 05-29 |
| 5 | `mri_prescan_failures` | a day with ≥ 15 prescan failures (operator reasons left out: stop / pause button, operator request, door open, table not at scan plane) and ≥ 5× max(baseline, 1), in the last 7 | medium | 6, 2 open: **SME02582 11-11 → open** (driver module error 23–27 a day); SME16339, SME16342, SME21284, SME21824 resolved; SME21923 open (stopped sending 06-30) |
| 6 | `mri_coil_fault` | coil faults on ≥ 4 data days of 7 | high with ≥ 14 such days in 28 | 13 on 6 systems, 3 open: **SME19647 05-05 → open (high, coil-ID comm)**, SME21824 09-18 → open (high), SME16339 08-03 → open |
| 7 | `mri_table_fault` | **spike:** a day ≥ 10 and ≥ 5× max(baseline, 1) in the last 7; **persistent:** ≥ 10 on ≥ 5 data days of 7 | medium | 10 on 6 systems, 4 open: **SME19647 05-06 → open** (persistent), **SME21914 11-09 → open** (spike), SME16342 and SME21923 open (stopped sending) |
| 8 | `mri_image_quality_warning` | GE's warning (2218672) on ≥ 2 data days of 7 | medium | 2, both open since their first data days: SME02582 2025-05-05, SME21922 2026-05-04 |
| 9 | `mri_pm_overdue` | GE's PM-overdue message on ≥ 3 data days of 7 | low | 9, 7 open: SME21914 04-08 → 07-11 and SME21920 05-07 → 07-28 resolved (the message stopped); SME21284 open; 6 on systems that stopped sending |
| 10 | `mri_error_storm` | a storm day: residual ≥ 300 and ≥ 10× max(baseline, 1), as CV. Trips with a storm day in the last 7 | high with ≥ 3 storm days in 28 | 8 on 5 systems, 2 open: SME21914 ×4, every storm day the `autoview` bad-image code 100055 (2 high; **the latest 11-14 → open**), SME21824 09-30 → open, SME19647 07-27 → 08-17, SME21923 05-18 → 06-12, SME02582 04-28 → 05-21 |
| 11 | `mri_unclean_restarts` (new) | ≥ 3 software sessions ended by a new start with no stop, in 7 days, counted on the day of that new start | low | 3, 0 open: SME02582 2025-05-12, SME19647 06-02, SME21824 07-17 |

**Total:** 69 findings, 26 open. **On the 6 current systems, 8 open:**
- SME02582: image-quality warning (since its first data days), prescan
  failures (11-11);
- SME19647: coil faults (high), table faults (persistent);
- SME21284: PM overdue;
- SME21914: process crash loop (`autoview`, high), error storm (11-14,
  the same `autoview` bad-image code), table faults (11-09);
- SME21920, SME21932: none.

The other 18 open findings are on the 11 systems that stopped sending; they
stay open at their `data_through`, as CT's do (§9.4).

**Rule 10's residual** = the `mri.error` rows whose code is reliability,
hardware or not yet reviewed (`ge_mri_codes.category` NULL), minus:
- every code of a metric that has its own finding (rules 2–9: cooling,
  TPS failed + 2256925, process death, prescan, coil fault, table, IQ,
  PM);
- the restart signatures (200002347 / 200002348 start and stop, 200002364
  the stop companion, 200002379 'exited with status', 5600 msgView).

Noise, utilization, service and inventory codes never count. It is defined
by code, so it is exact from `ge_mri_daily` (`mri.error`, dim = code)
whatever the number of named facts per row (CV's note on its residual
doesn't apply). New codes count until reviewed. RF-amp, gradient and
receiver faults have no rule of their own and land here (SME19647's
gradient overrange storm).

**Rule 4's restart mark, as of D.** Q-D1 marks a death at a restart when a
restart event is within ±10 device minutes. A death at 23:55 can be marked
by a restart at 00:05 the next day. To keep a day's result a function of
the data up to that day (CT review F2), the rule counts a restart event
only if its device day is ≤ D. The replay above used the full mark; the
build uses the cut, and `verify-findings` checks it.

**Sensitivity** (counts of findings / open; `sim.js` with env overrides):

| Change | Effect |
|---|---|
| prescan floor 10 instead of 15 | 6 → 16 findings: ten single days of 10–14 driver-module errors with no other sign |
| prescan floor 20 | 6 → 4 (drops SME16342's RF-hub and SME21923) |
| prescan with operator reasons counted | unchanged at 15 |
| coil faults on ≥ 3 days instead of 4 | 13 → 22: SME02582's bias-open-circuit weeks (3 a week) |
| storm floor 200 / 500, factor 5 | 12 / 9 / 8; 300 and 10× as CV |
| failed share factor 2, or ≥ 5 failed scans | 5 / 8 findings: small-number weeks (e.g. 9 of 88) |
| TPS failure on 1 day instead of 2 | 5 → 22: every isolated failed reset |
| unclean restarts ≥ 2 instead of 3 | 3 → 11 |
| cooling on ≥ 2 days, or a burst of 20 | 8 / 7 |
| table spike floor 20 | 10 → 6 |
| IQ on ≥ 1 day, PM on ≥ 1 day | unchanged |

**Coverage and history (the 6 of 17, and SME02582):**
- **The thresholds come from 17 systems' history, but only 6 send today
  (§1.1).** 11 of the 17 stopped between 05-11 and 11-09, so most of the
  1,919 system-days are from May–August. Every rule is per system
  (absolute counts or the system's own baseline), so none depends on how
  many systems send. A re-tune is due when more systems join (MRI-6
  review, or 3 months of data from the new ones).
- **A joining system:** the baseline rules (1, 5, 7 spike, 10) can't trip
  until it has 7 data days in 28 (rule 1: 100 scans in the 4 weeks before
  the window). The count rules (2, 3, 4, 6, 7 persistent, 8, 9, 11) can
  trip from its first days. A system whose first capture reads the whole
  device log (SME02582, SME21914) gets its history's findings at its first
  run, opened on device days before it joined.
- **SME02582's history from 2025-05-02** comes from one read of the
  device's log at capture start. Its baselines exist from 2025-05, and 7
  of its 9 findings opened before 2026-04-27. A finding opened in its first
  data days (the IQ warning, 2025-05-05) means "present since the data
  starts", not an onset. The viewer shows each system's first data day
  next to `opened_at`; no extra field.
- **Capabilities ("doesn't log it" is not zero, Q-M4).** No rule infers a
  fault from an absence: each trips only on logged events, and rule 1 needs
  ≥ 100 summarized scans in its baseline. Exam starts (the Q-M4 metric
  missing on SME21284) feed no rule. What absence does do is resolve: a
  finding resolves after 14 evaluated days without a trip, and an
  evaluated day is any data day. The viewer shows capabilities next to
  findings, so a system that never logs, say, cooling is not read as
  "no cooling faults".

### 9.3 Not findings in v1 (data only, shown in the viewer)

- **Long service-mode sessions.** Sessions are minutes; the long ones are
  missing 'off' lines, not service work (§9.1). A rule would report
  logging gaps.
- **Invalid coil connected** (`mri.coil_invalid`): handling, chronic on 4
  systems (SME21824 'not compatible' 163 of 171 days). Coil-database
  errors stay countable by code.
- **Door sensor not working** (2218716): every day on SME01096 and SME12152
  (both stopped sending in June), sparse elsewhere. Whether it means a
  failed sensor or a door left open is for field service (F7 below).
- **RF-amp, gradient and receiver faults, autoshim inconclusive:** no rule
  of their own; their bursts come with TPS resets (§5.1) and land in the
  storm residual.
- **Exam starts, service mode, DART, the Q-M6 watch list** (bad image,
  DICOM push, worklist): countable by code; the bad-image and worklist
  storms surface through rule 10.
- **Coil use** (Q-M3): still no measure.

### 9.4 Design (follows CV §10.4, CT §14.2 / §14.7)

- **Files:** all new, in `insight/mri/findings/`, loaded by nothing in the
  CT or CV run (the isolation test grows to cover them):
  - `context.js`: dense day series per system (the CV shape, so CT's fold
    runs unchanged);
  - `rules.js`: the 11 rules and the catalog rows (`mri_` keys,
    `customer_visible = false`, validation);
  - `load.js`: data days from `ge_mri_facts`; cells from `ge_mri_daily`
    (the named metrics, and `mri.error` by code for the residual and
    2256925); deaths and restart events with device times (for the as-of
    mark), software start / stop events (rule 11);
  - `run.js`: rehearse / apply / replay;
  - `verify_sql.js` / `verify.js`: independent SQL.
- **Source and names:** `source = 'ge_mri'`, keys `mri_*`, job
  `ge_mri_findings`, the `mri_*` rows of `insight.finding_catalog` synced
  from the registry (MRI's rows only). Categories: `mri_cooling_fault` →
  environment, `mri_pm_overdue` → compliance, the rest → reliability (as
  §6.1's metric mapping).
- **Device time:** windows on `host_local` days. `opened_at` / `resolved_at`
  = the instant of the device day's local midnight, from the facts
  (`host_datetime` − time of day of `host_local`); the offsets are whole
  hours on all 17 systems (checked 2026-11-16). No clock table (Q-D4).
- **As of each system's data-through date:** each system is evaluated as of
  its last data day ≤ today; data on later device days is ignored (deaths'
  restart marks included, §9.2).
- **The fold is CT's** `replay_system` (unchanged); the MRI wrapper sets
  `source = 'ge_mri'` and refuses a non-`mri_` key, as CV's `as_cv_rows`.
  It reuses CT's pure `reconcile` / `totals` / upsert from
  `findings/run.js` and `compare_findings`, as CV does. Nothing is loaded
  from `insight/cv/`.
- **Modes (as CV):** `--replay` makes the system's `ge_mri` rows exactly
  the replay; the default (incremental) run evaluates systems with data in
  the last 7 device days, never changes an older resolved row, and reports
  any disagreement as drift. One transaction per system; job state
  `ge_mri_findings` with `as_of_by_system`.
- **Rehearsal (as CV):** pass 1, pass 2 = 0 changes, a default pass after
  the replay = 0 changes and 0 drift, incremental (replay as of today−28,
  then default runs at −21, −14, −7, 0) identical to the replay,
  `verify-findings` inside the transaction, rollback.
- **Interlocks:** insight_writer only (no superuser); schema ≥ 9; derive
  caught up (a successful `ge_mri_derive` on record, no pending days, no
  owed codes, fact days = daily days); `--apply` refused until C1-MRI (the
  three CT verifiers export `MRI_AWARE`).

**Shared tables: no migration (confirmed 2026-11-16, read from the
migrations):**
- `insight.findings.source` has no CHECK (001); the PK
  `(system_id, finding_key, opened_at)` and the one-open index
  `(system_id, finding_key)` don't include `source`, but `mri_` keys can't
  collide with CT or CV keys;
- `insight.finding_catalog.finding_key` CHECK `^[a-z][a-z0-9_]*$` (005)
  accepts `mri_…`; `category` and severities fit (above);
- every CT and CV reader filters `source`: `api.ge_ct_systems_v` (002,
  004), `api.ge_ct_findings_v` (008), `api.ge_cv_findings_v` and the CV
  system summary (007); the CT and CV findings runs and verifiers read,
  write and delete their own source only;
- **except C1-MRI:** CT's `findings/verify.js` "catalog = registry" leaves
  out only `cv_` rows, so the first `mri_*` catalog row fails it (§6.4).
  CT's catalog sync only logs unknown keys, and its counts are log-only
  (CV §11.4).

### 9.5 Decisions (AGREED 2026-11-16: the recommendation in each)

- **F1 Rules:** adopt rules 1–11 with the §9.2 thresholds. **Recommended.**
- **F2 Storm residual by code category** (reliability + hardware +
  unreviewed, minus the finding codes and the restart signatures), not CV's
  "all minus named facts". **Recommended:** exact without CV's one-named-
  fact assumption, and noise / service / utilization never make a storm.
- **F3 Prescan:** leave the operator reasons out and use a floor of 15.
  **Recommended:** at 10 the rule adds ten single days with no other sign;
  the operator reasons don't change the list but don't belong in a fault
  count.
- **F4 Cooling severity:** high on a burst (≥ 50 in a day) or on any HEC
  cryo-compressor alarm (the only cryogen signal, §3 Q7), medium
  otherwise. **Recommended.** Alternative: medium for all, which would
  rank SME21824's daily HEC alarms with SME21923's RF-coil airflow.
- **F5 Image-quality warning: medium, not high.** It is GE's own wording
  ("could significantly degrade Image Quality"), but it is on every data
  day on both systems, so it is a standing state. **Recommended:** medium,
  permanently open on SME02582; field service confirms (F7).
- **F6 PM overdue: low, compliance** (§2 drafted info). **Recommended:** CT
  uses low for its compliance findings; info is for events
  (`tube_replaced`).
- **F7 Field-service note** (adds to Q-M10): SME02582's IQ warning (what
  failure, since when?), SME21824's daily HEC alarms, SME19647's coil-ID
  comm faults and table home-switch / oscillation, SME21914's `autoview`
  crashes and bad-image storms, and the door-sensor messages.
  **Recommended:** a note, not code (as CV's D4).
- **F8 Table: spike and persistent variants.** **Recommended:** without the
  persistent one, SME19647 (197 of 199 days) and SME16342 (clutch slip)
  get spikes only. Not chosen: a separate key, which splits one
  subsystem's evidence.
- **F9 Unclean restarts as rule 11 (low); long service mode as data only.**
  **Recommended** (§9.3).
- **F10 Stale systems:** keep CT's semantics. Findings on a system with no
  data in the last 7 device days keep their state; the viewer shows
  `data_through`. **Recommended.** Not chosen: resolving on staleness,
  which would read "stopped sending" as "fixed" (offline detection stays
  with `alert.offline_hhm_conn`).
- **F11 Internal only:** `customer_visible = false` for every MRI v1
  finding, as CV. **Recommended.**
- **F12 No shared code change:** reuse CT's pure findings pieces
  unchanged; nothing from `insight/cv/`. **Recommended** (as CV F6).

### 9.6 Proposed MRI-4 exit criteria

- **Locally (this phase):** the replay opens the §9.2 list on the local
  copy, any difference explained (the as-of restart cut, new data);
  pass 2 and a default run after the replay change nothing; the
  incremental runs equal the replay with 0 drift; `verify-findings`
  (`ge_mri`) equals the independent SQL at each system's as-of day; CT
  and CV rows and catalog rows untouched (synthetic `ge_ct` / `ge_cv`
  findings seeded locally); every suite passes; review closed.
- **On prod (after C1-MRI and MRI-2 / MRI-3 there; the user runs it):**
  `findings --rehearse --replay` gives the §9.2 list as of that day,
  differences explained by new data; every medium / high finding is
  explained by its codes and series; `--apply --replay`, then
  `verify-findings` PASS; the CT and CV verifiers and the CT viewer
  unchanged.

### 9.7 MRI-4 build (2026-11-16)

**Files** (new, apart from the MRI CLI and one MRI test line; nothing in
the CT or CV run loads them, pinned by the isolation tests):
- `insight/mri/findings/`:
  - `context.js`: pure. Dense day series per system (scan sums, cooling
    with its cryo kinds, TPS failures, prescan without the operator
    reasons, coil, table, IQ, PM, the rule 10 residual, unclean restarts)
    and the deaths per day and process with two counts: not at a restart
    by events on a day ≤ the death's day (used on the as-of day), and not
    at a restart at all (earlier days). Same shape as CT's context, so
    CT's fold runs on it. The residual's excluded codes come from the
    registry (48 codes), the restart window from `derived_sql.js`.
  - `rules.js`: the 11 rules of §9.2 (thresholds as agreed), the catalog
    rows, validation (`mri_` prefix, windowed only, internal, quiet 14).
  - `load.js`: data days (midnight and last instants) and restart events /
    deaths from `ge_mri_facts`, cells from `ge_mri_daily`. Read-only.
  - `run.js`: rehearse / apply / replay, from CV's (CT's `reconcile`,
    `totals`, upsert and fold, unchanged). `as_mri_rows` relabels to
    `ge_mri` and refuses any other key. Every read, write and delete is
    limited to `source = 'ge_mri'` / `mri_` catalog keys.
  - `verify_sql.js`: independent SQL from §9.2's definitions: categories
    from `ge_mri_codes`, the excluded codes and thresholds written out
    (a test pins them to the registry), the restart mark as a range join
    with the as-of cut, unclean restarts by `lag()`, CT's island method.
  - `verify.js`: inventory (fact days = daily days), findings = SQL field
    by field at each system's as-of date (CT's `compare_findings`), the
    `mri_*` catalog = registry, invariants, no `mri_` key under another
    source.
- `insight/mri/cli.js`: `findings --rehearse|--apply [--replay]
  [--system S]` (database name; `--apply` then APPLY) and
  `verify-findings` (read-only).
- `insight/mri/tools/build_findings_fixtures.js` and
  `__fixtures__/findings/`: all 17 systems as of 2026-11-16 (1.2 MB of
  compact arrays: device days and instants, codes, dims, counts, scan sums,
  event kinds and process names; `mri.error` cells only for the codes a
  rule reads), with the SQL's 69 findings.
- `insight/mri/test/findings.test.js`: 26 tests.
- `insight/mri/test/mri.test.js` "cli flags": the unknown-command case
  now uses an unknown command (`findings` exists).

**Interlocks (preflight):** insight_writer only, never a superuser; schema
≥ 9; a successful `ge_mri_derive` on record with nothing pending and no
owed codes; fact days = daily days; `--apply` needs C1-MRI (each CT
verifier exports `MRI_AWARE`).

**Tests:** findings 26: the registry; the SQL's thresholds and code lists
= the registry's; the residual by category (noise, service, utilization
and finding codes out; new codes in); scan sums, operator reasons, cryo;
unclean restarts in source order; the as-of restart mark (a 23:55 death
and a 00:05 start); every rule's boundaries; CT's fold (open, 14 evaluated
quiet days, resolve, reopen; times); **as-of purity on the real data**
(every rule, two cut days per system: 2,095 trip days equal); `as_mri_rows`;
the preflight refusals; prefix filters with no backslash and every write
scoped to `ge_mri`; loader / SQL read only MRI tables; isolation of the
requires; CLI; **the fixture: JS = the independent SQL on all 17 systems**,
invariants, no message text, IP or MAC in evidence; the fixture holds only
codes, dims, counts, process names and device times; the §9.2 list
(69 / 26, per key, the 8 open on the current systems, named episodes).
**Every suite: 314 of 314 in 24 files** (288 before + 26).

**Local evidence** (throwaway PG 14, the §9 copy; logs and harness in
`~/cv_d3b_evidence/mri/mri4/`, `20_*` … `24_*`):
- **JS vs SQL**, read-only, as of 2025-12-31, 2026-06-15, 08-10, 10-19 and
  11-16: equal at each (7 / 42 / 60 / 66 / 69 findings).
- **Synthetic `ge_ct` / `ge_cv` findings seeded** (4 rows, 2 on an MRI
  system id, with 3 catalog rows).
- **`findings --rehearse --replay`:** 69 findings, 26 open = §9.2; pass 2:
  0 changes; a default pass after the replay: 0 changes, 0 drift;
  incremental (replay as of 10-19, then default runs at 10-26, 11-02,
  11-09, 11-16): identical to the replay, 0 drift; CT / CV rows and catalog
  unchanged; `verify-findings` PASS inside the transaction; rolled back.
  28 s.
- **Refused:** `--apply` without C1-MRI (the real CT verifiers, naming all
  three); derive pending; code labels owed; derive status `error`; a fact
  day missing from `ge_mri_daily`; a superuser (whatever the environment
  names).
- **Apply** (`--replay`; C1-MRI simulated in memory in the harness only):
  69 inserted, one transaction per system; `verify-findings` from a
  read-only session PASS; a default re-run and a replay re-run: 0 changes,
  0 drift; `--system SME21914`: 0 changes; the seeded CT / CV findings and
  catalog rows byte-identical before and after.
- **Privacy:** none of the 17 source host names, and no IPv4, in the
  fixtures, the new code, this plan or the logs.

**Found while building:**
- **JIT compile time.** The first SQL marked restarts with two correlated
  EXISTS over a CTE; PostgreSQL's cost estimate (11.8 M) switched on JIT
  with optimization and inlining: 16.9 s of an 18.5 s query. As a range
  join the same query costs a fraction and runs in 3.8 s (JIT 1.4 s), with
  the same result. Worth knowing for prod's PG 16: a correlated subquery
  in a verifier can cost seconds of JIT alone.
- **The §9.2 count on the current systems was 8 open, not 9** (corrected
  above); the totals (69 / 26) were right.

**Prod order (the user runs it, after §7.5 and MRI-3 there):** C1-MRI
deployed (§10) → `node insight/mri/cli.js findings --rehearse --replay`
(expect `ok` and the §9.2 list, differences explained by new data) →
`findings --apply --replay` → `verify-findings` → the CT and CV verifiers.
Later runs use the default mode (the MRI-5 stage).

### 9.8 Codex review (closed 2026-11-16): `REVIEW-MRI4-FINDINGS-CODEX.md`

Codex confirmed rules 1–3 and 5–11 against the SQL (baselines, evidence,
severity, the fold), the residual's code categories and the pinned
exclusion list, rule 7's observed / baseline, every statement scoped to
`ge_mri` / `mri_`, CT's pieces reused and no CV code loaded, the preflight
refusals, the fixture's contents, and §9.2 / F1–F12 as built. One P2:

- **P2 (claimed): a next-day restart could suppress a historical
  crash-loop trip,** in both the JS and the SQL. The review reads `full`
  (a death not at a restart, by any event up to the run's `today`) as
  being used on the as-of day D, so a restart at 00:05 on D+1 would drop
  a 23:55 death from D's count.

  **Not reproduced.** `crashes(ctx, D)` uses `full` only for deaths on
  days *before* D; a death on D uses `strict` (events on a day ≤ D). A
  restart within ±10 minutes of a death is on the death's day or the
  next, so for a death before D every event that can mark it is on a day
  ≤ D. The SQL has the same split (`mark_any` for `dday < d`,
  `mark_early` for `dday = d`).
  - **Local DB, Codex's exact case** (one transaction per variant, rolled
    back; `~/cv_d3b_evidence/mri/mri4/p2_db.js`, `30_p2_db.log`):
    synthetic deaths on SME21932 at noon on 10-05 (×2), 10-06 and 10-07,
    and at 23:55 on 10-08; variant A adds a start at 00:05 on 10-09. As of
    10-08, 10-09 and 11-16, the 10-08 trip (5 deaths) is the same in both
    variants. Only 10-09 differs (A: no trip, because the start is that
    day's data; B: a trip), which is Q-D1 as agreed. JS = the independent
    SQL in all six cases. 0 synthetic rows left.
  - **In the real data no restart that marks a death is on a later
    device day** (1,390 matching pairs, all on the death's own day), so
    the real-data fixture couldn't show this either way.
  - **Regression test added** (the one the review proposed):
    `findings.test.js` "review MRI4-FINDINGS P2": day D's result is equal
    with and without the D+1 start, as of D, D+1 and later; D+1 sees the
    start; and day by day, `crashes()` as of every day equals what a run
    on that day computed, with deaths on both sides of midnight.
    **Mutation:** using `full` on the as-of day too (the bug the review
    describes) fails this test and the existing restart-mark test.
  - Tests: findings 27; every suite 315 of 315.

**No code change.** **Round 2 (Codex, 2026-11-16): P2 withdrawn.** Codex
re-checked against this section and the regression test: it had read
`full` as used for a death on the evaluated day; `crashes()` uses `strict`
there, and the SQL's `mark_early` / `mark_any` split follows the same rule.
No code change indicated; findings tests 27 of 27. **Review closed.**

## 10. C1-MRI: the CT verifiers scoped to CT catalog rows (planned and built 2026-11-16, uncommitted)

**Why:** C1 (PLAN-CV-INSIGHTS.md §11) scoped the three CT verifiers by
*excluding* `cv.*` / `cv_`. The first `mri.*` metric catalog row (the MRI-2
extract syncs 23) fails two of them, and the first `mri_*` finding catalog
row (MRI-4, 11) fails the third. The CT stage rehearsal gates on all three,
so this must be deployed before MRI-2's first prod write (§7.5). It is CT
code, so after the CV-5 close-out, with its own Codex review, the CT stage
rehearsal and a deploy, as C1 was.

### 10.1 The change (three CT files, the catalog statements only)

| File | Today | After |
|---|---|---|
| `insight/verify_facts.js` `CATALOG_SQL` | `WHERE metric_key NOT LIKE 'cv.%'` | `WHERE metric_key NOT LIKE 'cv.%' AND metric_key NOT LIKE 'mri.%'` |
| `insight/derive/verify.js` `INVARIANTS_SQL` (catalog subselect) | the same | the same addition |
| `insight/findings/verify.js` `CATALOG_SQL` | `WHERE left(finding_key, 3) <> 'cv_'` | `WHERE left(finding_key, 3) <> 'cv_' AND left(finding_key, 4) <> 'mri_'` |

- Each module also exports **`MRI_AWARE = true`**, with a comment pointing
  here; the MRI `backfill` and `findings` `--apply` interlocks read it
  (`insight/mri/load.js` `ct_verifiers_not_mri_aware`).
- No backslash in any literal (CV-C1 P2): `'mri.%'` has no `_`, and the
  finding filter is a plain prefix test.
- **No CT key starts with `mri`** (checked against both CT registries; a
  test pins it), so nothing CT is hidden.
- **Unchanged:** every other check, expected value and message.

**Recommended: extend the exclusion (above).** Not chosen: select CT keys
by the CT registry's prefixes (e.g. `split_part(metric_key, '.', 1) =
ANY(...)`). It would survive a fourth modality without a change, but it is
a larger change to closed-out CT code, and a new CT prefix would then need
the verifier edited as well. With the exclusion, a fourth modality repeats
this small change.

### 10.2 Tests updated in the same change

- `insight/test/cv_scope.test.js`: its fake catalog adds `mri.*` and
  `mri_*` rows (pass with and without them; a missing / extra / changed
  CT row still fails; `mrix.*` / `mrix_*` still count as CT). Its text
  checks accept the two-part filters. Renamed in spirit to "scope", the
  file name kept.
- `insight/cv/test/cv.test.js` "C1: every CV catalog row is one the CT
  verifiers' filters leave out": **unchanged** (built 2026-11-16): its text
  checks still hold on the two-part filters, so no file in `insight/cv/`
  changes. The real MRI registries are checked from the MRI side instead
  (`mri.test.js`, below).
- `insight/mri/test/mri.test.js` "C1-MRI interlock": now expects `[]` from
  the real modules; plus a new test: every real MRI catalog row (23 metric,
  11 finding) is one the CT filters leave out, and no CT row is.
- `insight/mri/test/findings.test.js` "preflight refusals": `--apply` now
  passes the interlock (the refusal stays covered by the `mri.test.js`
  cases with fake modules).
- `insight/mri/test/stage.test.js` "stage_preflight with the real extract
  preflight: refused until C1-MRI" (added with MRI-5, §11.6, after the
  worktree was cut): flips the same way. The worktree change is rebased
  onto `dev` before its commit.

### 10.3 Checks before the commit

- Every suite (314 today).
- **Local rehearsal** (throwaway PG 14, as CV §11.3): the CT catalogs
  seeded from CT's own statements next to the 23 `mri.*` / 11 `mri_*` rows
  (and the `cv` ones): the original modules FAIL, the changed ones PASS;
  a missing / extra CT row and a changed CT label still FAIL; real MRI
  `backfill` / `findings` preflight `--apply` passes.
- **Other CT code** (as CV §11.4, log-only, not changed): CT findings
  `sync_catalog` will list the `mri_*` keys as "not in the registry"; CT
  `COUNTS_SQL` totals and the stage's "fresh read" count include
  `ge_mri` rows. CV's `stage.js` "CT unchanged" fingerprints exclude only
  `cv`, so MRI rows count there; they are constant within a CV run
  unless MRI writes at the same minute, which the shared stage wrapper
  (MRI-5) coordinates.

### 10.4 Order (each step after the previous one; the user decides)

1. CV-5 close-out. 2. Push. 3. 009 (§6.5). 4. C2-MRI grant.
5. **C1-MRI:** build on a branch or worktree, review closed, commit on
   `dev`, the CT stage rehearsal on prod (`node insight/cli.js stage
   --rehearse`), push, the user pulls on prod.
6. MRI-2 backfill (§7.5), 7. MRI-3 derive, 8. MRI-4 findings (§9.7).

### 10.5 Build (2026-11-16, uncommitted)

**Where:** a scratch git worktree on branch `c1-mri-aware` (from `dev` at
d563c75) in the session scratchpad, outside the repo directory, as C1 was
built (CV §11). The main checkout, `index.js`, the CT and CV run, and prod
are unchanged; the freeze holds.

**The change** (`git diff` in the worktree, 6 files, +105 −38):
- the three CT statements of §10.1, each module exporting
  `MRI_AWARE = true` with a comment pointing here; nothing else in them
  changes except comments;
- the tests of §10.2:
  - `insight/test/cv_scope.test.js`: copies of the 23 / 11 MRI keys (CT
    code may not load `insight/mri`). MRI rows pass; a missing, extra or
    changed CT row next to them still fails; `mrix.*`, `mrix_unknown`,
    `mria` and `mri` count as CT; exactly two exclusions per statement;
    the C1-only statement would have counted the MRI rows;
  - `insight/mri/test/mri.test.js`: the interlock now expects `[]`, plus
    the real-registry test;
  - `insight/mri/test/findings.test.js`: preflight `--apply` passes.

**Tests:** every suite in the worktree: **316, 315 pass, 1 skipped** (CT
`stage.test.js` "F2 connect()", which needs a `.env`, and a worktree has
none; the same skip as C1). `cv_scope` 7, `mri` 24, findings 27.
**Mutations** (each fails ≥ 2 tests): either `mri.%` filter removed; the
findings filter removed; a 3-character prefix `'mri'`; `LIKE 'mri%'`
without the dot; `LIKE 'mri\_%'` (a backslash); `MRI_AWARE = false` on one
module.

**Local rehearsal** (throwaway PG 14, one transaction, rolled back;
`~/cv_d3b_evidence/mri/c1mri/c1mri_local.js`, `c1mri_local.log`). Original
modules = the main checkout; C1-MRI = the worktree; `insight/db.js` stubbed
for both. CT catalogs seeded with CT's own statements (39 metric, 13
finding rows) next to 23 `mri.*` / 11 `mri_*` (the real local rows) and 9
`cv.*` / 5 `cv_*`; 69 `ge_mri` findings present:

| Case | Original | C1-MRI |
|---|---|---|
| CV + MRI rows: `verify_facts` / derive invariants / findings catalog | FAIL ×3 (62 vs 39; 24 vs 13) | PASS ×3 (39 = 39; 13 = 13) |
| MRI rows only | FAIL ×3 | PASS ×3 |
| CT metric row missing / extra `mrix.not_mri` | – | both metric checks FAIL |
| CT finding label changed / extra `mrix_unknown`, `mria`, `mri` | – | findings catalog FAILS |
| No CV / MRI rows (correct, and with a missing CT row) | identical to C1-MRI | identical to original |
| `standard_conforming_strings` on / off | – | PASS, catches `mria`; MRI's own catalog statements 11 / 11 under both |
| `ct_verifiers_not_mri_aware()`; real MRI `backfill` and `findings` preflight `--apply` | all 3 named; both refused (C1-MRI) | `[]`; both pass |

After the rollback the local catalogs and findings are as before.

**Incident while recording this (2026-11-16, no effect):** the plan text
for this section was first passed through an unquoted shell heredoc, so
the shell ran each backticked phrase as a command. Among them were
`node insight/cli.js stage` and `node insight/cv/cli.js stage` (the
`--rehearse` flag was on the next line, so not passed), from the main
checkout, whose `.env` targets prod. Both stopped at argument parsing
("stage needs --rehearse" / "stage takes only --rehearse"): the CT CLI
throws that before `connect()`, and the CV CLI parses arguments before it
even loads `db.js`. So no database connection was opened and nothing was
written. The rest were not commands, or not executable (a `git diff` in
the main checkout ran, read-only); nothing from `.env` was printed. Plan
edits now use quoted heredocs only.

**Next (each step after the previous one; the user decides):**
1. Codex review (`REVIEW-C1-MRI-HANDOFF.md`): done, closed (§10.6).
2. After the CV-5 close-out: commit on `dev` (asking first); the worktree
   is removed once the change is there.
3. The CT stage rehearsal on prod (the user): `node insight/cli.js stage
   --rehearse`; then the CV stage rehearsal (`node insight/cv/cli.js stage
   --rehearse`, unchanged code, as a check).
4. Push, pull on prod; then §10.4 from step 6.

### 10.6 Codex review (closed 2026-11-16): `REVIEW-C1-MRI-CODEX.md`

**No findings; no change to the worktree.** Codex ran the four no-DB
suites in the worktree (`cv_scope` 7, `mri` 24, findings 27, `cv` 17, all
pass) and no CLI, migration runner or database command. Answers to the
five handoff questions:

1. **Filters:** `NOT LIKE 'mri.%'` (`.` literal) and
   `left(finding_key, 4) <> 'mri_'` drop exactly the MRI namespaces; `mri`,
   `mria` and `mrix_*` stay CT; no backslash dependency; no CT registry
   key starts `mri.`.
2. **Completeness:** the three statements are the only CT checks that
   gate on catalog contents. `findings/run.js` (extra catalog keys logged,
   aggregate counts), `load.js` and the stage's fresh read only report;
   CT findings reads and verification are scoped to `source = 'ge_ct'`.
   CV's stage "CT unchanged" fingerprint includes MRI rows on purpose: it
   detects changes during a CV stage run, not the presence of MRI rows.
   Concurrent MRI writes are MRI-5's shared lock.
3. **`cv_scope.test.js`:** its fake applies each exclusion as a conjunct,
   which models the two ANDed predicates; the copied keys and the
   real-registry test in `mri.test.js` complement each other.
4. **`cv.test.js` unchanged:** right; the CV suite keeps pinning CV
   behaviour without owning MRI's registry.
5. **Deploy order:** sound as in §10.5 "Next"; keep 009 and the C2-MRI
   grant in the §10.4 order; C1-MRI needs no schema change.

### 10.7 Committed on `dev` (2026-11-18, after the CV-5 close-out)

- The CV-5 close-out was done early on 2026-11-18 (CV plan §12.10;
  9753a86), which ended the freeze.
- **Applied to `dev` from the durable patches:**
  - `~/cv_d3b_evidence/mri/c1mri/c1-mri.patch`. It is byte-identical
    to the reviewed worktree diff (branch `c1-mri-aware`), apart from
    the `index` lines. None of its six files changed on `dev` since the
    worktree's base d563c75.
  - `c1-mri-stage-test-flip.patch`. In
    `insight/mri/test/stage.test.js`, the case "refused until C1-MRI"
    now expects the stage preflight to pass. The refusal itself stays
    covered by the `mri.test.js` "C1-MRI interlock" test (§11.6).
  - 7 files in total, +110 −40.
- **Every suite passes in the main checkout:** 343 of 343, none
  skipped (25 files).
- **The CT verifiers with this code, read-only against prod**
  (13:04–13:10 UTC, no MRI rows yet):
  - `verify`: 624 cells equal, catalog 39.
  - `verify-derive` and `verify-findings`: ALL PASS (catalog 13 =
    registry 13).
  - The CV verifiers also pass: `verify` ok, `verify-derive` ok,
    `verify-findings` PASS (catalog 5).
  - Log: `~/cv_d3b_evidence/mri/c1mri/ct_verifiers_dev_20261118T1304.log`.
- **Next:** the MRI-5 step 2 hook (§11.8), then the push and the prod
  steps (§10.4). On prod, C1-MRI takes effect with the pull and only
  matters once MRI rows exist.

## 11. MRI-5: the stage (AGREED 2026-11-16: the recommendation in each of §11.3 Q1–Q7)

MRI-5 keeps the MRI tables current: `run_mri_insight` runs extract →
derive → findings after the `GE_MRI` ingest, behind its own kill switch,
and never fails the run. It follows CV §12 (CV-5, live since 2026-11-12)
and CT §15. It is also the third stage, so the copied wrapper becomes one
shared helper (§2, §3 Q2; CV §12.3 Q2). It starts on prod only after
MRI-4's findings are applied there (§10.4). Everything below was measured
read-only or on the local throwaway DB (`~/cv_d3b_evidence/mri/mri5/`).

### 11.1 Evidence

**Run cadence and ingest** (§1.5, prod run logs):
- `GE_MRI` runs at :18 / :48 UTC, as a separate process started together
  with `GE_CT` and `GE_CV`.
- The ingest takes 18.4 s (p50), 45.6 s (max).
- Rows per run: p50 6, p99 194, max 344. 418 of 705 runs had rows.

**What exists:**
- The lock-free cores, each run by the CLI under the MRI lock
  (`insight_ge_mri`, `load.js` `LOCK_KEY`):
  - `apply_range` (`load.js`): catalog sync, the late re-read, the
    batches;
  - `derive_step` (`derive.js`): the pending days, then the code labels
    when owed;
  - `findings_step` (`findings/run.js`).
- Derive and findings already write their watermarks as CV's (= the
  watermark they covered). So "the three watermarks are equal after each
  run" is checkable, as for CT and CV.
- **Missing:**
  - `extract_step`: `apply_range` with the job read, the end id and one
    batch;
  - `insight/mri/stage.js`;
  - the wrapper `run_mri_insight`;
  - `mri/cli.js stage --rehearse`;
  - the `index.js` hook.

**Cost of one stage run** (local PG 14, the copy to 2026-11-16: 17
systems, 441k facts, of which 332k are `mri.error`; one transaction,
rolled back, measured twice; `timing.js`, `timing.log`):

| Step | Local |
|---|---|
| extract: read 350 source ids | 20 ms |
| extract: late re-read | 70–170 ms |
| derive: 6 systems × 1 day | 60–150 ms |
| derive: **code labels, full rebuild** (823 codes) | **7.6–9.4 s** |
| findings: preflight (inventory check) | 0.2–0.3 s |
| findings: default, all 17 systems | 1.7–3.5 s |

- **A run with new rows takes about 10–15 s. A run without new rows
  takes about 2–4 s** (findings only).
- **The code labels dominate.** They are rebuilt from every `mri.error`
  fact joined to its source message. On prod, the read side alone took
  7.9 s (read-only, MRI-3 evidence `33_fix_prod_labels_pg16.log`). CV's
  rebuild takes 0.6 s.
- **Growth:** `mri.error` gains about 25–30k facts a month (Aug–Oct
  2026; `growth.log`). The rebuild therefore grows about 8% a month,
  roughly doubling in a year.

**Shared tables and the other stages (read from the code):**
- **The MRI, CT and CV rows are disjoint.** MRI's rows use the prefixes
  `mri.` / `mri_`, `source = 'ge_mri'` and the job names `ge_mri_*`. The
  unique indexes take different keys, so none of the three stages waits
  on another.
- **The CT stage rehearsal fingerprints CT rows only:** `source = 'ge_ct'`
  and the `ge_ct_*` tables. Its unscoped counts are only logged (Codex
  C1-MRI, §10.6).
- **The CV stage rehearsal fingerprints every non-CV row,** so MRI rows
  too, but in a REPEATABLE READ snapshot. A commit by the MRI stage during
  that rehearsal is therefore invisible to it.
- **MRI's `findings --rehearse` checks "others unchanged" in READ
  COMMITTED.** A CT or CV stage committing during it would show as a
  false FAIL. It is a CLI-only check, and you avoid :18 / :48.
- **The wrappers** are `insight/index.js` (CT, 149 lines) and
  `insight/cv/index.js` (143 lines): copies.
  - They differ in the switch, `FUNC`, the application name and the
    message texts.
  - CT passes its rules registry to the stage and logs a partition
    warning; CV does neither.

### 11.2 Design (agreed)

1. **`insight/stage_wrapper.js` (new, shared): `run_insight_stage(cfg,
   run_log, addLogEvent, deps)`.**
   - It is the body of the CT / CV wrappers, with the differences as
     parameters: `func`, `app_name`, `label`, `load_stage`, `run_args`
     and `preflight_warnings`.
   - It keeps the same bounds: connect 10 s, statement 120 s, the
     client-side query backstop, and the 5-minute stage deadline that
     kills the connection.
   - It has one lock per stage: the stage module's `LOCK_KEY`. If the
     lock is held, it logs INFO and skips.
   - It never rejects, and a throwing logger never fails the run.
   - It loads no modality module. The CT, CV and MRI isolation tests
     check that.
2. **`insight/mri/index.js` `run_mri_insight(run_log, addLogEvent)`.**
   - It is off unless `INSIGHT_MRI_ENABLED=true`. Off, it returns before
     anything is loaded: no helper, no connection, no log event.
   - On, it calls the helper with `insight_mri_stage`, `func`
     `run_mri_insight` and `./stage`.
3. **`insight/mri/stage.js`**, with CV's shape. A step runs only if the
   one before it succeeded, and each catches up from its own state:
   1. **extract:** `extract_step` (new, in `load.js`): `apply_range` from
      the `ge_mri_extract` watermark, **at most one 50k batch**;
   2. **derive:** `derive_step`: the pending days, then the code labels
      if owed;
   3. **findings:** the MRI-4 preflight (`mode: "apply"`), then
      `findings_step`: all systems, default mode.
   - **Preflight:**
     - the writer role, not a superuser;
     - schema ≥ 9;
     - C1-MRI (`MRI_AWARE` on the three CT verifiers) and C2-MRI
       (SELECT on `log.ge_mri_gesys`);
     - an extract watermark exists (otherwise: "run `backfill --apply`
       first").

     Any failure logs a WARN and skips the run. A partition horizon
     under 18 months (`load.js` `PARTITION_WARN_MONTHS`, §6.6) logs a
     WARN, as CT's does at 6.
   - **`summarize` / `step_warnings`** as CV's, plus a WARN when derive
     takes more than 30 s (the label growth, §11.3 Q3).
4. **`mri/cli.js stage --rehearse`**, as CV's `rehearse_stage`:
   - one REPEATABLE READ transaction, rolled back, under the MRI lock;
   - run 1, catch-up; run 2, the last run's rows; run 3, no new rows;
   - then, on the uncommitted data:
     - `verify`, `verify-derive` and `verify-findings`;
     - derive touched = a full rebuild, and findings default = a replay
       (fingerprints);
     - **every non-MRI row unchanged** (findings, both catalogs, job
       state);
   - the watermarks are unchanged after the rollback;
   - it asks for the database name before connecting.
5. **The `index.js` hook** for `GE_MRI`, directly after the CV block,
   with the same shape (try/catch, a guarded ERROR log).
   - Isolation tests: `mri.test.js` allows exactly one
     `require("./insight/mri")`, inside the `GE_MRI` branch.
   - The CT and CV blocks are checked to be unchanged, with no `mri` in
     them.
6. **MRI `findings --rehearse` in REPEATABLE READ** (one line in
   `insight/mri/findings/run.js`). A CT or CV stage commit then can't
   show as "others changed", which is the fix CV review CV5-STAGE
   prompted.
7. **Run-log events** (`func` = `run_mri_insight`): one per step (INFO,
   or WARN with the reason), then a summary with `ok`, ms, the
   watermarks, `watermarks_equal` and `behind_ids`.
8. **Monitoring:** `~/cv_d3b_evidence/mri/mri5/monitor.js`, read-only,
   from CV's `monitor.js`. It checks:
   - every `GE_MRI` run's stage and ingest;
   - the `GE_CT` and `GE_CV` stage summaries;
   - the MRI job state against the source max;
   - leftover sessions.

   A daily wrapper script is offered for your crontab, next to CV-5's,
   which stays unchanged.

### 11.3 Questions and answers (AGREED 2026-11-16: the recommendation in each)

1. **Shared wrapper: when do CT and CV move onto it? Recommended: in a
   separate, later step (MRI-5b), after MRI's 5 clean days (§11.4).**
   - MRI-5 adds the helper and uses it for MRI only. The live CT and CV
     wrappers stay untouched during MRI's first week, so any problem in
     that week has one cause.
   - MRI-5b then makes `insight/index.js` and `insight/cv/index.js` thin
     callers of the helper. Each is proven by an equivalence harness:
     the old wrapper and the helper run the same scenarios (off, lock
     held, preflight skip, step error, deadline, throwing logger) and
     must give identical results and run-log events. Then come the CT
     and CV stage rehearsals and 3 days of watching with the existing
     monitors.
   - Not chosen: moving all three in MRI-5. That changes the live CT and
     CV paths in the same week MRI goes live.
   - Not chosen: a third copy, which contradicts §3 Q2 / CV Q2 and leaves
     three copies to drift.
2. **Coordination between the three stages. Recommended: no lock across
   modalities;** each stage keeps its own. The rows are disjoint and
   nothing blocks (§11.1). The rehearsals read REPEATABLE READ snapshots
   (CV's already does; MRI's does with §11.2 items 4 and 6). Not chosen:
   a shared advisory lock, which would make three independent processes
   queue at :18 / :48 for no benefit.
3. **Code labels. Recommended: rebuild them on every run with new rows,
   as CV** (8–10 s now, on about 59% of runs). The run log WARNs when
   derive passes 30 s; at that point, plan a cheaper rebuild.
   - Not chosen now: a once-a-day rebuild. The findings preflight
     refuses while labels are owed (the MRI-4 interlock, reviewed). So
     findings would skip on most runs, or that interlock would have to be
     relaxed and reviewed again.
   - Not chosen now: an incremental rebuild. It is a new derive
     algorithm with its own review, for about 8 s every 30 minutes.
4. **Findings cadence. Recommended: every run, all systems, default mode,
   as CV** (1.7–3.5 s). Every run is then a drift check, and a date change
   is never missed. An unchanged run writes no finding rows.
5. **Kill switch. Recommended: a separate `INSIGHT_MRI_ENABLED=true`,
   off by default,** as CV. Deploying the code then changes nothing, and
   MRI can be switched off alone.
6. **Per-run ceiling. Recommended: at most one 50k batch per run** (CT
   Q5, CV Q4; the largest run seen was 344 rows).
7. **First run. Recommended: it catches up from the watermark left by
   your manual backfill / derive / findings applies** (§10.4 steps 6–8),
   in one batch. Without an extract watermark the stage logs a WARN and
   skips.

### 11.4 Exit criteria (as CV §12.4)

- The stage rehearsal passes on prod, and a typical run is measured
  (expected 10–15 s with rows, 2–4 s without).
- **At least 5 consecutive days of clean runs** (the user, 2026-11-18:
  5 days instead of 7 for every monitoring window from now on: MRI-5,
  MRI-5b and later stages; CV-5 closed on the same rule, CV §12.10):
  - every summary `ok`;
  - the three MRI watermarks advance and are equal after each run;
  - derive has nothing pending and no labels owed;
  - `behind_ids` = 0;
  - default findings report 0 drift.
- `verify`, `verify-derive` and `verify-findings` pass at the end. Each
  new finding or resolution in the window is reviewed with evidence.
- **The ingest is unaffected,** with the switch off and on:
  `log.ge_mri_gesys` inserts, the Redis offsets, `gzip_n_save`, and the
  errors / WARN baseline.
- **CT and CV are unaffected:** their runs and stages stay clean, and
  their three verifiers pass.

### 11.5 Build order and checkpoints

1. **Code (new files only):**
   - `insight/stage_wrapper.js`, which nothing in the CT or CV run loads
     until MRI-5b;
   - `insight/mri/index.js` and `insight/mri/stage.js`;
   - `extract_step`;
   - `stage --rehearse`;
   - the REPEATABLE READ line (§11.2 item 6).

   Then the tests (no DB, from CT's and CV's `stage.test.js`), a local
   rehearsal on the throwaway DB, and the Codex handoff
   `REVIEW-MRI5-STAGE-HANDOFF.md`. **This step fits the freeze** (new
   files that the CT and CV runs don't load); a new file in `insight/`
   counts as one (agreed 2026-11-16).
2. **After the CV-5 close-out:**
   - the `index.js` hook and the isolation tests;
   - a hook harness: `GE_MRI` identical with the switch unset, and
     `GE_CT` and `GE_CV` identical;
   - the Codex handoff `REVIEW-MRI5-HOOK-HANDOFF.md`.
3. **After MRI-4's findings are applied on prod (§10.4):**
   1. commit (I ask first);
   2. you run `node insight/mri/cli.js stage --rehearse` on prod, avoiding
      :18 / :48;
   3. push;
   4. pull with the switch unset; I confirm the next `GE_MRI`, `GE_CT`
      and `GE_CV` runs are unchanged;
   5. you set `INSIGHT_MRI_ENABLED=true`;
   6. 5 days of monitoring (§11.4), then the close-out against §11.4.
4. **MRI-5b** (§11.3 Q1): CT and CV move onto the helper, with its own review,
   both stage rehearsals and 3 days of watching. Then MRI-6 (`api` views
   and the viewer), planned when it starts.

Checkpoints for your go-ahead: the answers to §11.3, after step 1, before
the hook, before each commit, the prod rehearsal, and each deploy action.

### 11.6 Step 1 build (2026-11-16): new files, and three MRI files

**Files.** Nothing in the GE CT or GE CV run loads any of them; the
isolation tests check that.
- **New: `insight/stage_wrapper.js`,** the shared wrapper (§11.2 item 1).
  - It is the CT / CV wrapper body, with `func`, `app_name`, `label`,
    `load_stage`, `run_args` and `preflight_warnings` as `cfg`.
  - It loads only `./db` and `crypto`.
  - It also refuses an incomplete `cfg` (an ERROR before connecting).
- **New: `insight/mri/index.js` `run_mri_insight`.**
  - With `INSIGHT_MRI_ENABLED` unset, it returns before anything is
    loaded, the wrapper included (a test checks the module cache).
  - It sends a partition-horizon WARN (18 months, §6.6), and the run goes
    on.
  - If the wrapper can't be loaded, that is an ERROR event, never a
    rejection.
- **New: `insight/mri/stage.js`,** with CV's shape:
  - `STEPS`, `run_stage`, `summarize` and `step_warnings`.
  - MRI's warnings: rule errors, and a derive over `DERIVE_WARN_MS` =
    30 s (§11.3 Q3).
  - `stage_preflight`: the extract apply preflight, schema ≥ 9, and an
    extract watermark.
  - `rehearse_stage`: REPEATABLE READ, 3 runs, the three verifiers,
    touched = full, default = replay, `OTHERS_SQL` (every non-MRI row of
    findings, both catalogs and job state).
- **`insight/mri/load.js`:** `extract_step`, which is `apply_range` from
  the watermark with one batch, plus `behind_ids`.
- **`insight/mri/cli.js`:** `stage --rehearse` only, asking for the
  database name first.
- **`insight/mri/findings/run.js`:** `findings --rehearse` runs in
  REPEATABLE READ (§11.2 item 6).
- **New: `insight/mri/test/stage.test.js` (25 tests)**, modelled on CV's
  `stage.test.js`. It also covers:
  - the wrapper's `cfg` checks;
  - `run_args` loaded before connecting, with the key order;
  - the CT / CV timeouts;
  - the require lists of the wrapper and of MRI's `index.js`.

**Tests:**
- **Every suite: 340 of 340** (315 + 25).
- **Mutations:** 22 mutations of the new code. Each fails at least one
  test.
  - Among them: two batches per run, the findings preflight in rehearse
    mode, the job-state prefix, the 30 s boundary, a missing watermark
    check, READ COMMITTED (stage and findings), the switch, the app name,
    the partition WARN, a top-level wrapper require, the unlock after the
    deadline, `cfg` checks, `run_args`, the kill, the option order,
    `behind_ids`, and `stage` without `--rehearse`.
  - One survived at first: `extract_step` defaulting to 2 batches, since
    the fake source had only one. The fake now has a second batch
    waiting.

**The equivalence harness** (`~/cv_d3b_evidence/mri/mri5/equiv.js`,
`equiv.log`, DB-free; the groundwork for MRI-5b, §11.3 Q1):
- It compares the live `run_ct_insight` and `run_cv_insight` with
  `run_insight_stage`, configured as CT and as CV.
- It covers 12 scenarios each: ok, a WARN step, lock held, preflight
  refused, a partition warning, a failed step, a failed watermark read,
  a stage throw with a failing unlock, a connect throw, a throwing
  logger, no run id, and the deadline.
- **IDENTICAL in all 24** (return values, run-log events, connection
  calls, `run_stage` options).
- The harness itself catches a changed label, application name or
  warning text.

**Local rehearsal** (throwaway PG 14):
- 1,340 new `log.ge_mri_gesys` rows were copied read-only from prod at
  20:25 UTC (ids to 5,127,394; the counts below the old maximum match).
- `reh.js` → `02_reh.log`, `rc_control.js` → `03_rc_control.log`.

| Case | Result |
|---|---|
| **A**, the rehearsal on the `dev` checkout (CT verifiers not MRI-aware) | refused: C1-MRI |
| **B**, the rehearsal (C1-MRI simulated in memory), with a `ge_ct_` job-state row committed by another session after run 1 | **OK**. Run 1, catch-up (1,293 rows): 10.7 s. Run 2, the last run (47 rows): 9.7 s. Run 3, no rows: 2.0 s. Watermarks equal after each run. Verify 303 cells, 0 diffs; verify-derive ok; verify-findings PASS (70 = 70); touched = full (17 systems); default = replay (0 changes); non-MRI rows unchanged; watermarks unchanged after the rollback |
| **C**, the live path (`run_mri_insight` → wrapper → stage, committing, local writer pool) | Catch-up: 10.1 s (extract 0.6 s, 1,340 rows; derive 7.4 s; findings 2.1 s). No rows: 2.1 s. INFO events, watermarks equal at 5,127,394. The three verifiers pass afterwards; non-MRI rows unchanged |
| **D**, the MRI lock held by another session | INFO lock skip; no advisory lock left afterwards |
| **Control:** the same fingerprint with the same concurrent commit | READ COMMITTED: "changed" (a false failure). REPEATABLE READ: unchanged |

- **The cost is as measured in §11.1:** about 10 s with rows (the code
  labels take about 7.5 s of it), about 2 s without.
- The new data opened one finding: `mri_table_fault` (medium) on one
  current system, on 2026-11-16. It is local only; on prod it would be
  reviewed in the monitoring (§11.4).
- **The local DB now holds the stage's committed state:** extract,
  derive and findings at 5,127,394; 442,576 facts; 70 findings (27
  open).

**Not touched:** the root `index.js`, CT's and CV's wrappers and stages,
and `insight/cv/`. Nothing was written to prod; the copy was a read-only
transaction. The CT and CV suites pass unchanged.

**Next:**
1. The Codex review: `REVIEW-MRI5-STAGE-HANDOFF.md`.
2. After the CV-5 close-out: the `index.js` hook (§11.5 step 2).
3. Note for C1-MRI (§10): its commit also flips
   `insight/mri/test/stage.test.js` "stage_preflight with the real
   extract preflight: refused until C1-MRI", as it does the
   `findings.test.js` preflight case (§10.2).

### 11.7 Codex review MRI5-STAGE (closed 2026-11-17): `REVIEW-MRI5-STAGE-CODEX.md`

**One P3, fixed. No other findings.** The reviewer ran the six requested
suites (143 tests), the equivalence harness (24 of 24 identical), and three
probes of their own. They ran no CLI and connected to no database.

- **P3: an early rehearsal failure gave a secondary TypeError.** The
  rehearsal listed all its planned runs before executing them. When run 1
  or 2 failed, the drift total read `steps` of a run that never ran, so
  `rehearse_stage` rejected with "Cannot read properties of undefined"
  instead of returning its failed result. The rollback and the unlock
  still happened.
  - **Fix** (`insight/mri/stage.js`): the planned runs and the executed
    runs are kept apart. Every check reads only the executed runs, a run
    not reached is listed in `checks.not_run`, and `runs_ok` requires
    every planned run.
  - **Regression test** (`stage.test.js`, DB-free, the reviewer's case:
    watermark 100, pending maximum 120, the last run from 111): extract
    fails in run 1, then in run 2. Each gives a structured failed result,
    rolled back and unlocked, with only the executed runs. It fails the
    old code with the reviewer's TypeError.
  - The local rehearsal after the fix is OK (`04_reh_after_p3.log`).
  - **The same pattern is in CV's `rehearse_stage`.** It is not changed
    here (the freeze; `insight/cv/` is out of scope). It only matters
    when a CV rehearsal fails early, so it is noted for MRI-5b, which
    touches the CV wrapper anyway.
- **Note: "off loads nothing".** The module-cache test could not prove
  that `./stage` stays unloaded, because the suite itself loads it. A
  fresh-process test now hooks `Module._load`: with the switch off,
  `run_mri_insight` loads no module and logs nothing.
- **Confirmed by the reviewer:**
  - CT loses nothing on the shared wrapper with the right configuration:
    `label: "insight"` (CT's exact lock and deadline texts),
    `app_name: "insight_stage"`, `run_args` for its rules, and the
    partition WARN text.
  - MRI-5b must keep CT's switch check before the require, and the public
    exports (`enabled` and the timeout constants). The thin callers are
    reviewed when they are built.
  - An incomplete `cfg` is rightly an ERROR, not a throw.
  - `behind_ids` measures lag behind the source, also when the rehearsal
    passes `to_id`.
  - `OTHERS_SQL` covers every non-MRI row, and `ge_mri_` is 7 characters.
  - They would ship the code-label rebuild as it is, with the 30 s WARN.
  - The test strings are synthetic.
- **Tests:** every suite, 342 of 342 (stage 27).

### 11.8 Step 2 build (2026-11-17): the `index.js` hook, in a worktree

**Where:** a scratch git worktree on branch `mri5-hook` (from `dev` at
95797ea), outside the repo directory, uncommitted; the main checkout and
prod are unchanged. It was built before the CV-5 close-out so that the
review is done by then; it lands on `dev` only after the close-out (the
freeze). The diff is also saved as `~/cv_d3b_evidence/mri/mri5/hook/mri5-hook.patch`.

**The hook:** 16 lines in `on_boot()`, directly after the CV hook, CV's
shape. `if (shell_value[0] === "GE_MRI")`, `require("./insight/mri")`,
`await run_mri_insight(run_log, addLogEvent)`, and a guarded catch that
logs an ERROR `run_mri_insight`. It runs after the system loop and before
the run log is written. The CT and CV blocks are unchanged.

**Isolation tests** (`insight/mri/test/mri.test.js`, 23 → 24):
- The walk "nothing outside `insight/mri` loads it" now covers CT's and
  CV's `insight/` files only. The root `index.js` has its own test:
  - exactly one require of `insight/mri`, `require("./insight/mri")`,
    inside the one `GE_MRI` branch, awaited, with the guarded ERROR log;
  - the order: the ingest loop, the CT hook, the CV hook, the MRI hook,
    then `writeLogEvents`;
  - the CT and CV blocks keep their requires and mention nothing of MRI;
  - nothing else in `index.js` mentions `insight/mri`,
    `run_mri_insight`, `stage_wrapper` or `INSIGHT_MRI`.
- **Mutation check:** 12 breaks of the hook, each failing the test: the
  hook under `GE_CV`; before the CV block; after `writeLogEvents`; the
  require outside the branch; the CT branch also loading `insight/mri`;
  a second require at the top; the wrong function name in the catch; an
  unguarded ERROR log; the stage not awaited; MRI mentioned in the CV
  block; the wrapper required at the top; no hook.

**Hook harness** (DB-free, `~/cv_d3b_evidence/mri/mri5/hook/`:
`hook_harness.js`, `hook_compare.sh`, `hook_compare.log`; adapted from
CV-5's). It loads `dev`'s `index.js` and the hook's, with recorders for
the parsers, the pool, the boot queries and the logger, and three fake
systems. A real `insight/*/index.js` is loaded only while its switch is
off; with a switch on it is stubbed, and the harness throws if the real
one could run. No connection can be opened.

| Scenario | vs `dev` |
|---|---|
| `GE_MRI`, switch unset (CT's and CV's on), `false`, `TRUE` | ingest calls, order and run-log events identical; loads `insight/mri/index.js` only; no open handles |
| `GE_MRI`, on (stage stubbed, CT's and CV's on too) | ingest identical; the stage starts after 3 / 3 systems are ingested, before `writeLogEvents`; +1 event |
| `GE_MRI`, on, the stage throws | +1 ERROR `run_mri_insight` (CATCH); the log is still written |
| `GE_MRI`, on, `require("./insight/mri")` fails | +1 ERROR; the log is still written |
| `GE_MRI`, on, the stage and the logger both throw | the log is still written (no event added) |
| `GE_CT`, all switches on (stages stubbed) / MRI's on, CT's off | **identical** |
| `GE_CV`, all switches on (stages stubbed) / MRI's on, CV's off | **identical** |

No unhandled rejection in any scenario. **Harness self-check:** a hook
that isn't awaited loses the stage's event from the written log, and a
hook under `GE_CV` makes `GE_CV` differ from `dev`; both show.

**The ingest's source writes are finished when the hook starts.**
`jobs/MRI/index.js` `ge_mri_parsers` awaits every step in its loop: the
`log.ge_mri_gesys` insert and upsert, the Redis offset update
(`gesys_parser.js`) and `gzip_n_save`; it catches its own errors, and
`run_job` catches too. One exception, found in review (§11.9):
`gzip_n_save`'s `log.saved_files` insert is not awaited, so it can still
be pending.

**Overlap:** `GE_MRI` starts at :18 / :48 with `GE_CT` and `GE_CV`, as a
separate process (§11.1). Its ingest takes 18 s (p50), 46 s (max), and the
stage about 10 s with rows (5 min at most, by its deadline). The three
stages have their own locks and disjoint rows (§11.3 Q2).

**Tests:** every suite in the worktree: 342 pass, 1 skipped, 0 fail
(`dev` + 1). The skip is CT's `connect()` timeout test, which needs
`PG_SSL_PATH` from `.env`; the worktree has none. It passes in the main
checkout.

**C1-MRI together with the hook:** both patches apply cleanly to `dev`
(they both touch `mri.test.js`, in different tests). Combined, the only
failure is the `stage.test.js` case that flips with C1-MRI (§10.2, §11.6
note). Its flip is written and saved as
`~/cv_d3b_evidence/mri/c1mri/c1-mri-stage-test-flip.patch` (the live
stage's preflight passes once the CT verifiers are MRI-aware; still
refused as a superuser, another role or without C2-MRI). With it, every
suite passes: 343. The C1-MRI worktree's diff is saved next to it as
`c1-mri.patch`.

**Next:**
1. ~~The Codex review: `REVIEW-MRI5-HOOK-HANDOFF.md`~~ (closed, §11.9).
2. After the CV-5 close-out (2026-11-19 20:18 UTC), asking first: commit
   C1-MRI (with the flip), then the hook, on `dev`; remove both
   worktrees. Then the prod order of §10.4 and §11.5 step 3.

### 11.9 Codex review MRI5-HOOK (closed 2026-11-17): `REVIEW-MRI5-HOOK-CODEX.md`

**No findings in the hook.** The reviewer read the hook, the isolation
test, `run_mri_insight`, the wrapper, the MRI parser and the prod logger
and enums (read only). They re-ran the harness from a copy, with extra
assertions of their own, and the combined C1-MRI + hook + flip tree. They
connected to no database and ran no CLI.

- **A correction to the handoff (not to the hook):** "ingest is
  finished when the hook starts" is too strong. `tooling/gzip_file.js`
  `insert_buffer` calls `db.none(...)` for the `log.saved_files` insert
  without `await`, so `gzip_n_save` can return before that insert
  completes (confirmed by reading the code, and by the reviewer's DB-free
  probe).
  - It predates the hook, and the GE CT and GE CV ingests share it.
  - The stage doesn't depend on it: it reads `log.ge_mri_gesys`, whose
    insert is awaited, uses its own pool, and never closes the ingest's
    main pool.
  - **Not changed here.** It is a shared ingest helper, and the reviewer
    advised against widening the hook change. §11.8 now says so. A fix
    (await it) would be a separate ingest change for all three
    modalities, with its own review.
- **Confirmed by the reviewer:**
  - switch off: only `insight/mri/index.js` loads, and it returns before
    the wrapper, `db.js` or the stage; no event;
  - `GE_CT` and `GE_CV` never enter the new branch, even with MRI's
    switch on;
  - a failed require, a stage rejection, and a failing logger on top all
    still reach the final log write;
  - the stage's pool is its own and closed; the prod logger's signature
    and enum values match;
  - overlap: the deadline starts after the 10 s connect; an overlapping
    MRI stage skips on the lock; no cross-modality lock;
  - **the C1-MRI test flip is right.** The refusal itself stays covered
    by the "C1-MRI interlock" test with fake modules.
- **Their verification:** `mri.test.js` 24 / 24, `cv.test.js` 17 / 17, CT
  `stage.test.js` 23 + 1 skip (no `PG_SSL_PATH`). MRI `stage.test.js`
  26 / 27: the fresh-process test can't spawn a child in their sandbox
  (EPERM). The same check passed when they ran it directly; here it
  passes, 27 / 27.

**Step 2 committed on `dev` (2026-11-18):**

- Applied after C1-MRI (4a626a2) from the durable patch
  `~/cv_d3b_evidence/mri/mri5/hook/mri5-hook.patch`. It is identical to
  the reviewed worktree diff (branch `mri5-hook`), apart from the
  `index` lines.
  - `index.js` has not changed on `dev` since the worktree's base
    95797ea.
  - `insight/mri/test/mri.test.js` has: C1-MRI changed it. The hunk
    applies 18 lines lower.
  - 2 files, +49 −3.
- **Every suite passes in the main checkout: 344 of 344,** none skipped.
- **Hook harness (`hook_compare.sh`), DB-free:**
  - `index_head.js` was refreshed from `dev` before the patch (4a626a2;
    byte-identical to the 11-17 copy). `index_new.js` is the patched
    `index.js`, byte-identical to the reviewed one.
  - `GE_CT` and `GE_CV` are identical to `dev`, with MRI's switch on and
    off.
  - With the switch unset, `false` or `TRUE`, `GE_MRI` only adds
    `require ./insight/mri` (the real one), and only
    `insight/mri/index.js` loads.
  - With it on, the stage runs after all three systems are ingested. A
    throw or a failed require is logged as ERROR `run_mri_insight` CATCH
    and still reaches the final log write.
  - Every scenario's output is identical to the 11-17 run. The 11-17
    log's two hand-run mutation self-checks are kept in
    `~/cv_d3b_evidence/mri/mri5/hook/run_20261117/`.
- **Next:** remove the two worktrees, push, then the prod steps
  (`~/cv_d3b_evidence/mri/PROD-STEPS-MRI.md`). The deploy itself is
  recorded in §11.10.

### 11.10 Deploy (2026-11-18)

The user ran every prod command (`/home/prod/hhm_rpp_ge`, as `prod`),
following `~/cv_d3b_evidence/mri/PROD-STEPS-MRI.md`. Claude checked
read-only after each step: the run logs, the MRI, CT and CV verifiers,
and `monitor.js`. Evidence is in `~/cv_d3b_evidence/mri/mri5/prod_state/`.
Times are UTC.

- **Pushed** `dev`, `staging` and `prod` at 886c0e5 (C1-MRI 4a626a2,
  the hook 886c0e5), at the user's word. **The user pulled on prod**
  before the 13:48 runs; `INSIGHT_MRI_ENABLED` was not set.
  - The 13:48 runs against the 13:18 runs (`runshape.js`): the same
    functions for `GE_MRI`, `GE_CT` and `GE_CV`. Only the per-file counts
    changed with the files present. `monitor.js off`: no stage event.
- **Migration 009 applied** (about 14:00) after `status`, `roundtrip`
  and a dry run: in scope `+231 -0 ~0`, schema version 9. Checked
  read-only (`check_009.js`):
  - the three MRI tables were empty; 44 `ge_mri_facts` partitions, to
    2028-12;
  - `insight_writer` has SELECT, INSERT, UPDATE and DELETE on them, and
    USAGE on the sequence;
  - the C2-MRI grant (11-17) still holds: SELECT, no INSERT, on
    `log.ge_mri_gesys`;
  - no MRI rows anywhere yet.

  The 14:18 runs: `GE_MRI` had no stage events, and the CT and CV stages
  were ok. The CT, CV and MRI verifiers passed.
- **C1-MRI check, the CT stage rehearsal:** overall OK (368.5 s, schema
  9).
- **MRI-2, the extract backfill** (applied about 14:40): 444,260 facts,
  watermark 5128617; `verify` ok; 824 codes.
  - **One unreviewed code, 2227004** (process `scn`): 1 row, SME19647,
    device day 2026-11-17. It is counted in `mri.error` only, with no
    label or category. **Left unreviewed for now** (the user,
    2026-11-18); review it after the window.
- **MRI-3, derive** (applied about 14:59): the rehearsal had 0
  differences and 0 leaks. 70,538 daily rows; 824 codes (361 labelled,
  463 without a label); nothing pending; `verify-derive` PASS.
- **MRI-4, findings `--replay`** (applied about 15:30): **71 findings, 28
  open;** `verify-findings` PASS.
  - The local copy (to 11-16) had 70 and 27 (§9.2). **The difference is
    one new finding:** SME02582 `mri_coil_fault`, medium, opened
    2026-11-17. The evidence: `bias_open_circuit` on 11-11 (32 events),
    11-12 (1), 11-13 (4) and 11-17 (1). That is 4 days in 7, the rule's
    threshold. The 11-17 row was newer than the local copy.
  - The CT and CV verifiers passed after every write step.
- **MRI-5, the stage rehearsal** (about 16:35, 95 s): **overall: OK
  (rolled back).**
  - Pending: 137 rows (5128618..5128754, captured 14:48 to 16:18).
  - Run 1 (the catch-up, 75 rows): 13.9 s. Run 2 (the last run's 62
    rows): 12.6 s. Run 3 (no rows): 4.1 s. All ok, with the watermarks
    equal after each.
  - Derive takes about 9 s whenever a run has rows, for the code-label
    rebuild. Findings takes about 4 s every run, because it re-checks
    the 6 systems with recent data; the other 11 are skipped as stale.
  - These are inside §11.4's expected 10–15 s with rows and 2–4 s
    without. On prod most runs have rows (137 rows over 4 runs), so most
    `GE_MRI` runs will add about 13 s.
  - `verify` 303 cells, 0 differences; `verify-derive` ok;
    `verify-findings` PASS (71 = 71). Derive touched = a full rebuild of
    17 systems; findings default = replay (0 changes). Non-MRI rows
    unchanged. No unreviewed codes, no new findings.
  - The watermarks after the rollback: 5128617 ×3 (unchanged).
- **Switched on:** the user appended `INSIGHT_MRI_ENABLED=true` to the
  prod `.env` at **16:43**.
- **First live run, `GE_MRI` 16:48, clean:**
  - 33.1 s in total: the ingest, then the stage 13.7 s.
  - **extract:** 5128617 → 5128779, 162 rows, 224 facts, no unreviewed
    codes, `behind_ids` 0.
  - **derive:** 6 systems, 6 days, 8.8 s; nothing pending after.
  - **findings:** 0 inserted, 10 updated (the open findings' last data
    day), 0 drift; 71 in all, 28 open.
  - **Summary:** ok, with the watermarks equal at 5128779 = the source
    max.
  - Ingest: 0 ERROR, 296 INFO, 49 WARN (the 49–55 baseline).
  - No insight session left.
  - **`GE_CT` and `GE_CV` 16:48:** both stages ok (12.4 s and 3.9 s), 0
    not clean.
- **A false alarm in the monitor, fixed (16:51):** its first `on` run
  marked the clean run "stage skipped: [object Object]".
  - The cause: it took any stage event with a `note.skipped` as a stage
    skip. But extract logs `skipped` as a count object, `{}` when
    nothing is skipped (`insight/mri/stage.js`, `nonzero(x.skipped)`),
    and an empty object is truthy.
  - The fix: only a string `skipped` counts, which is how the wrapper
    logs a lock or preflight skip. The self-test's extract fixture now
    has the real `skipped: {}`. The old monitor fails it, the fixed one
    passes, and the lock and preflight skip cases still pass.
  - It is evidence tooling outside the repo; no pipeline code changed.
    The rerun: 0 not clean for `GE_MRI`, `GE_CT` and `GE_CV`.
- **Read-only checks after the first live run:** `daily.sh` run by hand into a separate folder
  (`prod_state/day0_1652/`, 16:52 to 16:58), so the 21:25 cron run
  writes the first real `STATUS` line. **OK (day 0), 0 failed commands:**
  - MRI: `verify` 303 cells, 0 differences; `verify-derive` ok;
    `verify-findings` PASS (71 = 71).
  - CT: `verify` 624 cells, all equal; `verify-derive` ALL PASS;
    `verify-findings` PASS (117 = 117).
  - CV: `verify` 17 cells; `verify-derive` ok; `verify-findings` PASS
    (13 = 13).
- **Monitoring: 5 days** (§11.4; the user's rule since 2026-11-18). The
  window runs from **2026-11-18 16:48 to 2026-11-23 16:48 UTC**.
  - `~/cv_d3b_evidence/mri/mri5/daily/SWITCH_ON` holds `2026-11-18
    16:43`.
  - `daily.sh` runs from the user's crontab (`25 21 * * *
    /home/matt-teixeira/cv_d3b_evidence/mri/mri5/daily.sh`, added
    2026-11-18). It runs the monitor and the nine
    verifiers read-only, and appends one line per day to
    `daily/STATUS`. It stops by itself after day 6 (11-24).
  - The close-out is against §11.4 after the 11-23 check.
- **Follow-ups (not in the window):**
  - review code 2227004;
  - MRI-5b;
  - the `gzip_file.js insert_buffer` await (§11.9);
  - whether MRI-5b's 3-day watch (§11.5) should be 5.
