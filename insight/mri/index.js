"use strict";
// The GE MRI insight stage (PLAN-MRI-INSIGHTS.md §11.2 item 2), to be
// called from the repo's index.js on_boot() after the system loop, for
// GE_MRI only (the hook comes after the CV-5 close-out, §11.5 step 2):
//
//   await run_mri_insight(run_log, addLogEvent)
//
// - Off unless INSIGHT_MRI_ENABLED=true (its own switch, §11.3 Q5). Off, it
//   returns at once: it loads no module (not even the shared wrapper),
//   opens no connection and logs nothing, so the GE_MRI run is exactly what
//   it was before.
// - On: the shared wrapper (../stage_wrapper.js: never rejects, its own
//   insight_writer pool, bounded times, a 5-minute deadline, the MRI lock
//   load.js LOCK_KEY for the whole stage, preflight WARN and skip) runs
//   ./stage.js: extract (late-commit re-read + at most one 50k batch) ->
//   derive (pending days, code labels if owed) -> findings (all systems,
//   default mode). Each step's counts and ms go to run_log.

const FUNC = "run_mri_insight";
const APP_NAME = "insight_mri_stage";
const LABEL = "GE MRI insight";

const enabled = () => process.env.INSIGHT_MRI_ENABLED === "true";

// WARN texts from the stage preflight result (the run goes on).
function preflight_warnings(pre) {
  return pre && pre.partition_warning
    ? [`insight.ge_mri_facts partitions end at ${pre.last_partition} (${pre.months_left} months left): add partitions (plan §6.6)`]
    : [];
}

// deps (tests only): { connect, stage, deadline_ms, wrapper }
async function run_mri_insight(run_log, addLogEvent, deps = {}) {
  if (!enabled()) return { skipped: "disabled" };
  try {
    const { run_insight_stage } = deps.wrapper || require("../stage_wrapper");
    return await run_insight_stage({ func: FUNC, app_name: APP_NAME, label: LABEL, load_stage: () => require("./stage"), preflight_warnings },
      run_log, addLogEvent, deps);
  } catch (e) {
    // only a failed require of the wrapper gets here (it never rejects)
    try {
      await addLogEvent("ERROR", run_log, FUNC, "CATCH", { step: "stage" }, e);
    } catch (_) {
      // logging must never fail the GE_MRI run
    }
    return { error: e.message };
  }
}

module.exports = { run_mri_insight, enabled, preflight_warnings, FUNC, APP_NAME, LABEL };
