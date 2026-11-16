# GE MRI Insights — plan

**Current state (2026-11-13; read this first):**
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
- MRI-2's first prod write only after
  009, C1-MRI and C2-MRI (§7.5).
- **Found while building MRI-1 (§6.4): the CT verifiers are not
  MRI-safe.** They exclude `cv.*` rather than select CT keys, so the first
  `mri.*` catalog row on prod would fail them. A CT code change (C1-MRI),
  after the close-out and before MRI-2's first prod write.
- **Timing:** GE CV CV-5 is in its monitoring window until 2026-11-19
  20:18 UTC (PLAN-CV-INSIGHTS.md §12). Until it closes out, MRI work is
  limited to investigation, planning, and new files that nothing in the
  CT or CV run loads. The same rule held for CV during CT Phase 5.
  Migrations are applied, and shared `insight/` code and `index.js` are
  changed, only after the CV-5 close-out.
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
| **MRI-5 Stage** | `run_mri_insight` after `GE_MRI`, shared wrapper, `INSIGHT_MRI_ENABLED` | as CV §12.4: 7 days clean, CT and CV unchanged | after the CV-5 close-out |
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

