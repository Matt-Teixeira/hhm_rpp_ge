# GE CV Insights — plan

Status (2026-11-06): **Phase CV-0 (decide) AGREED with the user
2026-11-06: the §2 design and the recommended answer to every §3
question. Nothing built; CV-1b (ingest integrity) is next.** The
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
| **CV-1b Ingest integrity** | Sequence / rotation / ordering investigation of `sysError` ingestion (read-only); a parser fix if records are lost (reviewed, rehearsed, deployed by the user) | Cause of every sequence gap class explained; no record loss going forward, shown on raw file snapshots |
| **CV-1 Schema** | Migration 007: CV tables and `api.ge_cv_*` views; runner pre-checks, dry run, roundtrip; the user applies it | Applied; catalog unchanged outside the new objects |
| **CV-2 Extract** | CV rule registry, extract and backfill from `log.ge_cv_syserror` (read) into `insight.ge_cv_facts` | Per system and metric, counts exactly equal independent SQL; every code covered by a rule or the reviewed ignore list |
| **CV-3 Derive** | Daily, capabilities, clock offsets, code labels | Independent SQL equal |
| **CV-4 Findings** | Rules, replay, `verify-findings` for `ge_cv` | Independent SQL equal; findings reviewed with evidence |
| **CV-5 Prod** | Stage after `ge_cv_parsers`, kill switch, rehearsal, deploy, 7-day monitoring | As CT §15.4 |
| **CV-6 Viewer** | "GE CV Insights — Internal" | As CT §16.4 |

Checkpoints for the user's go-ahead: the answers to §3; before each
migration is applied; before any `index.js` / parser change; before each
deploy; before every commit, in either repo.
