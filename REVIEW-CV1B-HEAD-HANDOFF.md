# Review handoff: CV-1b follow-up (store the file-identity key on runs that insert nothing)

Repo **`hhm_rpp_ge`**, branch `dev`. The change is **uncommitted**, on top
of `b0bc513` (CV-1b parser fix; deployed to prod 2026-11-06 17:24 UTC).
Please write findings to `REVIEW-CV1B-HEAD-CODEX.md` next to this file.

```
git diff -- read/syserror_file.js jobs/CV/sysError_parser.js test/syserror_file.test.js
```

The `PLAN-CV-INSIGHTS.md` diff in the working tree is a status note; it
is not part of this review.

## What prod showed after the deploy (runs at 17:48 and 18:18 UTC)

The parser stores `<sme>.sysError.log.head`, the file's first data line,
only after a successful insert. Two things followed from that.

1. **Idle systems never get the key.** 12 of the 13 CV systems that have a
   file logged `no_new_data` and returned before the store. For them the
   new-file check stays size-only for as long as the device writes
   nothing. A new file that outgrows the old watermark before a parser run
   sees it would then be read from the old offset: the G4 loss of plan
   §5.2. SME08640 logged 5 new lines at 18:18 and has the key, verified
   equal to the file's first line.
2. **Warning noise.** `getRedisLine` (shared `redis/redisHelpers.js`,
   unchanged) logs `WARN … No line returned from Redis` whenever the key is
   missing. That is every run, for every CV system without the key,
   including the 5 that have no file at all.

## The change

- `read/syserror_file.js`: new pure `store_head_early({reason, consumed,
  prev_head, file_head})`. It returns true only when:
  - the file has a non-empty first line;
  - that line differs from the stored one;
  - and reason is `no_new_data`, or `append` with `consumed === 0` (only a
    partial line after the watermark).

  On a full read (`new_file`, `shrunk`, `no_watermark`) it is always false.
  If that read's insert failed, an early-stored new head next to the old
  watermark would make the next run append from the wrong offset.
- `jobs/CV/sysError_parser.js`:
  - Redis (watermark and head) is read **after** the file-present check.
  - Both early returns (`plan.start === null`, and `consumed === 0`) now
    call `remember_head`, which writes the key when `store_head_early`
    says so.
  - The normal path (store after the insert) is unchanged.
- Test: `store_head_early` covers every reason, plus prev_head
  null / undefined / equal and file_head null / undefined / "".

## Verified by the author

- `node --test test/`: all 6 files pass (`syserror_file.test.js`: 11
  subtests).
- Read-only rehearsal against prod Redis and files (scratchpad
  `rehearse_head.js`):
  - all 12 idle systems: `no_new_data`, watermark == size and on a line
    boundary, `store_head_early` true, first line is sequence 1;
  - SME08640: false (key already stored);
  - the 5 systems with no file: return before any Redis read.

## Questions for the reviewer

1. Is storing the head on `no_new_data` / partial-only `append` safe under
   the same assumption the first post-deploy append already makes? The
   assumption: when the key is unknown, the file at the watermark is the
   file the watermark was measured on. Is there a sequence (Redis error,
   `getRedisLine` returning `undefined`, a file replaced between runs)
   where it stores a head that doesn't belong to the watermark?
2. Does moving the Redis reads after `open_syserror` change behaviour for
   any path, given that `getRedisFileSize` has no side effects?
3. Any case where `remember_head` runs on a path that should leave Redis
   untouched?
