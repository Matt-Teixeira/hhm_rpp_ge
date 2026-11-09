# Review handoff: CV-3 derive (GE CV daily rollup and code labels)

Everything is **uncommitted** on `dev` (on top of bc96621), together with
CV-2 (`REVIEW-CV2-EXTRACT-HANDOFF.md`). This review is about the derive
files only. Please write your findings to `REVIEW-CV3-DERIVE-CODEX.md`
next to this file.

```
cd ~/hep3/hhm_rpp_ge
cat insight/cv/derive.js insight/cv/verify_derive.js insight/cv/test/derive.test.js   # new
git diff --no-index /dev/null insight/cv/cli.js | grep -n 'derive'                    # the derive commands in the (new) CLI
node insight/cv/test/derive.test.js && node insight/cv/test/cv.test.js                # no DB needed
```

**Out of scope; don't edit:** `PLAN-CV-INSIGHTS.md`. The design is in
§9, with the extract in §8. Read them for context, and comment on design
points in your findings.

**Don't run** `insight/cv/cli.js` (any command) or `migrations/run.js`.
The repo `.env` targets the production database.

## What this is

The derive builds `insight.ge_cv_daily` and `insight.ge_cv_codes` (both
from migration 007) from the facts written by the CV-2 extract. It
follows CT's derive, much simplified. Nothing the GE CT run loads
requires it.

**Daily:**
- **Scope:** the device days the extract recorded as pending in
  `job_state 'ge_cv_derive'.last_run_stats.pending`. "full", or more
  than 31 days, rebuilds the whole system.
- **One transaction per system:** delete and rebuild those days, then
  clear the system's pending entry.

**Codes:**
- Rebuilt in full whenever something was pending.
- **Label:** the most common readable debug-text template of the code,
  taken from the source rows behind the `cv.error` facts. The join is on
  the source primary key, and encoded fields are never read.

**Rehearsal:** one transaction, rolled back:
- a full rebuild;
- a second pass, which must be byte-identical;
- a touched-days pass over each system's last 7 days, which must equal
  the full rebuild;
- verify.

**Verify:** four checks, all from the source (plan §9.2).

## How it was checked (plan §9.3)

On a local throwaway PostgreSQL 14, with the real rows and the facts
from the CV-2 rehearsal:
- the rehearsal is identical on both repeat passes, verifies with 0
  differences in every check, and persists nothing;
- apply clears the pending days;
- a new device day is rebuilt alone;
- `--full` gives byte-identical contents.

Tests: 8 new, plus 14 in `cv.test.js`; every existing suite still passes.

## Please look at

1. **Independence of the check:**
   - Check D rebuilds the label template in PostgreSQL regexes. Does
     `TPL` / `READABLE` in `verify_derive.js` really equal `template()` /
     `readable()` in `derive.js` for all input? Look at `\b` vs `\m` /
     `\M`, `\s` vs `[[:space:]]`, the lookahead, `$` at the end, and
     `slice` vs `left` on non-ASCII text.
   - Could a shared mistake pass both checks A and C?
2. **Daily correctness:**
   - the `host_local` range join for pending days;
   - `value_last` ordering;
   - a day that loses all its facts: is its row removed?
   - The device day is `host_local::date`, while the check uses the
     source `host_date`. Are these always equal?
3. **Pending bookkeeping:**
   - `derive_system_tx` reads pending with FOR UPDATE and removes the
     system with `#-`; `write_last_run` merges `last` and keeps
     `pending`.
   - Can an extract that runs between the read and the clear lose a
     day? (Both take the same advisory lock.)
   - What happens when the extract adds days for a system the derive is
     processing?
4. **Codes:**
   - Full rebuild on every run with something pending: cost at 18
     systems.
   - The LEFT JOIN when source rows are gone (log retention): n still
     counts, the label comes only from surviving rows. Is that right, and
     what does check D do then (it reads the source only)?
   - Mode tie-breaks: JS code-unit order vs `COLLATE "C"`.
5. **Clock decision K1** (plan §9.4, for the user): is keeping no CV
   clock table in v1 safe for daily and for the planned findings?
6. **Gaps** before CV-4 (findings) can build on daily and codes.
