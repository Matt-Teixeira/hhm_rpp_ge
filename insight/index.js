"use strict";
// The ge_ct insight stage (PLAN-CT-INSIGHTS.md §2, §15.2), called from the
// repo's index.js on_boot() after the system loop, for GE_CT only:
//
//   await run_ct_insight(run_log, addLogEvent)
//
// - Off unless INSIGHT_ENABLED=true. Off, it returns at once: it loads no
//   module, opens no connection and logs nothing, so the ge_ct run is
//   exactly what it was before (§15.3 Q1).
// - On: the shared wrapper (./stage_wrapper.js, since MRI-5b,
//   PLAN-MRI-INSIGHTS.md §12) runs ./stage.js with CT's cfg below. The
//   wrapper never rejects (every failure is an ERROR event in run_log and
//   the ge_ct run carries on; the next run catches up from the watermarks),
//   opens its own insight_writer pool with bounded connect / statement /
//   query times and a 5-minute deadline for the whole stage, takes one
//   advisory lock (load.js LOCK_KEY; held = skip) and skips on a preflight
//   failure (the writer role, schema version >= 5) with a WARN.
// - The steps (insight/stage.js): extract (late-commit re-read + at most one
//   50k batch) -> derive (touched days) -> findings (touched systems; all
//   systems on the first run of a new UTC date). Each step's counts and ms
//   go to run_log.
//
// The cfg reproduces the wrapper this file held until MRI-5b exactly: the
// application name, "insight" in the lock and deadline texts, the rules
// registry loaded before connecting, and the partition WARN text
// (~/cv_d3b_evidence/mri/mri5b/equiv: identical in every scenario).

const FUNC = "run_ct_insight";
const APP_NAME = "insight_stage";
const LABEL = "insight";
// Typical run ~9 s, catch-up ~21 s, full rebuild of all systems ~28 s (§15
// rehearsal); the wrapper's deadline is 5 minutes.

const enabled = () => process.env.INSIGHT_ENABLED === "true";

// WARN texts from the stage preflight result (the run goes on).
function preflight_warnings(pre) {
  return pre && pre.partition_warning
    ? [`insight.ge_ct_facts partitions end at ${pre.last_partition} (${pre.months_left} months left): add partitions`]
    : [];
}

// deps (tests only): { connect, stage, rules, deadline_ms, wrapper }
async function run_ct_insight(run_log, addLogEvent, deps = {}) {
  if (!enabled()) return { skipped: "disabled" };
  try {
    const { run_insight_stage } = deps.wrapper || require("./stage_wrapper");
    return await run_insight_stage({ func: FUNC, app_name: APP_NAME, label: LABEL, load_stage: () => require("./stage"), run_args, preflight_warnings },
      run_log, addLogEvent, deps);
  } catch (e) {
    // only a failed require of the wrapper gets here (it never rejects)
    try {
      await addLogEvent("ERROR", run_log, FUNC, "CATCH", { step: "stage" }, e);
    } catch (_) {
      // logging must never fail the ge_ct run
    }
    return { error: e.message };
  }
}

// CT's rules registry, loaded before the connection (deps.rules in tests).
// Below run_ct_insight, which only calls it once the switch is on.
const run_args = (deps) => ({ rules: deps.rules || require("./rules/ge_ct").rules });

// The timeout constants, as before MRI-5b: read from the wrapper only when asked,
// so requiring this file still loads nothing.
const CONSTANTS = ["STATEMENT_TIMEOUT_MS", "CONNECT_TIMEOUT_MS", "QUERY_TIMEOUT_MS", "STAGE_DEADLINE_MS"];
module.exports = { run_ct_insight, enabled, preflight_warnings, run_args, FUNC, APP_NAME, LABEL };
for (const k of CONSTANTS) Object.defineProperty(module.exports, k, { enumerable: true, get: () => require("./stage_wrapper")[k] });
