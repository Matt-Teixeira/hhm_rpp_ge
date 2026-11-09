# GE CV Insights — plan

Status (2026-11-06): **Phase CV-0 (decide) AGREED with the user
2026-11-06: the §2 design and the recommended answer to every §3
question. CV-1b (ingest integrity) investigated 2026-11-06 (§5): records
were lost (3,718 proven, plus an unknown number at early file resets);
a CV-only parser fix is built on dev with tests, a simulation on real
snapshots and a read-only prod rehearsal. The user agreed D1–D4 (§5.5,
the recommendation in each) 2026-11-06. The parser fix (D1) is committed (`b0bc513`) and
deployed to prod 2026-11-06 17:24 UTC (§5.5). A follow-up that stores the
file-identity key on idle systems is built and awaiting Codex review
(`REVIEW-CV1B-HEAD-HANDOFF.md`). The collector change (D3a) is
uncommitted: Codex P2 (shared temp name) is fixed. The device listing
(D3b) awaits the user's output.** The
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
| 1050710 | POS | `Table: lateral axis encoder, potentiometer failure, TBL LAT out of range` | 5,331 (repeats 121,445) | 60 |
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
| **CV-1b Ingest integrity** — investigated 2026-11-06 (§5); D1–D4 agreed; parser fix (D1) deployed 2026-11-06, collector change in review | Sequence / rotation / ordering investigation of `sysError` ingestion (read-only); a parser fix if records are lost (reviewed, rehearsed, deployed by the user) | Cause of every sequence gap class explained; no record loss going forward, shown on raw file snapshots |
| **CV-1 Schema** | Migration 007: CV tables and `api.ge_cv_*` views; runner pre-checks, dry run, roundtrip; the user applies it | Applied; catalog unchanged outside the new objects |
| **CV-2 Extract** | CV rule registry, extract and backfill from `log.ge_cv_syserror` (read) into `insight.ge_cv_facts` | Per system and metric, counts exactly equal independent SQL; every code covered by a rule or the reviewed ignore list |
| **CV-3 Derive** | Daily, capabilities, clock offsets, code labels | Independent SQL equal |
| **CV-4 Findings** | Rules, replay, `verify-findings` for `ge_cv` | Independent SQL equal; findings reviewed with evidence |
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
