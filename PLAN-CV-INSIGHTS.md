# GE CV Insights — plan

Status (2026-11-12):
- **CV-0 (decide): AGREED** 2026-11-06 (the §2 design and the
  recommended answer to every §3 question).
- **CV-1b (ingest integrity): done apart from its sign-off.** All fixes
  are deployed: parser D1 + D5, collector D3a + D5 (§5.5). The 361-record
  backfill (D6) is applied and verified. Every review is closed. The
  sign-off waits for the first real rotation on SME02412 or SME08640.
  At the 2026-11-09 15:00 UTC check, both systems pass, with no rotation
  yet: SME02412 is at seq 2999, SME08640 at 138.
- **CV-2 groundwork (§6): done, read-only.** Every error code is
  inventoried (`PLAN-CV-INSIGHTS-CODES.md`). The mapping is **AGREED
  2026-11-09** (the recommendation in each of M1–M4, §6.4).
- **CV-1 schema (§7): migration 007 drafted** (new objects only).
  - Codex review closed: one P2 (the fact key), fixed and re-rehearsed
    (§7.6).
  - Tests pass. Pre-checks, dry run and roundtrip are clean on a local
    throwaway database, and the §6.2 mapping loads into it and reconciles
    exactly.
  - Next: the user applies 007 on prod after the GE CT Phase 5 close-out
    (§7.5).
- **CV-2 extract (§8): built 2026-11-09, uncommitted**, as new files in
  `insight/cv/` that nothing in the CT run loads.
  - Read-only dry run on prod: 17 of 17 cells equal the independent SQL.
  - Local rehearsal of the write path: clean.
  - Codex review closed: one P2 (validate the registry before the
    catalog write), fixed (§8.5). Writing on prod waits for 007, C1 and
    C2 (§8.4).
- **CV-3 derive (§9): built 2026-11-09, uncommitted** (daily rollup and
  code labels; `insight/cv/derive.js`).
  - Local rehearsal: every check equals independent SQL.
  - Codex review closed: P2 (the code-label retry) and P3 (non-ASCII
    labels) fixed (§9.5).
  - K1 (no CV clock table in v1): the recommendation stands unless the
    user objects (§9.4).
- CV-1 (007), CV-2 and CV-3 are **committed and pushed** (34319e8,
  bc96621, 9f8d592). Nothing is applied on prod.
- **CV-1b sign-off, 2026-11-09 21:13 UTC check:** `verify_cv1b` passes on
  both systems. There has been no rotation yet (SME02412 at seq 3038,
  SME08640 at 188), and no `prev tail` event in the prod run logs.
- **CV-4 groundwork (§10): done, read-only.**
  - 5 rules were replayed over all history: 12 findings, 1 open.
  - Decisions F1–F6 **AGREED 2026-11-10** (the recommendation in each).
- **CV-4 findings (§10.8): built 2026-11-10, uncommitted.**
  - New files under `insight/cv/findings/`, plus migration 008 (the
    `ge_ct` filter on the CT findings view).
  - Local rehearsal clean: 12 findings equal the independent SQL;
    repeat and incremental runs give 0 changes and 0 drift; CT rows are
    untouched.
  - Codex review closed: one P2 (fail closed when derive state is
    missing or facts and daily disagree), fixed (§10.9).
- CV-4 and 008 are **committed and pushed** (5ec391e). Nothing CV is
  applied on prod. A read-only check on 2026-11-11 found prod at schema
  6 and C2 done (`insight_writer` has SELECT on `log.ge_cv_syserror`).
- **CV-1b sign-off, 2026-11-11 13:10 UTC check:** `verify_cv1b` passes on
  both systems. There has been no rotation yet (SME02412 at seq 3095,
  SME08640 at 247), and no `prev tail` event in the prod run logs.
- **GE CT Phase 5 closed out 2026-11-12 13:11 UTC** (all §15.4 criteria
  met; `PLAN-CT-INSIGHTS.md` status). The CT/`index.js` freeze is over.
- **CV-1b sign-off, 2026-11-12 14:40 UTC check:** `verify_cv1b` passes on
  both systems, missing 0 and duplicated 0. SME08640 logged 1,172 rows in
  two days. There is still no rotation (SME02412 ~3132, SME08640 ~1362
  lines) and no `prev tail` event.
- **C1 (§11): committed on `dev` 2026-11-12** after the close-out, merged
  onto the close-out commit. The only conflict was `derive/verify.js`
  `module.exports`, merged by hand. All 11 insight test suites (CT and
  CV) pass. The scratch worktree is removed. With C1, the read-only CT
  `verify`, `verify-derive` and `verify-findings` all pass on prod.
  **The user's CT stage rehearsal on prod passed** (2026-11-12, rolled
  back after 362 s, watermark 18605118):
  - every check is `overall: OK`, with 0 drift;
  - touched equals the full rebuild for all 34 systems;
  - default findings equal the replay (115 findings);
  - the watermarks are unchanged after the rollback.

  Pushed to dev/staging/prod (28c973d). The user pulled on prod. Build
  history follows the rollout entry below.
- **CV-1 to CV-4 ROLLED OUT ON PROD, 2026-11-12** (the user ran each step
  from `/home/prod/hhm_rpp_ge` at 28c973d; I checked each one read-only):
  - **007** (15:23:35 UTC): dry run, roundtrip (007 + 008 up and down,
    catalog identical) and apply all clean. 12 objects, in-scope
    `+16 -0 ~0`, protected objects unchanged.
  - **CV-2 backfill:** the rehearsal equals the dry run. The apply
    (15:26 UTC) holds 142,004 facts from 97,567 rows (12,308 relays +
    85,259 counted, 0 unstorable): SME02412 129,605, SME08640 12,399.
    `ge_cv_extract` = 474161. `verify` ok: 17 / 17 cells, catalog 9.
  - **CV-3 derive:** the rehearsal had both passes identical and touched
    = full. The apply wrote 5,348 daily rows and 203 codes (13
    unlabeled). `verify-derive` ok, with 0 differences in all four
    checks.
  - **008** (`WHERE source = 'ge_ct'` on `api.ge_ct_findings_v`): dry
    run and apply clean, in-scope `+0 -0 ~1`. The CT findings view still
    shows 115 rows, none of them CV.
  - **CV-4 findings `--replay`:**
    - The rehearsal passed every check: pass 2, default and incremental
      runs all with 0 changes and 0 drift; CT untouched.
    - The apply wrote 13 findings, 2 open; `verify-findings` PASS.
    - Since §10.7 (12 findings, 1 open) there is one new finding:
      SME08640 `cv_error_storm` (medium), open from 2026-11-11. That
      day had 767 errors against ~35 a day: 644 collimator collision
      and 91 lift collision. It is a real burst, and is question 4 in
      the §5.5 D4 note.
    - SME02412 `cv_detector_com_errors` (high) stays open: its last trip
      was 10-27.
  - **Views:** `api.ge_cv_findings_v` 13, `ge_cv_daily_v` 5,348,
    `ge_cv_capabilities_v` 17, `ge_cv_codes_v` 203. In
    `ge_cv_system_summary_v`, SME02412's `last_seen` is about 1.5 h in
    the future. That is its device clock (K1: now ~108–118 min ahead,
    at the top of the 11-09 range), not a pipeline fault, and is
    question 5 in the D4 note.
  - **CT with CV rows present:** the CT `verify`, `verify-derive` and
    `verify-findings` all pass (catalog 39 and 13; CV rows ignored). The
    15:48 UTC CT stage run was ok: 0 errors, 0 drift, watermarks equal at
    18605661, and the 13 `ge_cv` findings were untouched.
  - **Next: CV-5** (the stage after `ge_cv_parsers`, behind a kill
    switch). Until then the CV tables do not update: the extract
    watermark stays at 474161 and new `sysError` rows wait.
  - The three CT verifiers count only CT catalog rows and export
    `CV_AWARE`.
  - Tests pass. The local rehearsal shows: the originals fail with CV
    rows present, C1 passes, a wrong CT row is still caught, results
    are unchanged with no CV rows, and the real `--apply` interlock
    opens.
  - Codex review closed: one P2 (the `cv\_%` escape depended on
    `standard_conforming_strings`), fixed with a prefix test in CT and in
    the CV findings statements (§11.6). The round 2 re-review found no
    new issues. C1 is ready to commit after the close-out.
  - After the close-out: review → fix → commit on `dev` → the user's
    CT stage rehearsal → push. §8.4 and §10.8 follow.

The
user chose to start GE CV after GE CT Phase 6, with CT Phase 7
(field-service validation) paused. This plan follows the CT plan's method
(`PLAN-CT-INSIGHTS.md`):
- evidence from prod (read-only);
- a design and questions for the user to agree;
- then phases with exit criteria;
- independent-SQL verification, rehearse → apply → verify, a Codex review
  per step, and a commit only when the user says so.

**Ground rules carried over:**
- The prod DB is read-only, apart from migrations the user applies with
  the §10 runner (`migrations/run.js`).
- `log.*`, `alert.*` and `fse_dispatch` are not touched.
- Don't touch `/home/prod/hhm_rpp_ge`; don't open or print any `.env`.
- Don't ask the user to judge scanner behaviour. Bring evidence and a
  recommendation; field service confirms later.

**Timing:** GE CT Phase 5 is in its monitoring window until 2026-11-12
13:00 UTC. Until then, CV work is limited to investigation, planning, and
new files that nothing in the CT run loads. Shared `insight/` code and
`index.js` change only after the CT Phase 5 close-out.

## 1. What the data supports (verified against prod, read-only, 2026-11-06)

### 1.1 Coverage: 2 systems send data today

| GE modality | In inventory | Configured to collect (`run_group` 1) | Log file current (changed ≤ 2 days ago) | Stale > 30 days | No folder / no file |
|---|---|---|---|---|---|
| CV/IR | 62 | 18 (19 with acquisition config) | **2** | 11 | 5 |
| MRI | 185 | 39 | 7 | 18 | 13 |
| CT | 120 | 75 | 27 | 30 | 17 |

- **Only SME02412 and SME08640 (both INNOVA 3100, `America/Los_Angeles`)
  have rows in `log.ge_cv_syserror`.** The table's data starts on
  2026-05-01:
  - SME02412: 86,729 rows on 156 days;
  - SME08640: 9,038 rows on 172 days.
- **The gap is upstream of this pipeline.** On disk
  (`/home/prod/hhm_data_acquisition/files/<id>/sysError.log`, checked
  with `stat` only), the 11 stale CV systems' files last changed between
  2025-01-20 and 2026-04-23. Seven of them stopped on 2026-02-05 / 02-06,
  which points to one collection-side event. Three systems have no folder
  and two have an empty folder. The collector is
  `~/hep3/hhm_data_acquisition`.
- **The user chose to build the CV pipeline now**, rather than look into
  collection first (2026-11-06). A CV report will cover 2 systems until
  collection is restored. Each system joins as soon as its file arrives;
  no code change is needed.

### 1.2 The source: `sysError.log`, a CSV error log

- **Ingested today** by `jobs/CV/sysError_parser.js` into
  `log.ge_cv_syserror`. It's the only CV file configured (`config.log`:
  `sysError` / `sysError.log` on 18 systems).
- **Columns:** `sequencenumber`, date, time, `subsystem`, `errorcode`,
  `errortext`, `exam`, `exceptioncategory`, `application`,
  `majorfunction`, `minorfunction`, `fru`, `viewinglevel`, `rootcause`,
  `repeatcount`, `debugtext`, `sourcefile`, `sourceline`.
- **It is an error log only.** It logs nothing on a normal procedure, so a
  quiet day has 8–50 rows. There are **no exams**: `exam` is always 0 or
  2222. There is **no tube counter** and no utilization, unlike CT.
- **Encoded fields:** `errortext`, `fru`, `majorfunction` and
  `minorfunction` are obfuscated by GE (e.g. `U0BbTTlUFn==`). They look
  like Base64, but decoding them gives no readable text. No repo under
  `~/hep3` decodes them.
- **Readable fields:**
  - `debugtext`: readable on 85–88% of rows (SME02412: 76,556 of 86,729;
    SME08640: 5,942 of 9,038); 192 of 204 codes have some readable debug
    text;
  - `sourcefile` and `sourceline`: 75 source files, e.g.
    `Z:/heroic/anticol_task.c`, `fpga_driver.cpp`;
  - `errorcode`, `subsystem`, `exceptioncategory` and `repeatcount`.
- **Subsystems:** `RTA` 68,193 rows, `POS` (positioner) 24,266, `DL `
  3,308. The `DL ` value keeps its trailing space from the source.
- **Exception categories:** `AR`, `DO`, `WR`, `IH`. Their meaning isn't
  documented here; field service to confirm.

### 1.3 What the readable text shows (top patterns, both systems)

| Code | Subsystem | What the debug text says | Rows | Days |
|---|---|---|---|---|
| 1200014 | RTA | `[FPGA_Driver::update] Detector com error: …` | 39,714 | 13 (SME02412) |
| 1200019 | RTA | `[Apollo_Camera::_OffsetFactoryTask] mean value for offset …` | 11,326 | 12 |
| 1050710 | POS | `Table: lateral axis encoder, potentiometer failure, TBL LAT out of range` | 5,331 (2,679 after removing RTA relays, §6.1) | 60 |
| 1050168 / 1050170 | POS | `LIFT COLLISION` / `COLLIMATOR COLLISION` | 4,271 / 2,917 | 288 / 288 (system-days, both) |
| 1050302 / 1050143 / 1050144 | POS | `ANTICOLLISION CINEMATIC ERROR …` | 2,799 / 2,028 / 957 | 161 / 25 / 15 |
| 1050297 | POS | `Emergency backout has been pressed / released`; `Rack has been resetted for a PIB loss of communication` | 2,502 | 231 |
| 1050024 | POS | `PIB : COM Reset` | 1,302 | 7 |
| 2800176 | DL | `Dose Export logger … Association rejected` | 1,242 | 293 |
| 2800036 | DL | `Internal Error, 1206 : BROWSER_NETWORK_FAILED` | 634 | 192 |

**Error storms:** SME02412 had more than 1,000 rows on at least 15 days
(the probe listed the top 15). The largest were 16,183 rows on 2026-07-11
and 15,049 on 2026-10-20.

### 1.4 Data quality

- **No duplicate re-ingestion:** no `(system, sequencenumber,
  host_datetime, errorcode)` key appears in two captures.
- **Sequence numbers are open (to investigate first, §3 Q2).**
  `sequencenumber` runs 1..~3,999 and resets.
  - Ordered by device time, SME02412 has 237 backward steps (most are
    small, e.g. 1609 → 1603), 469 jumps and 5,456 missing numbers; 45
    jumps fall between captures. SME08640 has 25 backward steps, 41
    jumps and 68 missing numbers.
  - The small backward steps suggest records timestamped out of order,
    perhaps by subsystems with their own clocks. Some resets come
    mid-cycle (601 → 1), which may mean a file rotation.
  - Lost records at rotation is the failure CT had (CT plan §11); the CV
    parser has none of CT's Phase 1b protections (`gesys_head`,
    `drop_already_ingested`).
- **Device clock:** SME02412 runs ahead of capture time by about 34–114
  minutes (p90–p10). SME08640 is within about ±14 minutes.

### 1.5 The `insight` schema today

- **CT-named tables:** facts, daily, exams, tube, capabilities and clock
  (`insight.ge_ct_*`), with the `api.ge_ct_*` views.
- **Shared:**
  - `insight.metric_catalog`: no source column; categories `utilization`,
    `tube`, `reliability`, `compliance`, `environment`, `inventory`;
  - `insight.findings`: `source` defaults to `'ge_ct'`, with no check
    constraint, so `'ge_cv'` fits;
  - `insight.finding_catalog`;
  - `insight.schema_migrations`.

## 2. Proposed design

1. **Same architecture as CT:** extract → daily → findings → `api`
   views → viewer. Each step is a pure core with tests, and gets
   independent-SQL verification and a Codex review.
2. **Own CV tables, one new migration** (007, in the 001–006 style, views
   and tables only, applied by the user):
   - `insight.ge_cv_facts`: one row per (`sysError` row × metric);
   - `insight.ge_cv_daily`: per device day × metric × dim;
   - `insight.ge_cv_capabilities` (or a view);
   - `api.ge_cv_*` views.

   CV uses the shared metric catalog (keys `cv.*`), finding catalog and
   findings table (`source = 'ge_cv'`). No CT table changes.
3. **Metrics** (catalog v1, from §1.3). Every row of `cv.error` carries
   the error code as its `dim`, plus subsystem and category. Named event
   metrics come from code plus readable debug text or source file:
   - detector communication error;
   - positioner collision (lift, collimator) and anticollision error;
   - table encoder / potentiometer failure;
   - PIB communication loss or reset;
   - emergency backout;
   - DICOM dose-export rejection;
   - network failure.

   No metric depends on the encoded fields. Every source row maps to one
   rule or to a reviewed "ignore" list, the same coverage rule as CT
   Phase 2.
4. **Code labels.** For each error code, the label is its most common
   readable debug text (with `sourcefile`). It's a derived table built
   from the data, not a decoding of GE's encoded text.
5. **Findings v1** (candidates; thresholds from the data, tuned later):
   - error storm (a day far above the system's own baseline);
   - recurring detector communication errors;
   - recurring positioner collisions / anticollision errors;
   - a persistent table encoder / potentiometer warning;
   - PIB communication loss;
   - dose-export failures over several days.

   The same open/resolve state machine and replay as CT.
6. **Viewer:** a "GE CV Insights — Internal" page, built with the CT
   viewer's modules and checks:
   - an errors-by-code panel with the derived labels;
   - positioner, detector and connectivity panels;
   - a daily error / storm timeline.

   There is no utilization or tube panel, because the data has none.
7. **Stage:** the CV steps run after `ge_cv_parsers` in `index.js`,
   behind the same kill switch as CT. This is built only after the CT
   Phase 5 close-out.

## 3. Questions for the user (answered 2026-11-06: the recommendation in each)

1. **The encoded text fields: AGREED, don't decode.** Recommended: don't attempt to decode GE's
   obfuscated `errortext` / `fru` / `majorfunction`. Use the error code,
   the readable debug text and the source file (§2 item 4). Decoding a
   vendor's deliberately encoded service data is a licensing question,
   not an engineering one. If Avante has GE service documentation that
   maps the codes, that is the clean source.
2. **Ingest integrity first (CV-1b), before any metric: AGREED.** Recommended:
   - explain the sequence resets, jumps and out-of-order timestamps
     (§1.4) from the parser code and the raw files;
   - prove whether records are lost at file rotation;
   - if they are, fix the parser the way CT Phase 1b did.

   Counts built on a lossy ingest would be wrong without anyone noticing.
3. **Scope with 2 live systems: AGREED, the full pipeline, no backfill.** Recommended: build the full pipeline
   for whatever reports, with no backfill from the stale files on disk
   (that would write to `log.*`). Restoring collection stays a separate
   task outside this plan; the coverage numbers in §1.1 are the starting
   list.
4. **The viewer: AGREED, a separate CV page.** Recommended: a separate CV page that reuses the CT
   viewer's modules, rather than adding CV to the CT page now. A combined
   "GE Insights" page can come later.

## 4. Proposed phases

| Phase | What | Exit criteria |
|---|---|---|
| **CV-0 Decide** ✅ 2026-11-06 | This plan; the user's answers to §3 | Agreed |
| **CV-1b Ingest integrity** — investigated 2026-11-06 (§5); D1–D6 agreed; all fixes deployed 2026-11-06/09 (parser D1+D5, collector D3a+D5), 361-record backfill (D6) applied 2026-11-09; sign-off after the first rotation (§5.5) | Sequence / rotation / ordering investigation of `sysError` ingestion (read-only); a parser fix if records are lost (reviewed, rehearsed, deployed by the user) | Cause of every sequence gap class explained; no record loss going forward, shown on raw file snapshots |
| **CV-1 Schema** ✅ applied 2026-11-12 15:23 UTC (§7) | Migration 007: CV tables and `api.ge_cv_*` views; runner pre-checks, dry run, roundtrip; the user applies it | Applied; catalog unchanged outside the new objects |
| **CV-2 Extract** ✅ backfill applied 2026-11-12, 142,004 facts (§8) | CV rule registry, extract and backfill from `log.ge_cv_syserror` (read) into `insight.ge_cv_facts` | Per system and metric, counts exactly equal independent SQL; every code covered by a rule or the reviewed ignore list |
| **CV-3 Derive** ✅ applied 2026-11-12 (§9) | Daily, capabilities, clock offsets, code labels | Independent SQL equal |
| **CV-4 Findings** ✅ 008 + replay applied 2026-11-12, 13 findings (§10) | Rules, replay, `verify-findings` for `ge_cv` | Independent SQL equal; findings reviewed with evidence |
| **CV-5 Prod** | Stage after `ge_cv_parsers`, kill switch, rehearsal, deploy, 7-day monitoring | As CT §15.4 |
| **CV-6 Viewer** | "GE CV Insights — Internal" | As CT §16.4 |

Checkpoints for the user's go-ahead: the answers to §3; before each
migration is applied; before any `index.js` / parser change; before each
deploy; before every commit, in either repo.

## 5. CV-1b — ingest integrity (investigated 2026-11-06)

Everything below is read-only:
- the prod DB through the read-only connection;
- prod Redis with `GET` / `INFO` only;
- `stat` and reads of `/home/prod/hhm_data_acquisition/files/<id>/sysError.log`;
- the 194 raw snapshots in `log.saved_files` (2026-11-04 12:48 → 11-06 12:48 UTC; 97 per system).

`/home/prod/hhm_rpp_ge` was not read. The probes are in the session
scratchpad, not in the repos.

### 5.1 How the file and the ingest work

- **The file.** `sysError.log` is a CSV with a header line and
  `\n` line ends. GE appends to it, and the records are in
  `sequencenumber` order.
  - GE starts a **new file at sequence 1**; it does not carry over a tail
    the way CT gesys does (§11 of the CT plan).
  - The highest number is **4000**: seen in `archive_log`; the live table
    has 3999 (SME08640) and 3998 (SME02412).
  - Files end between 158 KB and 1.36 MB, so rotation is not by size.
- **Collection.** `hhm_data_acquisition`'s `ge_cv` job (`ge_cv_21.sh`,
  `lftp mget` with `xfer:clobber`) downloads the **whole file** at :00 and
  :30. `stats.job_runs` shows every run since March finishing within 86 s.
  The download is written progressively: on 2026-11-06 at 13:00:15 the
  local file was 798,720 of 920,604 bytes, on a new inode.
- **The parser.** `GE_CV` runs at :18 and :48, so it never overlaps the
  download.
  - It keeps a byte watermark in Redis (`<sme>.sysError.log`): the file
    size, measured **again after the insert**.
  - It reads `tail -c delta` when the file grew, and the whole file when it
    shrank or has no key.
  - It has no duplicate guard and no rotation check.
- **Current state.** Both prod watermarks equal the file sizes
  (920,604 / 18,085). Prod Redis uptime is 526 days.
- **Byte-exact check.** The DB rows rebuild the raw lines byte-for-byte:
  all 2,978 + 83 lines of the current files. The rebuilt file sizes
  (905,366 and 920,604) equal the snapshot sizes. This allows byte-level
  reasoning about older files whose snapshots are gone.

### 5.2 Every class of sequence gap, explained

The §1.4 counts were taken **in device-time order**. Re-run that way they
reproduce exactly (SME02412: 469 jumps, 5,456 missing, 45 between
captures). Ordered by insertion (`id`, which is file order), they almost
all disappear.

| Class | What it looks like | Cause | Records | Fixable in the parser |
|---|---|---|---|---|
| **G1 Out-of-order timestamps** (not loss) | §1.4's small backward steps (1609 → 1603) and most of its jumps | GE writes records in sequence order, but the time stamped on a record can be earlier than the previous record's: 233 / 23 times, p50 93 ms, max 28 s, within one subsystem as well as across RTA / POS / DL. Sorting by device time interleaves them. In file order, SME08640 has **no gap at all** outside resets. | 0 lost | n/a: order by `id` / sequence within a file, never by device time |
| **G2 Reset to 1** (not loss by itself) | 26 (SME02412), 3 (SME08640) | GE started a new file. After record 4000, or earlier: 601, 1416, 1990, 2113… These early resets cluster in storms. Two early files end on `User has requested Shutdown.` and the next starts with `Positioner CPU Boot Up`, but restarts inside a file also occur, so a restart is not always the trigger. **The trigger for the other early resets is unknown** (field service). | 0 | n/a |
| **G3 Old file's last records never fetched** (loss, collection side) | A file ends at seq < 4000 | Records written to the old file after its last 30-min download and before GE switches to the new file. The collector only fetches `sysError.log`. | Certain: **5** (SME08640 3999 → 1 and 3998 → 1: 1 + 2; SME02412 3998 → 1: 2). Unknown for the early resets; upper bound 16,505 + 18 if every one was a 4000-rotation, which the shutdown-ended files and quiet gaps argue against | **No.** Only if GE keeps the previous file on the device (§5.5 D3) |
| **G4 New file outgrew the watermark** (loss, parser) | 2026-07-10: 3831 → **3012** (backward, new data); 2026-09-18: 584 → **668** | The CT §11.1 edge. A new file passed the old byte watermark before the next run, so `tail -c delta` read only its end. The first line read was a fragment and was dropped. On 09-18 a same-file gap is impossible: a tail from the old watermark would start exactly at record 585. | **3,678**: 3,011 + 667 | **Yes** (§5.3) |
| **G5 Batch-boundary record** (loss / corruption, parser) | 35 single gaps at capture boundaries; 3 records stored with a cut sequence number: 1052 as **52**, 2200 as **200**, 1233 as **233** (§1.4's "+1000/+2000 jumps") | All during the SME02412 storms (07-10/11, 10-20). The watermark (= file size) included bytes after the last newline, so the next read started inside the first record of the new batch. A fragment fails the regex (lost); a cut that removes only digits of the sequence number still matches. | **35 lost, 3 wrong** `sequencenumber` | **Yes** (§5.3) |

Not found:
- duplicate re-ingestion: 0 of 95,767 rows (rebuilt lines);
- a parser run reading a half-downloaded file: no overlap with the
  collector in `stats.job_runs`;
- a Redis reset;
- truncated-last-field rows at batch ends: 0;
- partial lines in the 48 h of snapshots: all 194 end with `\n`, and 191
  of 192 consecutive pairs are byte prefixes (the exception is the
  SME08640 rotation on 2026-11-05 01:48).

What G5 leaves open:
- The cut record carries the **next** burst's timestamp, so the extra
  bytes in the earlier copy were not the start of that record. They were
  bytes GE later overwrote: padding, or an abandoned partial line.
- Which of the two can't be told without the parser's "NO MATCH FOUND"
  log lines, which are in the prod run logs (not read).
- The fix covers both: the simulation's "prefix" and "NUL" variants
  in §5.4.

**Storm bursts follow our collection.** On storm days each 30-min batch
is about 100 records over about 45 s of device time. The last record sits
at a constant offset before the capture: 56.1–56.2 min on 07-11 and
120.6–120.8 min on 10-20 (the device clock offset), across many hours.
So SME02412 wrote these bursts in step with our 30-min collection cycle.
This is evidence for field service, not a conclusion about the device.
CV-4's storm finding must not count these collection-locked bursts as
independent events without looking.

**Totals in `log.ge_cv_syserror`** (2026-05-01 → 11-06):
- **3,718 records proven lost**, all on SME02412 except 3 on SME08640:
  - G4 3,678;
  - G5 35;
  - G3 5.
- **3 rows have a wrong `sequencenumber`.**
- An unknown number are missing at early resets (G3).

`log.*` is not touched. These stay as known gaps (§5.5 D2).

### 5.3 Proposed parser fix (built on dev 2026-11-06, uncommitted, not deployed)

CV-only files. Nothing the CT run loads changes:
- `acquisition/GE_CT_CV_MRI.js`, `redis/redisHelpers.js`, `index.js` and
  `insight/` are untouched;
- the CV parser stops calling the shared size / tail / update methods.

| File | What |
|---|---|
| `read/syserror_file.js` (new) | `open_syserror`: size, first data line and bytes from **one file descriptor**. `plan_read`: append, `no_new_data`, `shrunk`, `new_file` (first data line changed: the G4 fix), `no_watermark`. `complete_lines`: the watermark advances **only to the end of the last complete line**, and a trailing partial line is read next run (the G5 fix) |
| `persist/drop_already_ingested_cv.js` (new) | The CV twin of CT's `drop_already_ingested`. Drops parsed records already in the table (all 18 parsed columns, compared as text; integer columns normalised; range scan on `(system_id, host_datetime)`). Fails open. Makes every whole-file read (new file, short copy, lost key, retry after a failed insert) harmless |
| `jobs/CV/sysError_parse.js` (new) | The per-line parse moved out unchanged, so tests and the simulation run it. `host_datetime` calls `dateTimeTemplate` with `generateDateTime`'s CV pattern and zone directly |
| `jobs/CV/sysError_parser.js` | Wires them together. The Redis watermark key and format are unchanged (a byte offset); new key `<sme>.sysError.log.head`. The order stays parse → insert → watermark → `offline_hhm_conn`. No insert when nothing is new. Logs say why a whole file was read and how many rows were dropped |
| `test/syserror_file.test.js`, `test/drop_already_ingested_cv.test.js`, `test/sysError_parse.test.js` (new) | `node --test test/`: all files pass |

Codex review (`REVIEW-CV1B-PARSER-CODEX.md`, 2026-11-06): one P3 finding,
fixed the same day. A file that keeps ending without a newline warned on
every run. Now `read/syserror_file.js` `partial_tail` warns only when new
complete lines came with the partial line (the G5 shape); a lone pending
partial line is logged as info. Tests pass, and the read-only rehearsal
is unchanged.

Behaviour on normal input is identical: the same rows, and the same
watermark (the file always ends in `\n`). The only visible difference is
that the empty string after the last newline of every incremental read is
no longer logged as `NO MATCH FOUND`.

### 5.4 Simulation on real snapshots and the prod rehearsal

`OLD` is an exact emulation of today's parser. `NEW` is the dev modules.
Truth is the device's complete lines.

| Scenario (real bytes) | OLD | NEW |
|---|---|---|
| S0 Replay of every capture in `log.saved_files` (96 + 96, incl. the SME08640 rotation) | = DB rows for all 192 captures | = DB rows for all 192; `host_datetime` equal on all 288 rows; final watermarks equal |
| S1 Copy ends 1 complete new record + k bytes of the next (every k, every real growth step; 8,530 cuts) | prefix bytes: **8,487 lost, 403 wrong**; NUL bytes: **8,530 lost** | 0 lost, 0 wrong |
| S2 New file outgrew the watermark (SME02412 1..3831 → a 1..3984 file, rebuilt) | **3,012 of 3,984 lost**: reads from record 3013, as on 07-10 (3012) | 0 lost |
| S3a Short copy (< watermark), then the full copy (47 steps) | **115,016 rows re-inserted** | 0 |
| S3b Copy cut inside the new data, then the full copy (47 steps) | **35 lost, 1 wrong** | 0 |
| S4 Redis key lost | whole file re-inserted (2,978 / 83) | 0 re-inserted |

**Prod rehearsal (read-only, 2026-11-06 ~13:20 UTC):**
- With the current watermarks, both systems plan `no_new_data`.
- A forced whole-file read parses 2,978 and 83 rows. The duplicate guard
  finds **every one already in the table**: would insert 0, 2.4 s for
  SME02412.
- The first live run after a deploy stores the `.head` key and otherwise
  behaves as today.

### 5.5 Decisions (agreed 2026-11-06: the recommendation in each)

- **D1 Parser fix: AGREED, adopt it.** It closes G4 and G5 and makes
  whole-file reads safe.
  - Next: Codex review (`REVIEW-CV1B-PARSER-HANDOFF.md`), fix, commit
    (ask), then deploy when the user says.
  - `npm run ge_cv` is its own cron process; the CT run doesn't load these
    files.
  - Rollback is `git revert`. The extra Redis key is ignored by the old
    code.
- **D2 Existing gaps: AGREED, leave them.**
  - The lost records can't be recovered, and `log.*` is not touched.
  - CV-2+ treats `sequencenumber` as a within-file order only, never as a
    count, and documents the 3,718 lost and 3 wrong-sequence rows (all
    before the fix).
- **D3 Collection side (`hhm_data_acquisition`, separate repo): AGREED.**
  - (a) Download to a temporary name and `mv` it into place (= CT §11.4
    step 3).
  - (b) Take a one-time read-only `ls` of `.../DL/Log/` on the two devices
    to see whether GE keeps the previous `sysError` file. If it does,
    fetching it would close G3; if not, G3 stays bounded by the 30-min
    collection interval.
  - (a) Built 2026-11-06, uncommitted, on `hhm_data_acquisition` branch
    `DEV`: the five CV scripts in use (`ge_cv_21.sh` FTP, 12 systems;
    `ge_cv_22*.sh` scp, 7). Each downloads to `.sysError.log.part` in the
    system folder and `mv`s it over `sysError.log` only when the transfer
    exits 0; otherwise the temp file is removed. Review round 1
    (`REVIEW-CV1B-COLLECTOR-CODEX.md`, P2: overlapping runs shared the temp
    name) is fixed: the temp name is per run (`.sysError.log.part.$$`), an
    EXIT trap removes it, and leftovers older than 2 h are swept. Exit status and output
    are the transfer's own (`mget:` becomes `get:` in lftp messages; no
    connection regex reads that prefix). `ge_cv_sftp.sh` is unused and
    left as is. Tested locally: lftp against a `file:` remote, scp with a
    fake `sshpass`. Results are in `REVIEW-CV1B-COLLECTOR-HANDOFF.md`.
  - (b) The listing needs device credentials, which only the collector
    decrypts (its `.env`). The user runs the command and pastes the
    output.
  - **(b) Result, 2026-11-09: GE keeps exactly one previous file,
    `DL/Log/sysErrorPrev.log`.** The user ran the listing and fetched both
    `sysErrorPrev.log` files to `/tmp/cv_d3b/` (read-only on the devices).
    - The Prev file's timestamp equals the rotation moment. SME08640:
      Nov 4 17:53, and the current file's seq 1 is 17:53:12.
    - Both Prev files hold exactly 4,000 records and end on a newline.
      Nothing older survives; the only other `*Prev*` / `.bkp` files
      belong to other logs.
    - Checked byte for byte (scratchpad `prev_verify.js`): the stored
      rows of each previous file equal the first N lines of
      `sysErrorPrev.log`. The unread tail is not in the DB anywhere and
      parses cleanly (0 unmatched, 0 datetime null).

      | System | Stored (prev file) | Stored part ends at byte | Unread tail (G3) |
      |---|---|---|---|
      | SME02412 | seq 1–3654 | 1,236,666 | **seq 3655–4000, 346 records**, 2026-10-20 16:44:25–16:46:42 local (a storm, then rotation) |
      | SME08640 | seq 1–3985 | 905,366 (= the watermark before rotation) | **seq 3986–4000, 15 records**, 2026-11-04 17:39:47–17:53:11 local |
    - So G3 is **recoverable going forward**: the old file's tail is on the
      device until the next rotation (days at least; we collect every
      30 min).
    - It is recoverable **once** for these two latest rotations (361
      records). Earlier rotations are gone; the upper bound in §5.2
      stands for them.
    - The stored part ends exactly at the old watermark (SME08640:
      905,366). A parser that sees `new_file` can therefore read
      `sysErrorPrev.log` from the stored watermark, when that file's first
      line equals the stored `.head`, and get exactly the missing tail.
  - **D5 and D6 AGREED by the user 2026-11-09.** Built the same day,
    uncommitted. Codex review `REVIEW-CV1B-PREV-CODEX.md`: one finding, P2 (the backfill could race concurrent inserts), fixed with an in-transaction re-check under an advisory lock and by refusing `--apply` around the parser's :18/:48 runs:
    - **Parser:** `plan_prev_tail` plus the rotation path in
      `jobs/CV/sysError_parser.js`.
    - **Collector:** the five `ge_cv` scripts also fetch
      `sysErrorPrev.log`.
    - **Backfill:** `maintenance/backfill_ge_cv_prev_tail.js`.
    - **Rehearsed read-only on the two real rotations:** D5 would insert
      exactly the tails (346 / 15); D6 plans the same and refuses bad
      inputs.
    - **Evidence copies with checksums:** `~/cv_d3b_evidence/`
      (matt-teixeira) and `/tmp/cv_d3b/` (prod).
    - **Urgency:** SME02412 is at seq ~3000 of 4000. Its next rotation
      overwrites the device's `sysErrorPrev.log`; the copies above are
      unaffected.
  - **Deployed and applied 2026-11-09.** Pushed 13:59 UTC
    (`hhm_rpp_ge` 0b6fa11, `hhm_data_acquisition` da90c48); the user
    pulled both at 14:00:51.
    - **D6 backfill:** dry runs matched the rehearsal. APPLY committed
      346 rows (SME02412 seq 3655–4000) and 15 rows (SME08640 seq
      3986–4000) at 14:03 UTC.
      - Verified read-only (scratchpad `backfill_verify.js`): every one of
        the 4,000 lines of each `sysErrorPrev.log` is in
        `log.ge_cv_syserror` exactly once.
      - A re-run refuses ("nothing to insert"), and the exit check still
        passes.
      - G3 is now closed for these two rotations. Earlier rotations stay
        lost (§5.2 bound).
    - **D5 collector:** the 14:30 run fetched `sysErrorPrev.log` for both
      systems, byte-identical to the evidence copies and with the device
      mtime kept. Both runs succeeded with no output; no temp files are
      left.
    - **D5 parser:** first exercised at the next rotation (SME02412 is at
      seq ~3000). The daily exit check watches for it.
    - **Exit check, kept outside the repos:** `~/cv_d3b_evidence/tools/`
      (matt-teixeira):
      ```
      node verify_cv1b.js --since 2026-11-06T17:24:00Z
      ```
      It is read-only and accepts lines from `sysErrorPrev.log` (D5/D6).
      It also holds `backfill_verify.js`, `prev_verify.js`, `recon.js` and
      `runlog.js`.
      - 2026-11-09 14:50 UTC: both systems ok. In the window, SME02412 has
        349 rows (346 from Prev) and SME08640 33 (15 from Prev); 0
        missing, duplicated or stray.
    - **CV-1b status: all fixes deployed.** Exit criteria:
      - "every gap class explained": met;
      - "no record loss going forward": met for G4/G5/G3 by design and
        rehearsal. To be **signed off after the first real rotation** on
        SME02412 or SME08640 passes the exit check with D5's tail
        recovery in the logs (`ge_cv_sys_error: prev tail`).
  - **Decisions as proposed:**
    - **D5:** close G3 going forward.
      - Collector: also fetch `sysErrorPrev.log`, with the same
        temp-and-rename.
      - Parser: on `new_file`, if Prev's first line equals the stored
        `.head`, read Prev from the stored watermark first. The duplicate
        guard stays.
    - **D6:** one-off backfill of the 361 tail records from
      `/tmp/cv_d3b/`. Same parser and duplicate guard; rehearsed
      read-only; run by the user on prod. This revisits D2, which assumed
      the gaps were unrecoverable.
- **D4 Field service: AGREED, raise it.** SME02412's storm bursts are
  locked to our collection cycle (§5.2), and the trigger for early resets
  is unknown. Draft note for field service:

  > SME02412 (INNOVA 3100): on the error-storm days 2026-07-10/11 and
  > 2026-10-20, its sysError log filled in bursts of about 100 records
  > (mostly `FPGA_Driver::update Detector com error`) over about 45
  > seconds, every 30 minutes, at the same moment in each of our
  > collection cycles. We download the log by FTP every 30 minutes. Could
  > you check whether the FTP session coincides with, or causes, the
  > detector communication errors? Separately: SME02412 starts a new
  > sysError.log well before its 4000-record limit (e.g. after 601, 1416,
  > 2113 records). Do you know what triggers that, and does the system
  > keep the previous file?
  >
  > Two more questions on SME02412 (added 2026-11-09, M4):
  > 1. From 2026-09-11 to 09-18 its positioner logged repeated PIB
  >    communication resets and failures, board failures (SMA / MCB /
  >    stepping board) and "Operating System Fail". Was there a service
  >    visit or a part replaced around then?
  > 2. A lateral table potentiometer warning (error 1050710) was logged
  >    on every working day from 2026-05-01 to 05-27 (30–350 a day), then
  >    only occasionally. Was the sensor repaired or replaced around
  >    2026-05-28? (§10.1)
  >
  > A question on both SME02412 and SME08640 (added 2026-11-10, F3):
  > 3. Their dose-export logger reports "Association rejected"
  >    (MC_ASSOCIATION_REJECTED) about 4 times a day on nearly every day
  >    since May. Is a dose-export destination configured on these
  >    systems, and are their dose reports being rejected?
  >
  > Added 2026-11-12, at the CV-4 apply:
  > 4. On 2026-11-11 (08:13–22:33 device time), SME08640 logged 767
  >    errors against its usual ~35 a day: 644 "COLLIMATOR COLLISION"
  >    and 91 "LIFT COLLISION". Was there a collision, a sensor fault or
  >    a service visit that day?
  > 5. The device clocks run ahead of real time: SME02412 by about
  >    1h50–2h (34–114 min on 11-09), and SME08640 by up to ~25 min.
  >    Can the clocks be set (or synced to NTP)?
- **Optional confirmation of G4 / G5.** The prod run logs of 2026-07-10
  23:48, 2026-07-11 06:18 and 2026-09-18 19:18 UTC (if still kept) should
  each hold a `NO MATCH FOUND` fragment line. For example:
  `grep -l '"NO MATCH FOUND"' /home/prod/hhm_rpp_ge/utils/logger/hhm_rpp_ge-log.prod.*`
  over the runs of those times.

**D1 status: DEPLOYED 2026-11-06.** `b0bc513` was pushed to
dev/staging/prod at 17:24:57 UTC, and the user pulled on prod right after.
The first run on the new code was 17:48 UTC: both systems were checked
and the exit check passed (`--since 2026-11-06T17:24Z`).
- Neither device has written to `sysError.log` since 2026-11-05 (~18:55
  and ~18:21 UTC), so that run read nothing. As designed, it returned
  before storing `<sme>.sysError.log.head`.
- The key is stored on the first run that reads new lines. Until then the
  new-file check falls back to the size check, as before.
- Residual risk in that window: GE starts a new file before writing any
  line to the current one, and that file outgrows the watermark
  (SME02412 920,604 B; SME08640 18,085 B) before a parser run sees it.
- 18:18 UTC: SME08640 read 5 new lines (seq 84–88, `append` from 18,085
  to 19,312). Its `.head` key is now stored and verified equal to the
  file's first line; the exit check passes.
- **2026-11-09 12:51 UTC check (`--since 2026-11-06T17:24Z`): both
  systems pass**, 97 snapshots each, 0 missing / duplicated / stray, and
  both `.head` keys are set and equal to the file's first line.
  - New rows since the deploy are contiguous: SME02412 seq 2979–2999
    (21 rows), SME08640 seq 84–138 (55).
  - Run logs (135 GE_CV runs): 20 reads with new lines, all inserts
    successful, no errors, no full re-reads, no unmatched lines, no
    duplicate drops.
  - No new GE file and no storm in the window yet, so G4/G5 are not
    exercised.
- **2026-11-09 ~13:00 UTC: follow-up `8c0d130` and collector `a5713d9`
  deployed** (the user pulled both on prod).
  - Collector run 13:00: SME02412 and SME08640 succeeded with no output;
    no `.sysError.log.part*` left in any `files/<sme>/`.
  - Parser run 13:18: all 13 CV systems with a file stored `.head`
    (sequence 1, equal to the file's first line); the 5 without a file no
    longer read Redis; the exit check passes.
  - The 11 `getRedisLine` warnings in that run were the last: every key
    is now set.
- The prod run logs showed that idle systems (12 of the 13 CV systems with
  a file) never get the key, and that `getRedisLine` warns every run for
  every system without it.
- **Follow-up (CV-1b-head):** store the key on runs that insert nothing,
  when the watermark already refers to this file. Read Redis only after
  the file check.
  - Built on dev and tested; read-only rehearsal on prod state clean.
  - Review: `REVIEW-CV1B-HEAD-HANDOFF.md`.

**Deploy steps (done):**
1. `git push origin dev dev:staging dev:prod`.
2. The user pulls in `/home/prod/hhm_rpp_ge`. `npm run ge_cv` is a
   short cron process, so the next :18/:48 run uses the new code; no
   restart is needed.
3. The first run that reads new lines stores `<sme>.sysError.log.head`;
   otherwise it reads as before.

**Verify** (read-only probe `verify_cv1b.js`, session scratchpad). For
each saved snapshot it checks:
- every complete data line is in `log.ge_cv_syserror` exactly once;
- no row captured in the window is missing from every snapshot;
- the Redis watermark sits on a line boundary;
- the `.head` key equals the file's first data line.

Baseline 2026-11-06 15:48 UTC, before the deploy: **both systems pass**
(97 + 97 snapshots, 0 missing, 0 duplicated, 0 stray). After the deploy,
run it daily with `--since <deploy time>` until a new file (G2) or a storm
has gone through the window. That is the evidence for "no loss going
forward".

**CV-1b exit criteria:**
- "Cause of every sequence gap class explained": met. G5's trailing-byte
  origin is open, but it doesn't change the fix.
- "No record loss going forward, shown on raw file snapshots": met for the
  parser classes (G4, G5) once D1 is deployed. **G3 cannot be closed by
  the parser**; it needs D3(b), or the user's acceptance of the residual.

## 6. CV-2 groundwork: error-code inventory and proposed mapping (2026-11-09, read-only)

**Evidence:**
- All 96,204 rows of `log.ge_cv_syserror` (SME02412 87,096; SME08640
  9,108), device days 2026-04-30 → 11-08.
- Only non-encoded columns were read: code, subsystem, category, debug
  text, source file, `repeatcount`, sequence and time.
- The per-code tables (all 204 codes, grouped by proposed class) are in
  `PLAN-CV-INSIGHTS-CODES.md`. The probe scripts are in
  `~/cv_d3b_evidence/cv2/`, outside the repos.

### 6.1 What the inventory shows

- **204 codes:** SME02412 has 193, SME08640 105. Subsystems are RTA / POS /
  DL; categories AR / DO / WR / IH.
- **RTA relays double the positioner errors.** 11,878 rows (12.3%) are
  RTA relaying an error first logged elsewhere. Every one has subsystem
  `RTA`, source file `XRImChainPos` and debug text `(null)`; no other
  row has that combination.
  - 98% (11,625) follow a same-code original within the previous 30 rows
    of the file. The device-time lag has a median of 44 ms.
  - The rest fall in storms or after the known gaps (§5.2).
  - Counting both would double count, e.g. 1050710: 2,679 originals and
    2,652 relays.
  - One code, 1050141, appears only as a relay (1 row).
  - Most of the "unreadable debug text" in §1.2 is these relays. Without
    them, only 13 codes (855 rows) have no readable text at all.
- **`repeatcount` is a running index, not a count of suppressed repeats.**
  - In file order, 14,797 of the 14,817 non-zero values are the previous
    same-code, same-text row's value + 1 (0, 1, 2, …). Each repeat is its
    own row.
  - So the event count is the row count, and summing `repeatcount` counts
    nothing.
  - The "repeats 121,445" for 1050710 in §1.3 was that sum (corrected
    there).
- **One code can carry several events, so named metrics need the debug
  text.** 1050297 (2,506 rows) holds:
  - "Emergency backout has been pressed" / "released": 724 + 724;
  - "Rack has been resetted for a PIB loss of communication": 730;
  - other rack resets (TSSC, SmartBox/SmartHandle, MCB, capacitive
    sensor, PST request, ALMA near-collision, the safety task): about 170;
  - "Positioner CPU Boot Up": 151.
- **Pairs that are one event:**
  - Every "PIB : COM Reset" (1050024) has a "Rack has been resetted for
    a PIB loss" (1050297) 10 ms later: 730 of 730, both ways.
  - Backout pressed and released pair 1:1, median 374 ms apart.
  - 226 of 247 "COLLISION SENSOR ACTIVATED" (1050167) rows come within
    2 s of a lift collision (1050168).
- **SME02412 has two storm types:**
  - Detector storms: 1200014 detector com error and 1200019 detector
    offset out of limits, on 11 shared days. The top days are 07-11
    (16,183 rows), 10-20 (15,395) and 07-10 (7,937).
  - A positioner episode on 2026-09-11 → 09-18: PIB COM reset / fail,
    SMA/MCB/stepping board PRD failures, 1050171 "Operating System
    Fail", and 1050177 anticollision errors on the front axes.
- **§2's "network failure" is the DICOM modality worklist query.**
  2800036 `BROWSER_NETWORK_FAILED` and 2800175 `BROWSER_WL_QUERY_FAILED`
  both come from `MwlDJRLogger.cxx`.
- **A natural key exists in today's data.** (system_id, host_datetime,
  sequencenumber) is unique over all 96,204 rows, and no key column has a
  null. It is not unique by construction (DST fall-back hour + a file
  reset), so the facts key on the source row instead (§7.6).
- **Debug-text templates are generic software messages.** No hostnames,
  addresses, AE titles or patient data were found in the 334 distinct
  templates, so the code labels can live in the repo and the DB.

### 6.2 Proposed mapping

Per source row, in order:
1. **RTA relay** (subsystem `RTA` and source file `XRImChainPos`):
   ignored, no fact. 11,878 rows.
2. **Every other row:** `cv.error`, with dim = the error code and attrs
   `repeatcount`, `sourcefile`, `sourceline`. 84,326 rows, 203 codes.
3. **Plus at most one named metric,** matched on code + debug text. No
   row matches two.

| Metric (§2 item 3) | Codes and match | Dim | Rows SME02412 | Rows SME08640 | Sys-days | Category |
|---|---|---|---|---|---|---|
| `cv.detector_com_error` | 1200014, 1200114 "Detector com error" | detector operation (5) | 40,007 | 6 | 31 | reliability |
| `cv.positioner_collision` | 1050168 LIFT, 1050170 COLLIMATOR | lift / collimator | 2,289 | 1,828 | 322 | reliability |
| `cv.anticollision_error` | 1050142–1050145, 1050301–1050302 "ANTICOLLISION CINEMATIC ERROR"; 1050177 "Anticollision error on axis" | axis (10) | 4,139 | 1,185 | 202 | reliability |
| `cv.table_encoder_failure` | 1050709 / 1050710 / 1050711 potentiometer; 1050182 longitudinal; 1050187 / 1050188 rotation | axis (4) | 2,934 | 38 | 94 | reliability |
| `cv.pib_com_loss` | 1050024 "PIB : COM Reset / Fail" | reset / fail | 779 | 0 | 7 | reliability |
| `cv.emergency_backout` | 1050297 "Emergency backout has been pressed" | — | 269 | 455 | 213 | reliability |
| `cv.dose_export_rejected` | 2800176 "Association rejected" | — | 531 | 719 | 296 | compliance |
| `cv.worklist_query_failed` (§2's "network failure") | 2800036, 2800175 | network_failed / wl_query_failed | 358 | 319 | 198 | reliability |

**Totals:** 140,182 facts, of which 84,326 are `cv.error` and 55,856 are
named.

**Coverage (CT Phase 2 rule):**
- Every source row is either counted in `cv.error` or on the ignore
  list.
- The ignore list has one reviewed entry: RTA relays. It covers code
  1050141, which only ever appears as a relay.
- Every counted code gets a row in `insight.ge_cv_codes` with its label.
  190 codes have a readable label; 13 have none and are shown by code.

**Choices in the proposal, with their evidence:**
- **Relays:** count the original, never the relay (§6.1).
- **PIB:** count 1050024 only. The paired 1050297 rack reset is the
  same event.
- **Emergency backout:** count "pressed" only. "Released" is its pair.
- **Not in `cv.positioner_collision`** (they stay in `cv.error`, to
  avoid double counting):
  - 1050167 "COLLISION SENSOR ACTIVATED": 226 of 247 come with a lift
    collision.
  - 1050305 / 1050178 "COLLISION NOT CLEARED": 19 of 24 come within 60 s
    of a collision.
- **Not in `cv.table_encoder_failure`:** 1050015 / 1050102
  "potentiometerEncoderMismatch" (8 rows, axis unknown) stay in
  `cv.error`.
- **No informational code is removed from `cv.error`**, e.g. "Colimator
  : set Auto", "User has requested Shutdown", "Collimator power supply
  recovered". `cv.error` stays a faithful count of GE's log, so it
  reconciles exactly with independent SQL. CV-4's storm finding chooses
  which codes it counts.

### 6.3 Candidate metrics (watch list, not in v1 unless agreed)

| Candidate | Codes | Rows | Why it might matter |
|---|---|---|---|
| `cv.detector_offset_out_of_range` | 1200019 | 11,418 (SME02412, 12 days) | Comes with the detector com storms (11 of 12 days) |
| `cv.positioner_reset` | 1050297 "Rack has been resetted …" / "Reset generated by SAFETY task", dim = reason | 868 | PIB is 730 of them; the other reasons are rare |
| `cv.positioner_boot`, `cv.shutdown_requested` | 1050297 "Positioner CPU Boot Up"; 3400037 | 151; 98 | A CV analogue of CT's boot / unclean-shutdown finding |
| `cv.collimator_comm_failure` | 600104 CAN, 600501 power (600502 = "recovered") | 881 | 41 sys-days, both systems |
| `cv.positioner_link_lost` | 600105, 1000025 Arcnet, 1050686 RTAC timeout | 1,046 | Mostly the positioner episode |

All of these stay visible in `cv.error` by code either way.

### 6.4 Decisions (AGREED 2026-11-09: the recommendation in each)

- **M1 Mapping:** adopt §6.2 (`cv.error` + 8 named metrics, relays
  ignored). Recommended.
- **M2 Name:** call §2's "network failure" `cv.worklist_query_failed`,
  because that is what the source says. Recommended.
- **M3 Candidates:** keep §6.3 out of v1. They are still counted per
  code in `cv.error`; CV-4 revisits them with the findings.
- **M4 Field service: AGREED, add to the §5.5 D4 note** (two
  questions, drafted there). The
  2026-09-11 → 18 positioner episode on SME02412 (PIB COM resets, board
  PRD failures) and its persistent lateral table potentiometer warning
  (1050710, 60 sys-days) are worth asking about.

## 7. CV-1 schema: migration 007 (drafted 2026-11-09)

**Files:**
- `migrations/007_cv_schema.sql`, `migrations/007_cv_schema.down.sql`.
- Runner scope extended to `api.ge_cv_*`: `migrations/lib/sqlscan.js`,
  `migrations/lib/catalog.js`, and the messages in `migrations/run.js`.
- Tests in `migrations/test/sqlscan.test.js`.
- Nothing the CT run loads changes: `insight/`, `index.js` and the
  parsers are untouched.

### 7.1 What 007 creates (new objects only)

| Object | What |
|---|---|
| `insight.ge_cv_facts` (+ id sequence, 2 indexes) | One row per (source row × metric). Holds:<br>• unique key `(source_id, source_capture_datetime, metric_key)`: the log row's primary key + metric (§7.6);<br>• `system_id`, `host_datetime`, `sequencenumber` (the device-side identity, not a key);<br>• `host_local` (device wall clock), `errorcode`, `subsystem` (trimmed, CHECK), `exceptioncategory`, `dim`, `value_num` / `value_text`, `attrs`;<br>• `source_id` + `source_capture_datetime` (the log row's primary key), `rule_version`.<br>`CHECK (metric_key LIKE 'cv.%')`. **Not partitioned:** about 140k facts per 6 months. |
| `insight.ge_cv_daily` | `(system_id, local_day, metric_key, dim)` → n (> 0), value sum / min / max / last, first_at / last_at. Same cv.* CHECK. |
| `insight.ge_cv_codes` | One row per error code: subsystem, label (most common readable template), label_share, source file, n, systems, first / last seen (§2 item 4). |
| Grants | `insight_writer`: DML on the three tables, and USAGE / SELECT on the sequence (as in 003 / 004). |
| `api.ge_cv_daily_v` | Daily rows with catalog labels; for `cv.error`, `code_label` and `code_subsystem` from `ge_cv_codes`. |
| `api.ge_cv_capabilities_v` | **A view over the facts, not a table**, so there is nothing to derive or verify. Absent = never logged. |
| `api.ge_cv_codes_v` | The code labels. |
| `api.ge_cv_findings_v` | `insight.findings WHERE source = 'ge_cv'` with `finding_catalog` labels. |
| `api.ge_cv_system_summary_v` | Per system: newest fact, newest device day, open ge_cv findings and their highest severity. |

**Shared tables are only referenced, never changed:**
- the facts and daily foreign keys to `metric_catalog`;
- the views' joins to `metric_catalog` and `finding_catalog`, and reads
  of `findings`.

007 writes no rows. The `cv.*` catalog rows come from the CV registry at
stage start, as for CT.

**Left out on purpose:**
- **A CV clock table.** SME02412 runs 34–114 min ahead. CV-3 decides,
  and would add `insight.ge_cv_clock`; CT's `insight.system_clock` is
  compared row by row by the CT verifier.
- **A days view.** That is for CV-6, the viewer.
- **Any change to `api.ge_ct_findings_v`** (§7.4 C3).

### 7.2 Tests (no DB) — `node --test migrations/test`: 20 of 20 pass

- **007 creates exactly its 12 new objects:**
  - no drop, no re-create;
  - the only ALTER is the sequence's OWNED BY;
  - grants name only new objects, and there are no row writes;
  - no CT, `log.*`, `public.*` or `alert.*` name.
- **007 down drops exactly the 8 objects** (views and tables).
- **CV views select only `source = 'ge_cv'`.** The cv.* CHECKs and the
  source key are pinned, and no unique key uses `sequencenumber`.
- **Runner scope:** `api.ge_cv_*` is allowed. `api.ge_mr_*`,
  `api.ge_cvx`, `api.hca_odata` and `log.*` are still refused, and
  `inScope` agrees.
- **001–006 are unchanged:** the same checksums as applied on prod.

### 7.3 Rehearsal on a local throwaway database (2026-11-09)

**Setup:**
- PostgreSQL 14.11 (prod is 16.15), in the session scratchpad.
- Unix socket only, permissions 0700.
- Stub `api` / `log` schemas, an `api.hca_odata` stand-in and the role
  `insight_writer`.
- The real runner, with the target given by environment variables. The
  prod DB was not touched.

**Runner results:**
- 001–006 applied.
- `roundtrip`:
  - 007 up then down;
  - no locks on protected relations;
  - after up, in-scope **+16 -0 ~0** (+17 before the §7.6 fix): no
    existing insight or CT object changed;
  - down restored all 267 catalog objects exactly.
- `up` dry run: clean. `up --apply`: clean.

**The §6.2 mapping loaded as `insight_writer`:**
- 140,182 facts inserted; re-inserting a batch adds 0.
- Daily and code rows built.
- `api.ge_cv_capabilities_v` equals the classifier on 17 of 17 (system,
  metric) cells.
- `cv.error` per (system, code) in `api.ge_cv_daily_v` equals a plain
  count of the non-relay rows on 297 of 297 cells.

**What the database refuses:**
- a CT key in the CV facts;
- an untrimmed subsystem;
- DDL or TRUNCATE by the writer.

As for CT, the writer has no access to `api`.

### 7.4 Before CV-2 can write (constraints found, not part of 007)

- **C1: CT verifiers count every catalog row.** They would fail as soon
  as `cv.*` metric rows or CV finding keys exist:
  - `insight/verify_facts.js` (`catalog.n === expected`);
  - `insight/derive/verify.js` `check_invariants`
    (catalog = CT rule count);
  - `insight/findings/verify.js` "catalog = registry".

  The stage rehearsal gates on all three. So they must be scoped to CT
  keys before CV-2's first catalog write. **Interlock (§8):** CV's
  `backfill --apply` refuses until each of the three modules exports
  `CV_AWARE = true`, which that CT change adds. That is a small CT code change,
  allowed only after the Phase 5 close-out, with its own review and
  deploy.

  Applying 007 is safe without it, because 007 writes no rows.
- **C2: the writer can't read the CV log table.** `insight_writer` needs
  `SELECT ON log.ge_cv_syserror`. A migration can't grant that (the
  runner refuses grants on `log.*`), so it is a step the user runs with
  `maintenance/create_insight_writer.js` or a one-off, before CV-2's
  apply.
- **C3: `api.ge_ct_findings_v` has no source filter.** The CT viewer,
  the CT findings run and the CT verifier each filter
  `source = 'ge_ct'` themselves, so CV findings don't affect them. But
  any other consumer of that view would see CV rows. A later migration
  can add `WHERE f.source = 'ge_ct'`; decide before CV-4.

### 7.5 Applying 007 on prod (the user, after the CT Phase 5 close-out)

Recommended: after the close-out check (2026-11-12 13:00 UTC), once the
Codex review is closed and 007 is committed.

From the checkout whose `.env` targets prod:
```
node migrations/run.js status
node migrations/run.js up            # dry run: type the DB name
node migrations/run.js roundtrip     # up + down, catalog identical, rolled back
node migrations/run.js up --apply    # type the DB name, then APPLY
```

**What to expect:**
- 12 objects created and version 7 recorded.
- Protected objects unchanged, and in-scope `+16 -0 ~0`.
- The foreign keys briefly lock `insight.metric_catalog`. If a CT stage
  run holds it, `lock_timeout` (5 s) aborts cleanly; rerun.

**After the apply** (I verify read-only): the views exist and are empty,
the CT views are byte-identical (the runner's fingerprint), and
`schema_migrations` has 7 rows.

### 7.6 Codex review CV1-SCHEMA (2026-11-09): one P2, fixed

`REVIEW-CV1-SCHEMA-CODEX.md`. Everything else passed: the runner scope,
"no CT change", the lock timeout, unpartitioned volume (about 1.3M facts
per 6 months at 18 systems), the views, the down file, and C1–C3 as the
complete list of shared-table interactions.

- **P2: the fact key could collide.** `(system_id, host_datetime,
  sequencenumber, metric_key)` is unique in today's data but not by
  construction. The device logs local time with no offset, so the DST
  fall-back hour happens twice; with a file reset in between, two
  different records can get the same time and sequence number. Adding
  `errorcode` would not help for a repeat of the same code.
- **Fix:** the unique key is now `ge_cv_facts_source_key (source_id,
  source_capture_datetime, metric_key)`, the source row's primary key +
  metric. It replaces the separate `source_id` index (12 objects, not
  13).
  - This is safe because source rows are already one per record: the
    ingest duplicate guard (`persist/drop_already_ingested_cv.js`)
    compares the whole record.
  - **For CV-2:** its verify reports any repeat of (system_id,
    host_datetime, sequencenumber, errorcode) in the source as a data
    quality note (none today), instead of the key silently dropping one.
- **Re-checked locally** with the real runner: roundtrip clean
  (+16 -0 ~0, 267 objects identical after down); the §6.2 mapping
  reloads 140,182 facts, re-insert adds 0, and 17 / 17 and 297 / 297
  cells reconcile. The P2 case itself, two source rows with the same
  device time and sequence number, keeps both facts. The capabilities
  view still pushes `system_id` down to an index (7 ms).

## 8. CV-2 extract: built 2026-11-09 (uncommitted)

The §6.2 mapping as agreed (M1–M3), in the CT method: a rule registry,
an extract that streams the source by id, a version-gated upsert, an
independent SQL count, fixtures from real rows, and a rehearsal that is
rolled back.

### 8.1 Files: all new, in `insight/cv/`

**Isolation:** nothing outside `insight/cv/` loads these files, and a
test checks it. CV reuses only side-effect-free CT pieces:
`rules/engine.js` (`validate_rules`, `catalog_rows`), `load.js`
`catalog_statement`, and `db.js`.

| File | What |
|---|---|
| `rules.js` | The registry:<br>• `cv.error` (dim = code) + 8 named metrics, each with its complete `codes` list and a `match` on the debug text that returns the dim;<br>• the ignore list (`rta_relay`);<br>• `classify(row)`;<br>• catalog rows: `cv.*`, all `customer_visible = false` (the CV viewer is internal). |
| `codes_reviewed.js` | The 204 codes reviewed on 2026-11-09. A new code is still counted in `cv.error`, and is listed as "unreviewed" until someone reviews it. |
| `extract.js` | Streams `log.ge_cv_syserror` by id, 50k per batch. Selects only non-encoded columns. `host_local` = host_date + host_time, built in JS, so a malformed time skips one row instead of failing the batch. Skip reasons cover the facts table's NOT NULL columns. |
| `load.js` | `run_extract`, as `insight_writer` only, under its own lock `insight_ge_cv`. Per batch, one transaction holds:<br>• the upsert on `ge_cv_facts_source_key`, only when the rule version is higher;<br>• the `ge_cv_extract` watermark;<br>• the touched device days for CV-3, in `job_state 'ge_cv_derive'.last_run_stats.pending` (as CT; more than 31 days → "full").<br>Also: the late-commit re-read (as CT §15.2), a runaway guard (2 facts per row), and rule errors abort the batch. |
| `reconcile_sql.js` | The independent SQL: per-metric conditions written from §6.2 (code lists + text), the relay definition, the storable-row filter, coverage, and source repeats. |
| `verify.js` | The exit check. Facts per (system, metric) = SQL. Every row is relay, counted or unstorable, and `cv.error` = counted. The `cv.*` catalog = the registry (CT rows are not looked at). Also reports unreviewed codes and source repeats. |
| `cli.js` | `dry-run` (read-only); `backfill --rehearse [--batches N]` (one transaction, rolled back: catalog, extract, a second pass for idempotency, verify); `backfill --apply`; `verify` (read-only). |
| `tools/build_fixtures.js`, `__fixtures__/` | 65 real rows labelled by the independent SQL. They include look-alikes that must stay in `cv.error` only: backout "released", PIB rack reset, collision sensor, COLLISION NOT CLEARED, potentiometerEncoderMismatch, 1200019. Only the columns the rules read are kept, and IPv4 is masked. |
| `test/cv.test.js` | 14 tests, no DB. |

**Interlocks in `backfill`:**
- **C2:** `insight_writer` must be able to SELECT `log.ge_cv_syserror`.
  Checked for both rehearse and apply.
- **C1:** `--apply` is refused until the three CT verifier modules export
  `CV_AWARE = true`.
- **Schema:** version 7 or later.

### 8.2 Tests: `node insight/cv/test/cv.test.js`, 14 of 14 pass

They pin:
- the registry against M1–M3;
- every fixture's facts;
- relay detection;
- the paired events, counted once;
- the dims;
- `repeatcount` as an attribute only;
- skip reasons;
- the upsert SQL (source key, version gate, SQL NULL attrs) and dedupe,
  including the P2 case (same device time and sequence, two source rows:
  both kept);
- the pending-days merge;
- the C1 interlock (today the real CT modules are not CV-aware, so
  `--apply` is refused);
- that the SQL covers every named code;
- that no SQL selects an encoded field;
- the CLI flags;
- isolation.

Every existing suite still passes: `insight/test` (7 files), `test/`
(6) and `migrations/test`.

### 8.3 Evidence (2026-11-09)

**Registry vs the §6 evidence classifier:** identical on all 96,204 rows
(0 differences, 0 rule errors).

**Read-only dry run on prod**, using the reports read-only connection
(never the repo `.env`). It covered 96,286 rows up to id 472,880 and
took 3 s:
- 140,289 facts;
- 17 of 17 (system, metric) cells equal the independent SQL;
- 11,902 relays + 84,384 counted = every row; 0 unstorable;
- 203 codes, none unreviewed;
- 0 source repeats.

**Local throwaway DB** (007 applied with the real runner; the 96,204
real rows loaded into a local `log.ge_cv_syserror`; `insight/db.js`
stubbed so no `.env` is read):

| Step | Result |
|---|---|
| Without SELECT on the source | Refused (C2) |
| `rehearse` (full) | 140,182 facts; second pass upserts 0; verify ok (17 / 17 cells, coverage complete, catalog 9 = registry); pending "full" for both systems; **nothing persisted** |
| `rehearse --batches 1` | 50,000 rows, rolled back |
| `apply` before C1 | Refused, nothing written |
| `apply` (C1 stubbed) to the median id, then resume | 70,638 + 69,544 = 140,182; watermark 472,798; verify ok from a read-only session |
| `apply` again | 0 rows, 0 upserted |
| A row committed late, below the watermark | Picked up by the re-read (2 facts); verify still ok |
| A second run while the lock is held | Skipped |

The CT catalog row in the local DB was not touched. Full rehearsal:
37 s; full apply: 17 s.

### 8.4 Order on prod (each step after the previous one)

1. **CT Phase 5 close-out**, after 2026-11-12 13:00 UTC.
2. **The user applies 007** (§7.5).
3. **C2:** the user grants `insight_writer` SELECT on
   `log.ge_cv_syserror`. I give the exact statement then.
4. **The user runs `node insight/cv/cli.js backfill --rehearse`** on
   prod. It writes nothing; expect verify ok and a second pass of 0.
5. **C1:** scope the three CT verifiers to CT keys and add `CV_AWARE`.
   This is a CT code change, with its own review, the stage rehearsal and
   a deploy.
6. **The user runs `backfill --apply`, then `verify`.** That completes the
   CV-2 exit criterion on prod.

CV-3 (derive: daily, code labels, clock) reads the pending days recorded
here.

### 8.5 Codex review CV2-EXTRACT (2026-11-09): one P2, fixed

`REVIEW-CV2-EXTRACT-CODEX.md`. Everything else passed:
- the independence of the SQL (every predicate compared);
- the upsert and the batch transaction;
- the late-commit re-read;
- the pending merge;
- both interlocks, and the rehearsal before C1;
- no effect on CT beyond C1;
- the rule-error policy;
- fixture contents;
- what CV-3 needs.

**P2:** `backfill` did not validate the registry before the shared
catalog upsert. A bad edit could commit a catalog row before the batch
failed.

**Fixed:** `run_extract` validates first and refuses both modes before
any connection or write. `validate()` can take a given registry, and a
test shows the database is never touched, plus a non-`cv.` key and
overlapping code lists being caught. `cv.test.js` now has 15 tests. The
read-only prod dry run, re-run after the fix, is still 17 of 17 equal.

**Known limit:** a version bump that makes a rule stop matching rows
leaves their old facts in place. The upsert only replaces facts. Such a
change needs a targeted delete in the same change, and v1 has none.

## 9. CV-3 derive: built 2026-11-09 (uncommitted)

### 9.1 What it builds (`insight/cv/derive.js`)

- **`insight.ge_cv_daily`:** per system, device day (`host_local`),
  metric and dim: n, value aggregates (NULL for v1's event metrics) and
  first / last `host_datetime`.
  - **Scope:** the days the extract recorded in
    `job_state 'ge_cv_derive'.last_run_stats.pending` (§8). A system with
    more than 31 pending days, or `--full`, is rebuilt in full.
  - **One transaction per system:** delete and rebuild its days, and
    clear its pending entry. A failed run is redone by the next one.
- **`insight.ge_cv_codes`:** rebuilt in full on each run that had
  something pending (about 200 rows). One row per error code of the
  `cv.error` facts:
  - n, systems, first / last seen;
  - the most common subsystem and source file;
  - **label:** the most common readable debug-text template, with its
    share of the code's rows.

  The **template** trims GE's quote / dash framing and masks 0x-hex,
  hex tokens that contain a digit (`4B10`, `FEC28000`) and numbers as
  `#`. Hex-looking words without a digit (`FFFF`, `DC`) stay.

  The **text** comes from the source rows behind the facts (joined on
  the source primary key). Encoded fields are never read.
- **Capabilities:** already a view (`api.ge_cv_capabilities_v`, 007);
  nothing to derive.
- **Locking:** the derive runs under the CV advisory lock, so it never
  overlaps an extract.
- **Commands:** `cli.js derive --rehearse`, `derive --apply [--full]`,
  `verify-derive`.
- **Isolation:** as in §8, nothing CT loads requires these files.

### 9.2 The check (`insight/cv/verify_derive.js`), all from the source

| Check | Compares |
|---|---|
| A | Daily per (system, device day, metric), summed over dims, with an independent count from `log.ge_cv_syserror` (the §8 conditions; device day = `host_date`) |
| B | `cv.error` daily per (system, day, code) with a source count |
| C | Daily with a plain GROUP BY over the facts, every column, both directions (covers the named-metric dims) |
| D | `ge_cv_codes`, every field, with the same fields rebuilt from the source in SQL. The template is rewritten as PostgreSQL regexes, not the JS function; ties go to the smallest value under `COLLATE "C"` on both sides. |

### 9.3 Evidence (2026-11-09, local throwaway DB, the facts from §8.3)

| Step | Result |
|---|---|
| `derive --rehearse` | 5,262 daily rows (SME02412 2,843, SME08640 2,419) and 203 codes (13 without a readable label, as in §6.1). A second pass is byte-identical; rebuilding the last 7 days by day equals the full rebuild. Verify: A 1,697 cells, B 3,516 cells, C both directions and D 203 codes, all with 0 differences. Nothing persisted. |
| `derive --apply` (pending "full" for both systems from §8) | Same contents; pending cleared; `verify-derive` ok from a read-only session |
| `derive --apply` again | Nothing pending; nothing done |
| A new device day (3 new source rows, one a relay, one a new code) → extract → derive | Pending = that one day; derive rebuilt only it; the new code was flagged as unreviewed and got its own label; verify ok |
| `derive --apply --full` | Byte-identical to the pending path |

**Known limit:** checks A, B and D read the source log. If old
`log.ge_cv_syserror` partitions are ever dropped (retention), those
checks must be limited to the retained range, and the labels then come
only from the surviving rows. No CV log partition has been dropped so
far (data from 2026-04-30).

Rehearsal: 7 s; apply: 1.5 s. Tests: `insight/cv/test/derive.test.js`
8 of 8, plus `cv.test.js` 14 of 14. Every existing suite passes.

### 9.4 Decision for the user: K1, the device clock (recommendation first)

SME02412's device time runs 34–114 minutes (p10–p90) ahead of our
capture time (§1.4). A record is captured after it is written, so the
clock is at least that far ahead. SME08640 is within about ±14 minutes.
CT keeps a clock table (`insight.system_clock`) for this.

**K1: no CV clock table in v1. Recommended.**
- Daily counts use the device's own day, as CT's do. A wrong clock moves
  at most the events of the last 2 hours of a day into the next day.
- No v1 metric or planned CV-4 finding compares CV times with outside
  times. The storm and recurrence findings are per device day.
- `first_at` / `last_at` and the views' `last_seen` are device times, so
  they inherit the offset. The viewer (CV-6) should say so.
- If a later finding needs real time (for example, linking errors to
  our collection runs, as the D4 storm analysis did), a later migration
  adds `insight.ge_cv_clock`, built from `capture_datetime` against the
  device time of the newest row in each capture.

### 9.5 Codex review CV3-DERIVE (2026-11-09): P2 and P3, fixed

`REVIEW-CV3-DERIVE-CODEX.md`. Everything else passed:
- daily delete-and-rebuild (an emptied day is removed);
- the range join and `host_local::date` = `host_date`;
- `value_last`;
- the shared lock against the extract;
- the pending merge;
- code aggregation with missing source rows (the §9.3 retention limit);
- cost at 18 systems;
- the tie-breaks;
- **K1:** sound for device-day counts and the planned findings. The
  viewer must label times as device time.

**P2: a failed code rebuild was never retried.** The daily transactions
clear the pending days, and the codes were rebuilt afterwards in their
own transaction. A crash in between left nothing pending, so the next
run skipped the codes.
- **Fix:** each system's daily transaction now also sets
  `last_run_stats.codes_pending = true`. `rebuild_codes` clears it in its
  own transaction, and a default `--apply` rebuilds the codes whenever it
  is set.
- **Local check:** a simulated crash in the code rebuild left
  `codes_pending` set. The next default run rebuilt the codes (replacing
  a planted stale label) and cleared it, and the run after that did
  nothing.

**P3: labels could differ between JS and SQL on non-ASCII text**
(UTF-16 `slice` vs `left`, `\b` vs locale word boundaries).
- **Fix:** both sides first turn every non-ASCII character into `?`,
  one per code point. Everything after that is ASCII, where the regexes
  and the 200-character cut agree.
- **Check:** JS and SQL agree on 10 tricky strings (emoji at the cut,
  non-breaking and ideographic spaces, accented and CJK text, a raw
  `\x01`), checked on the local DB. Tests: `derive.test.js` 9, with a
  non-ASCII test added.
- GE's debug text is ASCII today, so no current label changes.

## 10. CV-4 groundwork: findings (2026-11-09, read-only)

**Evidence:**
- All 96,289 rows of `log.ge_cv_syserror` (pulled read-only 2026-11-09
  21:14 UTC, max id 472883), run through the CV-2 rules in memory: 140,294
  facts, 11,902 relays ignored, nothing skipped. Nothing was written.
- Device days 2026-04-30 → 11-09: SME02412 159 data days, SME08640 176.
- Each candidate rule was replayed day by day with CT's own open/resolve
  fold (`insight/findings/state.js` `step`, loaded read-only), so the
  replay behaves exactly as CT's: a 14-evaluated-day quiet period,
  severity never falls, at most one open finding per key.
- Scripts and logs: `~/cv_d3b_evidence/cv4/` (`pull.js` → `daily.js` →
  `sim.js`), outside the repos.

### 10.1 What the series show

**Daily `cv.error`:**
- SME08640 is quiet: median 34 a day, p95 70, max 393 (08-28).
- SME02412 has a median of 35 a day, but p95 is 2,620 and the max is
  16,181. Its storm days fall into four kinds:

  | Kind | Days | What dominates |
  |---|---|---|
  | Detector com storm | 05-19, 06-19, 06-30, 07-10/11, 09-04, 09-22, 09-29, 10-20/21 | 1200014 "Detector com error" (~77%) + 1200019 detector offset (~22%) |
  | Positioner episode | 09-11 → 09-21 | 1050171 positioner board reset debug steps, PIB COM resets, 600104 collimator CAN, 600105 positioner link, 1000025 Arcnet, anticollision errors |
  | Lateral table potentiometer | 05-01 → 05-27, every data day | 1050710 (30–354 a day) with table-lateral anticollision errors |
  | Table longitudinal | 10-15/16 | 1050301 anticollision table_long + 1050182 longitudinal pot/encoder mismatch |

  One SME08640 day is an image-chain burst: 2800006 plus "Last Image Id
  received twice" (810012, 4810012, 1610012) on 08-28.

**Named metrics, per system:**

| Metric | SME02412 | SME08640 | Reading |
|---|---|---|---|
| `cv.detector_com_error` | 27 days; 10 days ≥ 50 (up to 12,568) | 4 days, 6 rows | Episodic storms on SME02412 only |
| `cv.anticollision_error` | 46 days; bursts ≥ 50 on 05-01, 05-22..27, 09-12..18, 10-15 | 157 of 176 days, max 22 | SME08640 chronic low level; SME02412 bursts follow its table and positioner faults |
| `cv.table_encoder_failure` | May every day (lateral), 09-14..21, 10-15/16 (longitudinal); otherwise singles | 32 days, max 3 a day | The "persistent" 1050710 warning (§6.4 M4) is the May run; it stops after 05-27 |
| `cv.pib_com_loss` | 7 days, all 09-11..18 | none | Never outside the episode |
| `cv.positioner_collision` | 154 of 159 days, median ~13 | 170 of 176 days, median ~9 | Everyday use, not a fault |
| `cv.dose_export_rejected` | 137 of 159 days, ~4 a day | 161 of 176 days, ~4 a day | Chronic on both; the same text every time, "Association rejected" (MC_ASSOCIATION_REJECTED) |
| `cv.emergency_backout` | 85 days | 129 days | Everyday use |
| `cv.worklist_query_failed` | 104 days | 96 days | Chronic low level (1–9 a day) |

The log has no success records, so a rejection or failure count can't be
turned into a rate.

### 10.2 Proposed rules (replayed)

Windows are device days (7 d = D−6..D). A baseline is the median of the
data days in D−28..D−1 and needs ≥ 7 of them. Quiet period: 14 evaluated
days, as in CT. Keys use the `cv_` prefix (the catalog's key check
allows `^[a-z][a-z0-9_]*$`, so not `cv.`).

| # | Finding key | Rule | Severity | Replay (as of 11-09) |
|---|---|---|---|---|
| 1 | `cv_error_storm` | A storm day is a day whose **residual** `cv.error` (all codes, minus the rows that rules 2–5 count, minus 1200019) is ≥ 300 and ≥ 10× the baseline. Trips with a storm day in the last 7 days | high with ≥ 3 storm days in 28, else medium | SME02412 09-11 → 10-14 (high, the positioner episode); SME08640 08-28 → 09-17 (medium, image-chain burst) |
| 2 | `cv_detector_com_errors` | ≥ 50 detector com errors on a day in the last 7 days | high with ≥ 3 such days in 28, else medium | SME02412: 05-19 → 06-11 (medium), 06-19 → 08-01 (high), 09-04 → **open** (high, last storm 10-21) |
| 3 | `cv_anticollision_burst` | ≥ 50 anticollision errors on a day and ≥ 5× the baseline, in the last 7 days | medium | SME02412: 05-01 → 06-19, 09-12 → 10-12, 10-15 → 11-06. SME08640 never (max 22) |
| 4 | `cv_table_encoder_fault` | ≥ 5 table encoder / potentiometer failures on ≥ 2 days in the last 7 | high with ≥ 10 such days in 28, else medium | SME02412: 05-04 → 06-18 (high, lateral), 09-15 → 10-12, 10-16 → 11-06 (longitudinal). SME08640 never |
| 5 | `cv_pib_com_loss` | ≥ 3 PIB COM resets / fails in the last 7 days | high on ≥ 3 days in 7, else medium | SME02412 09-11 → 10-12 (high) |

**Total:** 12 findings, 1 open (detector com, SME02412). Everything is
on SME02412 apart from one SME08640 storm.

**Sensitivity:** the list is the same for a detector threshold of 20,
50 or 100 a day, and for a storm factor of 5 or 10. A storm floor of
200 adds SME02412 06-22 (lift collisions and image-chain codes, no
fault); a floor of 500 drops SME08640 08-28. 300 sits between the two.

**Why the storm counts the residual:** with every code counted, the
storm finding repeats the detector finding on every detector storm
(`sim_all.log`: 2 long storm findings that cover the same days as rule
2). The residual is what no other CV finding explains. In this data that
is the positioner episode, which surfaces the board-reset debug,
collimator CAN and Arcnet failures. The residual is exact from
`ge_cv_daily`, because each counted row has one `cv.error` fact and at
most one named fact.

**One episode, several findings:** 2026-09-11 → 18 opens `cv_error_storm`,
`cv_pib_com_loss`, `cv_anticollision_burst` and `cv_table_encoder_fault`.
Each is a different subsystem's evidence of the same event. Linking them
is a viewer concern (CV-6), not a rule change.

### 10.3 Not findings in v1 (data only, shown in the viewer)

- `cv.positioner_collision` and `cv.emergency_backout`: on nearly every
  day on both systems. A spike rule would give 1–2 single days of
  unclear meaning.
- `cv.worklist_query_failed`: chronic low level on both systems.
- `cv.dose_export_rejected`: chronic, rejected on nearly every day on
  both systems since the data starts. A rule would open on day 3 and
  never resolve. This is the same situation as CT's
  `compliance.dose_display_disabled`, which stays data only until field
  service confirms (CT §12 item 8). A third question was added to the
  §5.5 D4 note (F3): is a dose-export destination configured on these systems, and is
  every export being rejected?
- The §6.3 candidates (M3).

### 10.4 Design (follows CT §14.2 and §14.7)

- **Files:** all new, under `insight/cv/findings/`, loaded by nothing in
  the CT run.
  - `rules.js`: the registry of pure `evaluate(ctx, D)` rules, plus the
    catalog rows.
  - `context.js` and `load.js`: dense day arrays from `ge_cv_daily`. The
    day start is the device's local midnight, from the facts
    (`host_datetime − time of day of host_local`); no clock table (K1).
  - `run.js`: rehearse / apply / replay.
  - `verify_sql.js`: independent SQL from `ge_cv_daily`, with the
    residual computed in SQL.
- **The fold is CT's:** `replay_system(ctx, cv_rules)` from
  `insight/findings/state.js`, loaded unchanged. The CV wrapper sets
  `source = 'ge_cv'` on its rows, so no shared code changes. Every CT
  read, write and delete already filters `source = 'ge_ct'`.
- **Catalog:** CV syncs only its own `cv_*` rows. CT's catalog sync
  leaves keys it doesn't know in place (it only logs them), so CV rows
  survive CT runs. CT's "catalog = registry" check is C1's.
- **`customer_visible = false`** for every CV finding in v1. Its
  evidence is GE service text (codes and counts only, no debug text), and
  nothing has been confirmed by field service.
- **CLI:** `insight/cv/cli.js findings --rehearse | --apply [--replay]`
  and `verify-findings`, with the same rehearsal as CT: idempotency pass,
  incremental vs replay, verify inside the transaction.

### 10.5 C3: the findings view

Every consumer of `api.ge_ct_findings_v` filters `source = 'ge_ct'`
itself:
- the CT viewer (`reports/sme_reports/ct/data.js`) and its verifier;
- `api.ge_ct_systems_v` (004);
- the CT findings run and verifier.

No other consumer exists under `~/hep3`.

`api.ge_cv_findings_v` (`source = 'ge_cv'`, with catalog labels) already
exists: 007 created it. So 008 only adds the `ge_ct` filter (§10.8).

### 10.6 Decisions (AGREED 2026-11-10: the recommendation in each)

- **F1 Rules:** adopt rules 1–5 with the §10.2 thresholds. Recommended.
- **F2 Storm counting:** count the residual, not every code. Recommended
  (§10.2).
- **F3 Dose export:** data only in v1, plus a third question in the D4
  field-service note. Recommended. The alternative is a low `compliance`
  finding left permanently open on both systems.
- **F4 Data only:** collisions, emergency backout and worklist failures
  stay viewer metrics. Recommended.
- **F5 C3:** migration 008, which ships with CV-4's writer:
  `api.ge_ct_findings_v` gets `WHERE f.source = 'ge_ct'`. Every consumer
  already filters, so nothing changes for them. Recommended.
  - *Correction 2026-11-10:* `api.ge_cv_findings_v` was listed here as
    new, but 007 already creates it, so 008 doesn't.
- **F6 Shared code:** none for CV-4. It reuses `state.js` unchanged and
  sets `source` in its own wrapper. Recommended over making `state.js`
  take a source parameter, which would touch CT code.

### 10.7 Proposed CV-4 exit criteria

- On prod, the replay opens:
  - the SME02412 detector com findings (three episodes);
  - the 2026-09-11 positioner episode (storm, PIB, anticollision, table);
  - the May lateral table potentiometer finding.

  Any change from §10.2 is explained by new data.
- Every medium/high finding is explained by its codes and series.
- `verify-findings` (`ge_cv`) equals independent SQL at each system's
  as-of day.
- Replay and repeat runs change nothing.
- CT findings, catalog checks and the CT viewer are unchanged.
- Order: after CV-2/CV-3 are applied on prod (§8.4), and after 008.

### 10.8 CV-4 build (2026-11-10, uncommitted)

**Files (all new, apart from the CV CLI):**
- `insight/cv/findings/`:
  - `context.js`: pure. It builds per-system dense day series of
    `cv.error`, the four named metrics and 1200019, and the residual. Its
    context has the same shape as CT's, so CT's fold runs on it.
  - `rules.js`: the 5 rules of §10.2, the CV catalog rows, and
    validation (`cv_` prefix, windowed only, internal).
  - `load.js`: data days from `ge_cv_facts` (midnight and last instants)
    and daily cells from `ge_cv_daily`.
  - `run.js`: rehearse / apply / replay. It reuses CT's pure pieces:
    the fold `state.replay_system`, plus `reconcile`, `totals` and the
    upsert from `findings/run.js`. `as_cv_rows` relabels the fold's rows
    to `ge_cv` and refuses a non-`cv_` key.
  - `verify_sql.js`: independent SQL. It uses `RANGE` windows over data
    days, `percentile_cont` baselines and CT's island method, with the
    thresholds written out.
  - `verify.js`: the `ge_cv` rows equal the SQL, field by field (CT's
    `compare_findings`); the `cv_*` catalog equals the registry; plus
    invariants.
- `insight/cv/cli.js`: `findings --rehearse | --apply [--replay]
  [--system S]` and `verify-findings` (read-only).
- `insight/cv/tools/build_findings_fixtures.js` and
  `__fixtures__/findings/`: 2 systems, 337 data days, 3,995 cells (codes,
  dims and counts only), with the SQL's 12 findings as of 2026-11-10.
- `migrations/008_ct_findings_view_source.sql` and its down migration,
  plus `migrations/test/m008.test.js`. They drop and re-create
  `api.ge_ct_findings_v` with 005's columns plus
  `WHERE f.source = 'ge_ct'`; the down restores 005 exactly. The runner
  counts `CREATE OR REPLACE` as a create, hence drop and re-create.
  Read-only check on prod (2026-11-10): the view has no grants, no
  dependants and no default privileges, and prod is at version 6 with
  114 `ge_ct` findings.

**Interlocks in `findings` (`preflight`):**
- runs only as the limited `insight_writer`;
- schema ≥ 7 to rehearse, ≥ 8 to `--apply` (C3);
- refuses while CV derive has pending days or owed code labels;
- `--apply` needs C1 (`CV_AWARE` on the three CT verifiers).
  - **C1 detail found here:** CT's `findings/verify.js` "catalog =
    registry" check must also ignore `cv_*` rows of `finding_catalog`,
    as well as the `cv.*` metric rows.

**Tests:**
- `insight/cv/test/findings.test.js`: 17. They cover the registry, the
  SQL thresholds equal to the registry's, residual and baseline, the
  boundaries of every rule, CT's fold (resolve on the 14th evaluated
  day), as-of purity, the preflight refusals and the CLI. The real-data
  fixture equals the independent SQL, and the 12 named cases hold.
- `cv.test.js`: 15. Its `cli flags` check now uses an unknown command,
  because `findings` exists.
- `m008.test.js`: 2. Every other suite still passes: CV derive 9; CT
  derive 14, derived 12, findings 31, load 3, rules 16, scrub 3, stage
  24; parsers 9 + 9 + 4 + 2 + 4 + 13; `sqlscan` 20.

**Local rehearsal (throwaway PostgreSQL 14, socket only):**
- Data: prod rows through id 472938, which is device day 2026-11-10
  (140,352 facts after extract and derive).
- 008 through the real runner: dry run clean; roundtrip in-scope
  +0 −0 ~1, and the down restores all 303 objects; applied.
- Interlocks refused: apply without C1, a run while derive is pending,
  and a run as a superuser.
- `findings --rehearse --replay`:
  - 12 findings, 1 open;
  - pass 2: 0 changes;
  - a default run after the replay: 0 changes, 0 drift;
  - incremental from 2026-10-13, then weekly: identical to the replay,
    0 drift;
  - CT rows and CT catalog unchanged (2 synthetic `ge_ct` findings
    seeded locally);
  - `verify-findings` PASS (12 = 12, catalog 5 = 5, invariants ok);
  - nothing persisted.
- Apply `--replay` (C1 emulated in the harness only), then:
  - `verify-findings` from a read-only session PASS;
  - a default re-run and a replay re-run each changed 0;
  - `api.ge_ct_findings_v` shows only `ge_ct`, `api.ge_cv_findings_v`
    only `ge_cv`;
  - `api.ge_cv_system_summary_v` counts 1 open (high) on SME02412.
- Harnesses: `~/cv_d3b_evidence/cv4/local_*.js`.

**Prod order for CV-4**, after §8.4 (007 → C2 → CV-2 apply → CV-3
derive), each step after the previous one:
1. The user applies 008 (status → up dry run → roundtrip → up --apply;
   expect in-scope +0 −0 ~1).
2. C1 is deployed (needed by CV-2 anyway).
3. `node insight/cv/cli.js findings --rehearse --replay`; expect `ok`,
   and the §10.7 list.
4. `findings --apply --replay`, then `verify-findings`.

Runs after that (CV-5 stage) use the default mode. The CV-5 hook is not
part of CV-4.

### 10.9 Codex review CV4-FINDINGS (2026-11-10): one P2, fixed

**P2: a missing initial derive could pass.**
- The problem: with no `ge_cv_derive` job state, the preflight saw no
  pending days and passed. The system list and the verifier read only
  `ge_cv_daily`. So a rehearsal or verify could report success while
  evaluating a system that has facts but no daily rows; apply would
  write the catalog and job state and produce no findings.
- **The fix, fail closed in two places:**
  - **Preflight** now needs a successful derive on record (`ge_cv_derive`
    `last_run_status = 'ok'`). It also refuses when the device days with
    facts and the days in `ge_cv_daily` differ, either way (it names
    each system with its count and range of days).
  - **`verify-findings`** has the same inventory check as its first
    check.
  - The system list is now facts ∪ daily.
- **Checked:**
  - 4 new preflight cases in `findings.test.js`; it still has 17 tests,
    and every suite passes.
  - Locally:
    - no derive state: refused;
    - SME08640 made facts-only: refused ("facts_only: 177 days
      (2026-04-30..2026-11-10)"), and the read-only verify FAILs the
      inventory and finds 1 extra finding;
    - after `derive --apply --full`, everything passes again;
    - the full §10.8 harness is unchanged (`local_p2.log`,
      `local_cv4_r2.log`).

**Also confirmed by the review:**
- the JS and SQL windows, baselines, islands and `observed` agree;
- the residual is exact while each counted row has one `cv.error` and at
  most one named fact;
- every CV statement is limited to source and key;
- 008 is safe.

**Kept as a note for later rule versions:** a future named metric must
keep "one `cv.error` + at most one named fact per row", or the residual
must change with it.

## 11. C1: the CT verifiers scoped to CT catalog rows (built 2026-11-11, uncommitted)

**Where:** a scratch git worktree on branch `c1-cv-aware` (from `dev` at
5ec391e), outside the repo directory. The main checkout and prod are
unchanged. The GE CT Phase 5 monitoring rule covers shared `insight/`
code until 2026-11-12 13:00 UTC.

### 11.1 The change (CT code, three files, catalog statements only)

- **`insight/verify_facts.js`:** the catalog count (`CATALOG_SQL`) adds
  `WHERE metric_key NOT LIKE 'cv.%'`.
- **`insight/derive/verify.js` `check_invariants`:**
  - the catalog subselect (`INVARIANTS_SQL`) adds the same filter;
  - `check_invariants` is exported for the test.
- **`insight/findings/verify.js` "catalog = registry":** `CATALOG_SQL`
  adds `WHERE left(finding_key, 3) <> 'cv_'`. This is a plain prefix test
  with no backslash escape (§11.6; the first draft used
  `NOT LIKE 'cv\_%'`).
- **Each module exports `CV_AWARE = true`**, with a comment pointing
  here (§7.4 C1). This opens GE CV's `--apply` interlock (backfill and
  findings).
- **Unchanged:** every other check, expected value and message. The
  derived-key counts already matched by key, so CV rows never reached
  them. No CT key starts with `cv`.

### 11.2 Tests

- **New `insight/test/cv_scope.test.js` (7).** Its fake DB applies the
  `NOT LIKE` patterns found in each verifier's own SQL, with
  PostgreSQL's LIKE rules. It covers:
  - pass with and without CV rows;
  - fail on a missing or extra CT row, or a changed CT label;
  - fail on `cvx.*` / `cvx_*`, which an unescaped `cv_%` would hide;
  - the SQL text.

  It loads nothing from `insight/cv/`, because CV's isolation test
  forbids that.
- **`insight/cv/test/cv.test.js` 15 → 16:**
  - the C1 interlock test now expects `[]` from the real modules;
  - a new test checks that every real CV registry row has the excluded
    prefix and that no CT row does.
- **`insight/cv/test/findings.test.js` (17):** the preflight `--apply`
  case now passes the interlock.
- **Every suite passes:**
  - CT: cv_scope 7; derive 14, derived 12, findings 31, load 3, rules 16,
    scrub 3, stage 24 (one skip: `F2 connect()` needs `PG_SSL_PATH`;
    the worktree has no `.env`).
  - CV: cv 16, derive 9, findings 17.
  - Parsers: 9 + 9 + 4 + 2 + 4 + 13.
  - Migrations: m008 2, sqlscan 20.
- **Mutation check:** an unescaped findings filter, or any one filter
  removed, fails a behaviour test.

### 11.3 Local rehearsal (throwaway PostgreSQL 14, one transaction, rolled back)

Harness `~/cv_d3b_evidence/c1/c1_local.js`, log `c1_local.log`. It
compares the original modules (unchanged checkout) with the worktree's;
`insight/db.js` is stubbed for both. The CT catalogs were seeded with
CT's own statements: 39 metric and 13 finding rows, next to 9 `cv.*` and
5 `cv_*`.

| Case | Original | C1 |
|---|---|---|
| CV rows present: `verify_facts` | FAIL (48 vs 39) | PASS (39 = 39) |
| CV rows present: derive invariants | FAIL (48 vs 39) | PASS |
| CV rows present: findings catalog | FAIL (18 vs 13, differ cv_…) | PASS (13 = 13) |
| CT metric row missing / extra `cvx.not_cv` | – | both metric checks FAIL |
| CT finding label changed / extra `cvx_unknown` / extra `cva` | – | findings catalog FAILS |
| No CV rows (correct, and with a missing row) | identical to C1 | identical to original |
| `ct_verifiers_not_cv_aware()` | all 3 | `[]` |
| real CV `backfill` / `findings` preflight `--apply` | refused (C1) | passes |

`log.ge_ct_gesys` does not exist locally, so only `verify_facts`'s
reconcile query was answered with `[]` (there are no CT facts either).

### 11.4 Other CT code checked (nothing else breaks; not changed)

These only affect log lines; none gates anything:
- `findings/run.js` `sync_catalog`: upserts only and never deletes. Its
  "not in the registry" line will list the `cv_*` keys.
- `findings/run.js` `COUNTS_SQL`: totals include `ge_cv` rows (rehearsal
  `before`/`after` lines).
- The extract rehearsal's `catalog_rows`.
- The stage's "fresh read" finding count.

Also safe:
- The per-system findings delete is keyed by a stored `ge_ct` row.
- Derive reads CT tables only.
- The CT viewer (`reports/sme_reports/ct`) reads `api.*` views filtered
  to `ge_ct`.

Recommendation: leave the log-only counts as they are.

### 11.5 Next (each step after the previous one; the user decides)

1. The Codex review is closed (§11.6): the round 2 re-review found no
   new issues.
2. The commit on `dev`, after asking. The worktree is removed only once
   the change is on `dev`. **Done 2026-11-12.**
3. The CT stage rehearsal, which the user runs on prod:
   `node insight/cli.js stage --rehearse`. **Passed 2026-11-12** (status).
4. The push, only when the user says so:
   `git push origin dev dev:staging dev:prod`. The user pulls on prod. **Pushed 2026-11-12.**
5. Then §8.4: 007 (`node migrations/run.js up --to 7`; a plain `up`
   would also apply 008) → backfill rehearse/apply + verify → derive +
   verify-derive. Then §10.8: 008 → findings `--rehearse --replay` →
   `--apply --replay` → verify-findings.

### 11.6 Codex review CV-C1 (2026-11-11): one P2, fixed

**P2: the findings filter depended on `standard_conforming_strings`.**
- The problem: with the setting `off`, PostgreSQL drops the backslash
  from `'cv\_%'`. The pattern then becomes `cv_%`, which also matches
  CT-looking keys such as `cva`, so such a row could escape the exact
  catalog check.
- On prod the setting is `on (default)`, with no overrides (read-only
  probe, 2026-11-11). So this was not a live problem there.
- **The fix:** a plain prefix test, `left(finding_key, 3) <> 'cv_'` (or
  `= 'cv_'`), with no backslash in any SQL literal. It is applied in:
  - the CT findings verifier;
  - the same five statements in the committed CV findings code:
    `cv/findings/run.js` `OTHERS_SQL`, `COUNTS_SQL` and the
    `sync_catalog` extra-key query; `cv/findings/verify.js`
    `FOREIGN_SQL` and `CATALOG_SQL`.
- The metric filters `NOT LIKE 'cv.%'` stay: they hold no backslash.
- **Checked:**
  - **Tests:** `cv_scope.test.js` applies the prefix form; all three CT
    statements are free of backslashes; new CV findings test (18). Every
    suite passes.
  - **Mutation:** a short prefix, a return to `LIKE 'cv\_%'`, or no
    filter each fail a test.
  - **Local case D, under `on` and `off`:** C1 passes with CV rows and
    catches an extra `cva` under both settings. The first draft's filter
    hides `cva` under `off`, which confirms the review. The CV counts,
    catalog and foreign-key statements give 5 / 5 / 0 under both settings.
    Log: `~/cv_d3b_evidence/c1/c1_local_r2.log`.
- **Re-review (round 2, `REVIEW-CV-C1-CODEX.md`): no new findings.** The
  prefix test drops exactly the `cv_` keys and keeps `cva`, `cvx_unknown`,
  `cv` and the CT keys. It is used consistently in the CV queries, and
  `left()` avoids depending on PG 11's `starts_with()`.
