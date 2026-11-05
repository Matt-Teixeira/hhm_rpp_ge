# Review handoff: Phase 5 monitoring fix (findings drift on a partly filled resolve day)

Repo: `hhm_rpp_ge`, branch `dev`. The change is **uncommitted** in the
working tree, on top of `c8d15df`. Nothing has been written to the
database. The fix has only run inside rolled-back rehearsals; the summary
is below.

## What to review

```
git status --short    # 2 modified, this handoff new
git diff              # insight/findings/run.js, insight/test/findings.test.js
```

| File | What |
|---|---|
| `insight/findings/run.js` | new `resolved_final` (line 131) and pure `reconcile` (line 137); `findings_system` (line 157) now calls it; header comment updated |
| `insight/test/findings.test.js` | new test at line 393 |

Background: `PLAN-CT-INSIGHTS.md` §14.7 ("Implementation choices": the
default run "never changes a resolved finding; a disagreement on any
column is reported as drift"; `last_evaluated` = newest fact on
`data_through`) and §15.4 (exit criterion: "Default findings runs report
0 drift"). `insight/findings/state.js` `windowed_row` (around line 52)
sets `data_through` and `last_evaluated` for a resolved row.

## The defect (found in prod monitoring, 2026-11-05)

The live stage runs every 30 min (:18/:48 UTC). The 05:48 UTC run
resolved `SME01430 abort_rate_high` (opened 2026-09-25) on the first
facts of the device day 2026-11-05. It stored `last_evaluated`
05:13:01Z, the newest fact of that day so far. Every later run that
evaluated SME01430 (06:18, 06:48, 10:18, 10:48) reported
`drift 1: resolved finding differs from the replay (kept)`.

The cause: the replay's `last_evaluated` for that row kept moving as the
day filled up (10:12:20Z at 10:48). Default mode never updates a resolved
row, so the drift would have lasted for as long as the row existed.

A read-only recompute confirmed that `last_evaluated` is the only column
that differs.

There's also a latent worse case. Facts arriving later on the resolve day
could trip the rule again. The replay would then keep the finding
**open**, while the stored row stayed resolved permanently.

The rehearsal's incremental check (as of today−28, −21, −14, −7, today)
couldn't catch this. Every as-of day it evaluates is complete except
today, and no finding resolved today in that check.

## The fix (agreed with the user 2026-11-05)

A stored resolved row is **final** only once its resolve day
(`data_through`) has left the system's evaluation window. That is, it is
at least `STALE_DAYS` (7) device days older than the system's newest data
day (`dnum(data_through) <= dnum(last_day) - 7`).

Until it is final, default mode treats it like an open row:
- updated to the replay;
- reopened if the replay has it open;
- deleted if the replay no longer produces it.

Final rows behave exactly as before: they are kept, and any difference is
reported as drift. Replay mode is unchanged.

The user agreed to a 2-day grace. The author widened it to the 7-day
evaluation window, to also cover a mid-day resolve followed by an outage
and a multi-day backlog. The user will be told; question 1 below covers
it.

## Already verified (by the author)

- **Tests:** all test files pass (`insight/test/*.test.js` 103 tests,
  `test/*.test.js`, `migrations/test/sqlscan.test.js`).
- **The new test detects the old behaviour:** it fails if
  `resolved_final` is changed to treat every resolved row as final.
- **`findings --rehearse` (default mode, fleet, rolled back):**
  - Pass 1 updated exactly one row (the SME01430 one) with drift 0.
  - Pass 2 made 0 changes.
  - The incremental runs reported drift 0, and their result was
    identical to pass 1.
  - verify-findings passed: 112 findings, 0 missing/extra/differ.
- **`stage --rehearse` (rolled back), overall OK:**
  - Default findings are identical to the replay as of 2026-11-05: 112 vs
    112, and the replay changed 0.
  - `findings_drift` 0.
  - Daily pass 10.2 s.

## Where to look hardest

1. **Is the window the right boundary?**
   - `last_day` is the system's newest data day as of `today`; device
     days after `today` (a clock ahead) are ignored.
   - Should finality be measured against that, or against `today`?
     Consider a system that resolves a finding mid-day and then stops
     sending. It goes stale after 7 days and is no longer evaluated, so
     its row stays as last written. Is that acceptable?
   - Is 7 days right, compared with the agreed 2? What does a wider
     window cost: recently resolved findings can change for up to 7
     device days, and what does that mean for a customer-facing viewer?
2. **Deleting a non-final resolved row.** If the replay stops producing a
   resolved row inside the window, it is now deleted rather than
   reported as drift. Can that happen legitimately? `opened_at` comes
   from old data. Or could it destroy history that should be kept?
3. **Reopen path.** The stored row is resolved and the replay has the
   same key open. `ups` is sorted resolved-first before the upsert, and
   there is a one-open-per-key invariant. Can a reopen collide with
   another row of the same (system, key)? For example, if the replay
   also produces a different row for that key.
4. **`data_through` format.** `STORED_SQL` returns it as `to_char`
   `YYYY-MM-DD` text; `dnum` slices to 10 characters. Is there any path
   where `stored` rows come from elsewhere (a Date, or null)? Is a null
   `data_through` on a resolved row possible after migration 005?
5. **Interaction with `verify-findings`, the stage rehearsal and the
   `findings --rehearse --replay` "default after replay must change
   nothing" check.** Is there any state where default mode now changes
   rows that a just-applied replay wrote?
6. **The test.** Does it model the real case faithfully? It uses the
   replay as of a partly filled day, the as-stored shapes (`Date`s), and
   the window boundary at `last_day` = resolve day + 6 / + 7.

Out of scope: the rules, thresholds and the §14.2/§15 decisions are
settled. The stage mechanics (lock, pending, late-commit re-read) were
reviewed in PHASE5-STAGE.

## Ground rules (this machine is also the production server)

- **Don't run anything that connects to the database.** That includes
  `insight/cli.js` (all commands), `insight/tools/*` and
  `migrations/run.js` except `scan`. The DB results are summarised above.
- DB-free commands are fine: `node insight/test/findings.test.js` and the
  other test files.
- Don't open or print `.env`.
- Don't modify files. Report only.
- Don't touch `/home/prod/hhm_rpp_ge`.

## How to report

Write findings to `REVIEW-PHASE5-DRIFT-CODEX.md` in the repo root, in the
format of `REVIEW-CT-INSIGHTS-CODEX.md`: one `### F<n> — title` section
per finding, each with:
- Severity: high / medium / low
- Confidence: confirmed / likely / possible
- Location: `file:line`
- What's wrong
- Failure scenario
- Evidence (say whether you ran a probe or read the code)
- Suggested fix

Order findings most severe first. If you find nothing, say so explicitly.
