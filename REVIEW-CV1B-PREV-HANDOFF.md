# Review handoff: CV-1b D5/D6 (recover the old file's tail from GE's sysErrorPrev.log)

Two repos; everything is **uncommitted**. Please write findings to
`REVIEW-CV1B-PREV-CODEX.md` next to this file.

```
cd ~/hep3/hhm_rpp_ge
git diff -- read/syserror_file.js jobs/CV/sysError_parser.js test/syserror_file.test.js
cat maintenance/backfill_ge_cv_prev_tail.js          # new

cd ~/hep3/hhm_data_acquisition                       # branch DEV, on top of a5713d9
git diff -- read/sh/GE/ge_cv_21.sh read/sh/GE/ge_cv_22.sh read/sh/GE/ge_cv_22_1.sh read/sh/GE/ge_cv_22_2.sh read/sh/GE/ge_cv_22_3.sh
```

Out of scope, don't edit:
- the `PLAN-CV-INSIGHTS.md` diff (status notes);
- the user's WIP in `hhm_data_acquisition`: `db/normalize/prod/*.sql`
  and the untracked `handoff/`.

## Background (PLAN-CV-INSIGHTS.md §5.5 D3b)

The device listing on 2026-11-09 shows that GE keeps exactly one previous
generation of the log, `DL/Log/sysErrorPrev.log`. Rotation renames
`sysError.log` to `sysErrorPrev.log` after record 4000 (or earlier) and
starts a new `sysError.log` at sequence 1.

The user fetched both devices' `sysErrorPrev.log`. Checked byte for byte:
- the stored rows of the previous file equal the first N lines of
  `sysErrorPrev.log`;
- the stored part ends exactly at the old watermark (SME08640: 905,366);
- the rest is the never-ingested tail (gap class G3):
  - SME02412: seq 3655–4000, 346 records;
  - SME08640: seq 3986–4000, 15 records.

The user decided:
- **D5:** close G3 going forward;
- **D6:** backfill these 361 records once.

## D5 parser (`hhm_rpp_ge`)

- `read/syserror_file.js`: new pure `plan_prev_tail({reason, prev_offset,
  prev_head, file_head, prev_file})`.
  - It applies only to a read from 0 with reason `new_file` or `shrunk`,
    and a valid old watermark.
  - It is not a rotation if `shrunk` and the new file's first line equals
    the stored head (a shorter copy of the same file).
  - **read** from the old watermark only if `sysErrorPrev.log` exists, its
    first data line equals the stored `.head`, and it is longer than the
    watermark.
  - `none` if Prev is exactly the watermark long (old file fully read).
  - Otherwise **skip**, with a reason: `old_head_unknown`, `prev_missing`,
    `prev_is_another_file`, or `prev_shorter_than_watermark`.
- `jobs/CV/sysError_parser.js`, on such a run:
  - It waits (returns, Redis untouched) while the new file has no complete
    first record, so `.head` moves to the new file in the same run that
    handles the rotation.
  - Otherwise it opens `sysErrorPrev.log` (same folder; own descriptor,
    closed in `finally`) and reads the tail via `complete_lines`.
  - Tail rows and new-file rows are parsed separately and concatenated,
    old first. Then one duplicate guard and **one INSERT**, followed by
    the watermark/head update for the new file as before. A failed insert
    therefore leaves Redis unchanged, and the next run retries both.
  - A skip logs a WARN with the details, pointing at the D6 tool.
- Tests: `plan_prev_tail` covers each branch (`test/syserror_file.test.js`;
  13 subtests, all 6 files pass).

## D6 backfill (`hhm_rpp_ge/maintenance/backfill_ge_cv_prev_tail.js`)

The conventions follow `maintenance/dedupe_ge_ct_gesys.js`:
- dry run by default (BEGIN … INSERT … ROLLBACK);
- type the database name to proceed, and type APPLY to commit.

`plan_backfill` (exported):
- parses the whole file with the production parser, using the system's
  regex model and time zone from config;
- runs it through `drop_already_ingested_cv`;
- refuses unless all of these hold:
  - the copy is complete: header present, ends on a newline, first record
    is sequence 1;
  - every line parses;
  - part of the file is already stored;
  - the remaining rows are exactly the file's last N records, with
    contiguous sequence numbers;
  - N equals `--expect`.

The INSERT checks rowCount equals N, else ROLLBACK. Redis and `alert.*`
are not touched.

## D5 collector (`hhm_data_acquisition`, the same five scripts as a5713d9)

- A second per-run temp file, `$4/.sysErrorPrev.log.part.$$`. The trap
  removes both temp files; the sweep pattern is widened to
  `.sysError*.part*`.
- **lftp (`ge_cv_21.sh`), same session:**
  - `get sysErrorPrev.log -o $tmpp || !rm -f $tmpp;` comes **before**
    `get sysError.log -o $tmp`, so lftp's exit status, and therefore the
    run's classification, stays the main file's;
  - after rc 0, `[ -s $tmpp ] && mv` to `sysErrorPrev.log` (non-fatal),
    then the main `mv` as before.
- **scp (`ge_cv_22*.sh`):** only after the main transfer exits 0, a second
  `scp …/sysErrorPrev.log $tmpp >/dev/null 2>&1 && mv …` (non-fatal,
  output discarded), then the main `mv`.

## Verified by the author

- **Read-only rehearsal of D5 on the two real rotations** (scratchpad
  `rehearse_rotation.js`). It runs the parser modules with the
  pre-rotation Redis state, the real `sysErrorPrev.log`, the current
  file's first records, and the duplicate guard against prod.
  - SME08640: `shrunk` → read from 905,366 → 15 rows inserted (seq
    3986–4000), 3 new-file rows dropped as stored.
  - SME02412: 346 rows (seq 3655–4000), same shape, also with 400
    new-file rows.
- **Read-only rehearsal of D6** (`rehearse_backfill.js`).
  - SME02412: plan 346 (seq 3655–4000). SME08640: plan 15 (seq
    3986–4000).
  - Refused, as intended: a wrong `--expect`, a truncated copy (no final
    newline), the right file under the wrong system ("none of this file is
    stored"), the current file ("nothing to insert"), and an unknown
    system.
- **Collector harness** (`collector_test/`; lftp against `open file:/`,
  scp via a fake `sshpass` with separate outcomes for Prev):

  | Case | Result |
  |---|---|
  | lftp, both present | exit 0, both published, remote mtime kept |
  | lftp, Prev missing on device | exit 0, main published, no Prev, no leftovers. **New:** stderr now has a `get: Access failed … sysErrorPrev.log` line (no connection regex matches it) |
  | lftp, main missing | exit 1 as before; neither file replaced |
  | scp ×4: main ok, Prev ok | exit 0, both published |
  | scp ×4: main ok, Prev missing or partial (timeout) | exit 0, no output, main published, old Prev kept, no leftovers |
  | scp ×4: main fails (no match / partial) | same exit code and output as before; nothing replaced |

## Questions for the reviewer

1. **Parser.** Is there a sequence where the tail is read twice or into
   the wrong place? Consider:
   - an insert failure after a tail read;
   - two rotations between parser runs;
   - Prev refreshed by the collector between the parser's `open_syserror`
     calls;
   - the `file.head === null` wait;
   - a `shrunk` read whose new file is a partial copy of the same file.

   (The duplicate guard should make every re-read harmless.)
2. **Wait condition.** Can the "new file has no complete first record
   yet" wait stall ingestion indefinitely in a realistic case?
3. **Backfill.** Is the "suffix + contiguous + part stored" check
   sufficient to refuse a wrong file? Is the dry run's BEGIN/ROLLBACK
   (via the `tx` callback throwing) correct in pg-promise?
4. **Collector.**
   - lftp `||` and `!rm` inside `lftp -c`: any lftp version or setting on
     prod where a failed first `get` aborts the session (`cmd:fail-exit`)
     or changes the final exit status?
   - Any classification change from the extra stderr line when Prev is
     missing on the device?
5. **Load.** `sysErrorPrev.log` (≤1.4 MB) is now transferred every 30 min
   per system, and the scp scripts open a second SSH connection after a
   successful transfer. Acceptable, given plan §5.5 D4: SME02412's storms
   are phase-locked to our collection?

---

## Round 2: fix for REVIEW-CV1B-PREV-CODEX P2 (backfill vs concurrent inserts)

`maintenance/backfill_ge_cv_prev_tail.js` changes:
- **Re-check inside the INSERT's transaction.** After confirmation, it
  first takes `pg_advisory_xact_lock(hashtext('ge_cv_prev_tail_backfill:<sme>'))`,
  which serializes backfills of one system. It then runs `plan_backfill`
  again on the transaction handle (read committed: it sees rows committed
  since the first plan). It rolls back unless the re-check has no problems
  and the same N rows and sequence range. The INSERT uses the re-checked
  rows.
- **Keeping clear of the live parser.** `--apply` is refused in minutes
  :15–:23 and :45–:53, around the parser's :18/:48 cron runs. The CT
  precedent is `dedupe_ge_ct_gesys.js` ("run it between alert-processor
  runs").
- **Why the parser can't insert these rows anyway.** D5 reads
  `sysErrorPrev.log` only on a rotation it detects, and only when Prev's
  first line equals the stored `.head`, i.e. the current file's first
  line. The backfill's rows come from older files (2026-10-20,
  2026-11-04). So the parser can only race a backfill of a rotation that
  happens during the backfill itself; the re-check covers that.
- **Rehearsed read-only:**
  - the in-transaction re-check returns the same plan for both systems
    (346 / 15);
  - window check: refuse at :15, :18, :23, :45, :48, :53; allow at :14,
    :24, :44, :54.
  - The rehearsal also caught a bug: `t.none()` on the lock SELECT throws
    ("No return data was expected"); fixed to `t.one()`.
