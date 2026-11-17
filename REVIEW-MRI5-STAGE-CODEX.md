# MRI-5 step 1 review

Reviewed commit `c32513f` against `b307573` on 2026-11-17.

CT loses no behavior that I could identify when its existing wrapper is
expressed through the shared helper with the correct CT configuration.
The comparison harness passed all 12 scenarios for CT and all 12 for CV.
This commit does not move either live caller; that migration still needs
its own review in MRI-5b. I found one low-priority issue in MRI's rehearsal
failure reporting, with no effect on the live wrapper.

## Finding

### P3 — Aggregate completed rehearsal runs after an early failure

Location: `insight/mri/stage.js:225-232`.

`runs` contains every planned run before execution starts. If catch-up or
the typical run fails, the loop breaks, leaving later entries without
`steps`. The `findings_drift` reduction then reads `r.steps.findings` from
one of those entries and throws `Cannot read properties of undefined
(reading 'findings')`. `last` also points to an unexecuted entry.

Confirmed with a DB-free fake connection: watermark 100, pending maximum
120, last-run start 111, and an extract step throwing `natural-key conflict
probe`. The original failure is logged, but `rehearse_stage` rejects with
the secondary TypeError instead of returning its structured failed
rehearsal result. Rollback and advisory unlock still occur; the
post-rollback watermark check and the CLI's normal result summary are
never reached.

Track completed runs separately, or explicitly handle unexecuted entries
and select the last completed run. Add coverage for a failure in the
first and middle rehearsal runs. This pattern also exists in CV's
rehearsal; it is copied into the new MRI file here. No CV edit is needed
in this review's scope.

## CT and the shared wrapper

- **Rules:** `run_args` executes after the stage module loads and before
  connecting, matching CT's current order. Returning
  `{ rules: deps.rules || require("./rules/ge_ct").rules }` from CT's
  caller preserves the injected/default registry behavior. Spreading
  those arguments before `now` and `run_id` preserves the option order
  `rules`, `now`, `run_id`. A separate probe confirmed that a rules-load
  failure produces an ERROR and returns without connecting.
- **CT configuration matters:** use `func: "run_ct_insight"`,
  `app_name: "insight_stage"`, and **`label: "insight"`**. That label
  preserves CT's exact existing lock-skip and deadline messages. Its
  `preflight_warnings` callback must retain the current
  `insight.ge_ct_facts partitions end at … (… months left): add partitions`
  warning and return an empty array when no warning is due. All of these
  differences are representable without changing the helper.
- **Execution and cleanup:** the dedicated writer connection, per-stage
  lock, preflight WARN/skip, step and summary events, UUID handling,
  10-second connect limit, 120-second statement limit, 135-second query
  backstop, 5-minute deadline, socket kill, suppression of later events,
  and connection/pool cleanup carry over. Error and logger rejection
  handling match the existing body in the reviewed paths.
- **Caller responsibilities:** MRI-5b must retain CT's switch check
  before requiring the helper and preserve its existing public exports,
  including `enabled` and the timeout constants. The helper deliberately
  has no modality switch. Review the actual thin caller then; equivalence
  of a configured helper does not prove a caller that has not been built.
- **Invalid configuration:** treating it as an ERROR inside the wrapper
  is appropriate. It is a programming/configuration failure, while the
  ingest's failure boundary still requires catching it and continuing.

## Other reviewed concerns

- **Off loads nothing:** MRI's implementation returns before either
  require. The existing cache test proves that the wrapper stays
  unloaded, but it cannot independently prove that `./stage` stays
  unloaded because the suite already requires that module. A fresh-process
  `Module._load` probe confirmed that requiring MRI's index and invoking
  it with the switch unset loads no dependency and emits no event.
- **Preflight and recovery:** the stage uses the extract apply preflight
  (limited writer, schema 9, C1-MRI and C2-MRI) and requires an existing
  extract watermark. It cannot initiate the initial backfill. Existing
  derive backlog is intentionally recoverable: extract records pending
  work, derive processes it, and findings runs only after derive succeeds
  and its own apply preflight accepts the state.
- **Extract:** the stage reuses `apply_range`, including late re-read,
  conflict refusal, and transactional batch/watermark/pending writes.
  The default limit is one 50k batch. `behind_ids` correctly measures the
  source maximum minus the resulting watermark even when rehearsal
  `to_id` intentionally bounds the read below that maximum; it measures
  source lag rather than the remaining rehearsal subrange.
- **Rehearsal isolation and scope:** stage and findings rehearsals use
  REPEATABLE READ. Nested step transactions become savepoints under the
  outer rollback. `OTHERS_SQL` covers all non-MRI rows of the four shared
  tables using their source/key namespaces; `ge_mri_` is seven characters.
  These predicates do not use a backslash or a LIKE underscore wildcard.
  The planned catch-up run is conditional on an older pending range, so
  a rehearsal can legitimately have two runs. Apart from the failure
  reporting issue above, the checks cover the stated success criteria.
- **Code-label cost:** I would ship the current rebuild approach using
  the handoff's measured 7.5–10-second rebuild and 30-minute cadence,
  with the existing 30-second warning and planned monitoring. That cost
  does not justify introducing a new incremental algorithm before this
  stage ships. Deferring labels would also keep the findings preflight
  closed while they are owed. The timings and growth figures are supplied
  evidence, not measurements independently repeated in this review.
- **Fixtures:** the new test strings use synthetic system IDs and host
  placeholders; I found no apparent production identifiers or message
  payloads in the added tests.

## Verification

All six suites requested in the handoff passed: MRI stage (25), MRI
findings (27), MRI core (23), CT stage (24), CV stage (27), and CV core
(17): **143 tests total**.

Read and ran the DB-free equivalence harness at
`~/cv_d3b_evidence/mri/mri5/equiv.js`: **24/24 comparisons identical** in
return values, normalized run-log events, connection calls/options, and
stage argument keys/rules. Its comparison normalizes elapsed times and
generated UUID values. Also ran the three targeted probes described
above: fresh-process disabled loading, rules-load failure, and the early
rehearsal failure.

No CLI entrypoint, migration runner, database connection, or production
command was run. Only this review file was added; implementation and
`PLAN-MRI-INSIGHTS.md` were left unchanged.
