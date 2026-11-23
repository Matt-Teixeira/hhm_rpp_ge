"use strict";
// The GE CV insight stage (PLAN-CV-INSIGHTS.md §12.2), called from the
// repo's index.js on_boot() after the system loop, for GE_CV only:
//
//   await run_cv_insight(run_log, addLogEvent)
//
// - Off unless INSIGHT_CV_ENABLED=true (its own switch, §12.3 Q1). Off, it
//   returns at once: it loads no module, opens no connection and logs
//   nothing, so the GE_CV run is exactly what it was before.
// - On: the shared wrapper (../stage_wrapper.js, since MRI-5b,
//   PLAN-MRI-INSIGHTS.md §12; until then this file held a copy of CT's)
//   runs ./stage.js with CV's cfg below. The wrapper never rejects (every
//   failure is an ERROR event in run_log and the GE_CV run carries on; the
//   next run catches up from the job state), opens its own insight_writer
//   pool with bounded connect / statement / query times and a 5-minute
//   deadline for the whole stage, takes one advisory lock (cv/load.js
//   LOCK_KEY; held = skip) and skips on a preflight failure (the writer
//   role, C1, C2, schema version >= 8) with a WARN.
// - The steps (./stage.js): extract (late-commit re-read + at most one 50k
//   batch) -> derive (pending days, code labels) -> findings (all systems,
//   default mode). Each step's counts and ms go to run_log.
//
// The cfg reproduces the wrapper this file held until MRI-5b exactly: the
// application name and "GE CV insight" in the lock and deadline texts; no
// run_args, no preflight warning (~/cv_d3b_evidence/mri/mri5b/equiv:
// identical in every scenario). Typical run ~2-3 s (§12.1).

const FUNC = "run_cv_insight";
const APP_NAME = "insight_cv_stage";
const LABEL = "GE CV insight";

const enabled = () => process.env.INSIGHT_CV_ENABLED === "true";

// deps (tests only): { connect, stage, deadline_ms, wrapper }
async function run_cv_insight(run_log, addLogEvent, deps = {}) {
  if (!enabled()) return { skipped: "disabled" };
  try {
    const { run_insight_stage } = deps.wrapper || require("../stage_wrapper");
    return await run_insight_stage({ func: FUNC, app_name: APP_NAME, label: LABEL, load_stage: () => require("./stage") },
      run_log, addLogEvent, deps);
  } catch (e) {
    // only a failed require of the wrapper gets here (it never rejects)
    try {
      await addLogEvent("ERROR", run_log, FUNC, "CATCH", { step: "stage" }, e);
    } catch (_) {
      // logging must never fail the GE_CV run
    }
    return { error: e.message };
  }
}

// The timeout constants, as before MRI-5b: read from the wrapper only when asked,
// so requiring this file still loads nothing.
const CONSTANTS = ["STATEMENT_TIMEOUT_MS", "CONNECT_TIMEOUT_MS", "QUERY_TIMEOUT_MS", "STAGE_DEADLINE_MS"];
module.exports = { run_cv_insight, enabled, FUNC, APP_NAME, LABEL };
for (const k of CONSTANTS) Object.defineProperty(module.exports, k, { enumerable: true, get: () => require("../stage_wrapper")[k] });
