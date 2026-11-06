# Review handoff: CV-1b parser fix (GE CV sysError.log record loss)

Repo: `hhm_rpp_ge`, branch `dev`. The change is **uncommitted** in the
working tree, on top of `7a88b17`. Nothing has been written to the DB or
to Redis. The code has run only in tests, an offline simulation and a
read-only prod rehearsal. Please write findings to
`REVIEW-CV1B-PARSER-CODEX.md`.

## What to review

```
git status --short    # 1 modified, 6 new (+ this handoff, PLAN-CV-INSIGHTS.md §5)
git diff jobs/CV/sysError_parser.js
```

| File | What |
|---|---|
| `jobs/CV/sysError_parser.js` | Rewritten acquisition and persist steps (the per-line parse moved out) |
| `read/syserror_file.js` (new) | `open_syserror` (one fd: size, first data line, `read_from`); pure `plan_read`, `complete_lines`, `first_data_line` |
| `persist/drop_already_ingested_cv.js` (new) | Duplicate guard; CV twin of `persist/drop_already_ingested.js` (CT) |
| `jobs/CV/sysError_parse.js` (new) | Per-line parse, logic unchanged from the old parser loop |
| `test/syserror_file.test.js`, `test/drop_already_ingested_cv.test.js`, `test/sysError_parse.test.js` (new) | `node --test test/` |

Background: `PLAN-CV-INSIGHTS.md` §5 (evidence, gap classes G1–G5, the
simulation). The CT precedent is `PLAN-CT-INSIGHTS.md` §11.4 with
`persist/drop_already_ingested.js` and `read/gesys_head.js`.

## The defects (proven on prod data, §5.2)

The old CV read path is `acquisition/GE_CT_CV_MRI.js` `getFileData`:
- Redis holds the file size, re-measured after the insert;
- `tail -c delta` when the file grew;
- a whole-file read when it shrank or has no key;
- no duplicate guard.

| | Defect | Records lost |
|---|---|---|
| G4 | GE starts a new `sysError.log` at sequence 1. If the new file outgrows the old watermark before the next run, `tail -c delta` reads only its end. | 3,678 (2026-07-10, 2026-09-18) |
| G5 | The watermark counted bytes after the last newline, so the next read started inside a record. The record is either dropped as a fragment or stored with a cut `sequencenumber` (1052 → 52). | 35 lost, 3 wrong |
| (latent) | Any whole-file read of a partly ingested file re-inserts it: a short copy from an interrupted in-place download, a lost Redis key, a retry. | 0 so far; simulation: whole files |

## The fix

1. **`plan_read`.** Rules, in order:
   - no valid watermark (null, NaN, 0, negative, non-integer) → read
     from 0;
   - file smaller than the watermark → read from 0 (`shrunk`);
   - first data lines known on both sides and different → read from 0
     (`new_file`, the G4 fix; the CV file has no epoch header, and the
     first data line holds sequence 1 + a ms timestamp);
   - same size → nothing to read;
   - otherwise → read from the watermark.

   An unknown first line on either side (first run after deploy, or a
   new file whose first record is still incomplete) falls back to the
   size rules, i.e. today's behaviour.
2. **`complete_lines`.** Only bytes up to the last `\n` are parsed. The
   new watermark is `start + consumed`, never a re-measured size (the
   G5 fix). A trailing partial line is read again next run.
3. **One descriptor.** Size, first line and data come from one `open()`.
   If the collector replaces the file meanwhile (it writes a new inode),
   the run still sees one consistent file.
4. **`drop_already_ingested_cv`.**
   - Before the insert, it drops parsed rows whose 18 parsed columns
     already exist for this system within the batch's `host_datetime`
     span. Values are compared as text, with integer columns normalised
     the way Postgres stores them.
   - Rows without `host_datetime` are never dropped.
   - It fails open (all rows inserted, error logged).
   - The insert is skipped when nothing is new. Before, `pgp.helpers.insert`
     threw on an empty array, so Redis never advanced.
5. **Unchanged:**
   - the regex and the row built per line;
   - the Redis key name and value format of the watermark (a byte
     offset; new key `<sme>.sysError.log.head`);
   - the order parse → insert → Redis → `offline_hhm_conn` upsert (from
     the last parsed row);
   - `gzip_n_save` in `jobs/CV/index.js`.
6. **Not touched** (CT Phase 5 monitoring until 2026-11-12):
   `acquisition/GE_CT_CV_MRI.js`, `redis/redisHelpers.js`, `index.js`,
   `insight/`. The CV parser just stops calling the shared size / tail /
   update methods.

## Already verified (by the author)

- **Tests:** `node --test test/` (Node 16): all 6 files pass, including
  the existing CT tests.
- **Simulation on the 194 real snapshots in `log.saved_files`** (scripts
  `sim.js`, `recon.js` in the author's session scratchpad
  `/tmp/claude-1018/-home-matt-teixeira-hep3-hhm-rpp-ge/1894fa50-36db-4fcc-bd12-e9b53eaca8df/scratchpad/`):
  - an emulation of the old parser reproduces the DB rows of all 192
    captures exactly;
  - the new code produces the same rows, with `host_datetime` equal on
    all 288;
  - under injected faults on real bytes the new code loses 0 and inserts
    0 duplicates. Old code: 8,487 / 8,530 lost on partial lines, 3,012
    of 3,984 lost on G4, 115,016 re-inserted on short copies. Full table
    in plan §5.4.
- **Read-only prod rehearsal:** a forced whole-file read of both live
  files parses 2,978 + 83 rows; the guard finds all of them already
  stored (would insert 0).

## Questions for the reviewer

1. **Can any path still advance the watermark past bytes that were never
   parsed?** Consider insert failure, guard failure, a Redis write
   failure between the two `updateRedisLine` calls, and a file replaced
   between `stat` and `read`.
2. **Is the first data line a safe file identity?**
   - Can a new file have the same first line as the old one?
   - Can a non-rotated file's first line change?
   - What happens when a copy is cut inside the first data line (head
     null, `shrunk`)?
3. **Guard key.** Is matching all 18 parsed columns as text right?
   - Integer normalisation: `"007"` vs stored `7`.
   - `host_date` (a `date` column, selected `::text`).
   - Quoted `debugtext`, and `DL ` with its trailing space.
   - `mapDataToSchema` turns `''` into null.
4. **Order of the two Redis writes** (watermark, then head). A crash
   between them leaves the old head with the new offset. Is the next run
   still correct?
5. **The `generateDateTime` replacement** in `sysError_parse.js`
   (`dateTimeTemplate`, same pattern and default zone). Is it equivalent,
   including the null / undefined cases?
6. **Anything in the new log events** that could flood the run log? For
   example, the "File ends inside a line" warning on every run of a file
   that never gets a final newline.
