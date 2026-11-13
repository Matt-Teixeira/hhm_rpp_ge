"use strict";
// GE MRI rule registry (PLAN-MRI-INSIGHTS.md §5, agreed 2026-11-13 as
// Q-M1..Q-M10; the evidence per code is in PLAN-MRI-INSIGHTS-CODES.md).
//
// One deduped log.ge_mri_gesys record (natural key system_id, epoch,
// record_number_concurrent) ->
//   - an mri.error fact (dim = message_number), always, and
//   - the named-metric facts its code lists (at most two: the exam summary
//     2218650 gives mri.scans_ok and mri.scans_failed).
// Rules are pure: no DB, no clock. They read message_number, type, message,
// coil and psd. No fact stores message text (messages carry host names,
// PACS AE titles and operator free text); dims come from fixed lists or
// from process / software-version tokens.
//
// The catalog (insight.metric_catalog, keys mri.*) is generated from these
// objects (rules/engine.js catalog_rows). `category` is the catalog's
// (its CHECK allows CT's six); `group` is the reviewed MRI grouping
// (utilization / reliability / hardware / service / inventory), kept for
// insight.ge_mri_codes. Bump a rule's `version` whenever its output
// changes; facts are replaced only by a newer version.
//
// Nothing in the GE CT or CV run loads this file.
const { validate_rules, catalog_rows, process_of } = require("../rules/engine");

const text = (r) => (r.message === null || r.message === undefined ? "" : String(r.message));
const fixed = (d) => () => d;
const when = (re, d = "") => (r) => (re.test(text(r)) ? d : null);
// A process token from the message; a trailing "." is sentence punctuation.
const proc_from = (re) => (r) => { const m = re.exec(text(r)); return m ? m[1].replace(/\.$/, "") : null; };

const base = { value_kind: "event", unit: null, customer_visible: false, model_specific: false, version: 1 };

// The catch-all: every counted record. dim = the message code.
const error_rule = {
  ...base,
  key: "mri.error",
  label: "MRI log entries",
  category: "reliability",
  group: null,
  description: "Every counted GE MRI gesys record (deduped on system, epoch, record number), by message code (dim). attrs: process, coil, psd.",
};

// Prescan failure reasons, a reviewed list (plan §5.2); anything else is "other".
const PRESCAN_REASONS = [
  [/Driver Module error/i, "driver_module_error"], [/Please Try Again/i, "try_again"],
  [/signal (was )?too small/i, "signal_too_small"], [/data acquisition error/i, "data_acquisition_error"],
  [/IRF board clock or fiber/i, "irf_clock_fiber"], [/RF coil air temperature/i, "rf_coil_air_temp"],
  [/RF Hub RF\/bias setup/i, "rf_hub_setup"], [/Scan room door is open/i, "door_open"],
  [/Invalid coil connected/i, "invalid_coil"], [/Gradient(s| amplifiers)? (is|are) not ready/i, "gradient_not_ready"],
  [/Asynchronous stop scan/i, "async_stop"], [/Stop button was pressed/i, "stop_button"],
  [/Pause button was pressed/i, "pause_button"], [/table is not at scan plane/i, "table_not_at_scan_plane"],
  [/by Operator Request/i, "operator_request"], [/RF amplifier is not ready/i, "rf_amp_not_ready"],
  [/Data Acquisition Control/i, "dac_setup_failure"],
];
const PRESCAN_DIMS = [...PRESCAN_REASONS.map(([, d]) => d), "other"];
function prescan_reason(r) {
  const m = /Prescan failed,\s*([\s\S]*)$/.exec(text(r));
  if (!m) return null;
  for (const [re, d] of PRESCAN_REASONS) if (re.test(m[1])) return d;
  return "other";
}

const COIL_INVALID_DIMS = ["not_all_connected", "not_compatible", "coil_db_error", "info_incorrect", "wrong_port", "other"];
function coil_invalid(r) {
  const s = text(r);
  if (!/Invalid coil connected/.test(s)) return null;
  return /Not all connectors/.test(s) ? "not_all_connected"
    : /not compatible/.test(s) ? "not_compatible"
    : /Coil database access error|during coil validation/.test(s) ? "coil_db_error"
    : /Coil information for port [\s\S]* is incorrect/.test(s) ? "info_incorrect"
    : /not on this port/.test(s) ? "wrong_port" : "other";
}

const SCANS_RE = /No of Successful Scan = (\d+) , No of Failed Scan = (\d+)/;
const SYSTEM_UP_ATTRS = ["fieldStrength", "gradientAmp", "RFampType", "GradCoil", "GCoilType", "PowerMonType"];

// Named metrics. `codes` maps each code the rule can match to its matcher:
// (row) -> dim (string) | null. `value(row)` / `attrs(row)` are optional.
const named = [
  {
    ...base, key: "mri.scans_ok", group: "utilization", category: "utilization", unit: "scans",
    label: "Scans completed (per exam summary)",
    description: "Exam summary 2218650: value = 'No of Successful Scan'. n of these facts = exams (Q-M4); sum(value) = scans completed.",
    codes: { 2218650: when(SCANS_RE) },
    value: (r) => Number(SCANS_RE.exec(text(r))[1]),
  },
  {
    ...base, key: "mri.scans_failed", group: "utilization", category: "utilization", unit: "scans",
    label: "Scans failed (per exam summary)",
    description: "Exam summary 2218650: value = 'No of Failed Scan'.",
    codes: { 2218650: when(SCANS_RE) },
    value: (r) => Number(SCANS_RE.exec(text(r))[2]),
  },
  {
    ...base, key: "mri.exam_started", group: "utilization", category: "utilization",
    label: "Exams started", description: "'New Exam Started' (2218714).",
    codes: { 2218714: when(/^New Exam Started/) },
  },
  {
    ...base, key: "mri.sw_start", group: "reliability", category: "reliability",
    label: "System software starts", description: "'System Software is starting' (200002347).",
    codes: { 200002347: when(/System Software is starting/) },
  },
  {
    ...base, key: "mri.sw_stop", group: "reliability", category: "reliability",
    label: "System software stops", description: "'System Software has terminated' (200002348).",
    codes: { 200002348: when(/System Software has terminated/) },
  },
  {
    ...base, key: "mri.tps_reset", group: "reliability", category: "reliability",
    label: "TPS resets started", description: "'Reset/Download TPS In progress' (2227557).",
    codes: { 2227557: when(/Reset\/Download TPS In progress/) },
  },
  {
    ...base, key: "mri.tps_reset_failed", group: "reliability", category: "reliability",
    label: "TPS resets not successful", description: "'Reset/Download TPS was not successful' (2227556).",
    codes: { 2227556: when(/Reset\/Download TPS was not successful/) },
  },
  {
    ...base, key: "mri.process_death", group: "reliability", category: "reliability",
    label: "Process deaths (dim = process)",
    description: "Unexpected process deaths (200002354, 200002381, 200002356 except dsserver, 200002352; VRE crashes 2223878 as vre:<process>). Shutdown lines and 200002379 are not counted (Q-M2).",
    codes: {
      200002354: proc_from(/An unexpected death of (\S+) caused it to be restarted/),
      200002381: proc_from(/^Process (\S+), pid \d+ terminated by unexpected signal/),
      200002356: (r) => { const p = proc_from(/^(\S+) died unexpectedly/)(r); return p && p !== "dsserver" ? p : null; },
      200002352: proc_from(/HOST_SHUTDOWN was initiated by the death of (\S+)/),
      2223878: (r) => { const p = proc_from(/A process has crashed on the VRE[\s\S]*?Process: (\S+?),/)(r); return p ? `vre:${p}` : null; },
    },
  },
  {
    ...base, key: "mri.prescan_failed", group: "reliability", category: "reliability",
    label: "Prescan failures (dim = reason)",
    description: `'Prescan failed, <reason>' (2224666, 2224667, 2255008). dim from a reviewed list: ${PRESCAN_DIMS.join(", ")}.`,
    codes: { 2224666: prescan_reason, 2224667: prescan_reason, 2255008: prescan_reason },
  },
  {
    ...base, key: "mri.autoshim_inconclusive", group: "reliability", category: "reliability",
    label: "Autoshim inconclusive", description: "'Autoshim results inconclusive' (2224708).",
    codes: { 2224708: when(/Autoshim results inconclusive/) },
  },
  {
    ...base, key: "mri.coil_invalid", group: "hardware", category: "reliability",
    label: "Invalid coil connected (dim = reason)",
    description: `'Invalid coil connected' (2277604). dim: ${COIL_INVALID_DIMS.join(", ")}.`,
    codes: { 2277604: coil_invalid },
  },
  {
    ...base, key: "mri.coil_fault", group: "hardware", category: "reliability",
    label: "Coil faults (dim = kind)", description: "Coil bias / T/R driver / coil ID / connection faults.",
    codes: {
      2252301: fixed("bias_open_circuit"), 2274023: fixed("bias_open_circuit"), 2252395: fixed("bias_transmit"),
      2252305: fixed("tr_driver_open_circuit"), 103428: fixed("coil_id_comm"), 2273000: fixed("coil_id_missing"),
      2273015: fixed("disconnected_while_scanning"), 2276129: fixed("connection_error"),
    },
  },
  {
    ...base, key: "mri.cooling_fault", group: "hardware", category: "environment",
    label: "Cooling / environment alarms (dim = kind)", description: "Water flow, HEC coolant and cryo compressor, leak sensor, RF coil airflow, gradient coil temperature.",
    codes: {
      2266425: fixed("brm_water_flow"), 2266420: fixed("cabinet_water_flow"), 2261733: fixed("hec_coolant_temp_high"),
      2261732: fixed("hec_cryo_compressor_flow_high"), 2261731: fixed("hec_cryo_compressor_flow_low"), 2266402: fixed("leak_sensor_fault"),
      2268884: fixed("rf_coil_airflow"), 2248604: fixed("gradient_coil_temp_high"),
    },
  },
  {
    ...base, key: "mri.rf_amp_fault", group: "hardware", category: "reliability",
    label: "RF amplifier faults (dim = kind)", description: "RF amplifier fault, not operating, mode change, serial link, power supply.",
    codes: {
      101255: fixed("fault"), 2254050: fixed("fault"), 2248765: fixed("not_operate"), 2248775: fixed("mode_change"),
      2254352: fixed("serial_link_broken"), 2254204: fixed("power_supply"),
    },
  },
  {
    ...base, key: "mri.gradient_fault", group: "hardware", category: "reliability",
    label: "Gradient amplifier faults (dim = kind)", description: "SGA power supply, current distortion, wiring / control undervoltage, overtemperature, clock stop, data overrange.",
    codes: {
      2244860: fixed("sga_psu_overcurrent"), 2244862: fixed("sga_psu_undervoltage"), 2244857: fixed("sga_psu_power_off"),
      2244861: fixed("sga_psu_overvoltage"), 2244858: fixed("sga_psu_wiring"), 2244845: fixed("current_distortion"), 2244851: fixed("current_distortion"),
      2244847: fixed("wiring_or_control_undervoltage"), 2244573: fixed("wiring_or_control_undervoltage"), 2244850: fixed("undervoltage"),
      2244897: fixed("overtemperature"), 2250109: fixed("clock_stop"), 2250082: fixed("data_overrange"),
    },
  },
  {
    ...base, key: "mri.receiver_fault", group: "hardware", category: "reliability",
    label: "RF receive chain / clock / fibre faults (dim = kind)", description: "RRX detection and status, VRF error bits, IRF clock, reference clock, fibre links.",
    codes: {
      2267597: fixed("rrx_not_detected"), 2267412: fixed("rrx_missing"), 2270016: fixed("vrf_no_rrx_id"),
      2270023: fixed("vrf_error_bits"), 2270024: fixed("vrf_error_bits"), 2270028: fixed("vrf_error_bits"),
      2270031: fixed("rrx_fiber_link"), 2270032: fixed("rrx_status"), 2267425: fixed("irf_no_clock"), 2267432: fixed("refclk_missing"),
      2247184: fixed("irf_clock_fiber"), 2267637: fixed("agp_fiber_link"),
    },
  },
  {
    ...base, key: "mri.table_fault", group: "hardware", category: "reliability",
    label: "Patient table / cradle faults (dim = kind)", description: "Home switch, speed / velocity, oscillation, unexpected motion, clutch slip, no start, target miss, off plane while scanning.",
    codes: {
      103453: fixed("home_switch_moved"), 103413: fixed("speed_mismatch"), 103466: fixed("cradle_oscillation"),
      2224842: fixed("motion_unexpected"), 2224864: fixed("motion_too_fast"), 2268955: fixed("clutch_slip"),
      2268821: fixed("no_start"), 103419: fixed("no_start"), 103414: fixed("no_start"), 2268879: fixed("no_start"),
      103418: fixed("target_miss"), 2268836: fixed("target_miss"), 2268819: fixed("velocity_tolerance"), 2261552: fixed("off_plane_while_scanning"),
    },
  },
  {
    ...base, key: "mri.door_sensor_fault", group: "hardware", category: "reliability",
    label: "Door sensor not working", description: "'Door sensor is not working' (2218716).",
    codes: { 2218716: when(/Door sensor is not working/) },
  },
  {
    ...base, key: "mri.service_mode", group: "service", category: "utilization",
    label: "GE service mode on / off (dim)", description: "'GE-Service Mode' (2218663, dim on) and 'Normal Mode' (2218664, dim off).",
    codes: { 2218663: when(/GE-Service Mode/, "on"), 2218664: when(/Normal Mode/, "off") },
  },
  {
    ...base, key: "mri.pm_overdue", group: "service", category: "compliance",
    label: "Planned maintenance overdue (GE message)", description: "'overdue for Planned Maintenance': 2218671 (dim unscheduled), 2218673 (dim scheduled).",
    codes: { 2218671: when(/overdue for Planned Maintenance/, "unscheduled"), 2218673: when(/overdue for Planned Maintenance/, "scheduled") },
  },
  {
    ...base, key: "mri.iq_warning", group: "service", category: "reliability",
    label: "GE image-quality warning", description: "'could significantly degrade Image Quality' (2218672).",
    codes: { 2218672: when(/could significantly degrade Image Quality/) },
  },
  {
    ...base, key: "mri.system_up", group: "inventory", category: "inventory", unit: "T",
    label: "System Up (dim = software version; value = field strength, T)",
    description: "'System Up. sw=<version>' (2227566). value = fieldStrength / 10000 (tesla); attrs: fieldStrength, gradientAmp, RFampType, GradCoil, GCoilType, PowerMonType.",
    codes: { 2227566: (r) => { const m = /^System Up\. sw=(\S+)/.exec(text(r)); return m ? m[1] : null; } },
    value: (r) => { const m = /fieldStrength=(\d+)/.exec(text(r)); return m ? Number(m[1]) / 10000 : null; },
    attrs: (r) => {
      const o = {};
      for (const k of SYSTEM_UP_ATTRS) { const m = new RegExp(`${k}=(\\w+)`).exec(text(r)); if (m) o[k] = m[1]; }
      return Object.keys(o).length ? o : null;
    },
  },
];

const rules = [error_rule, ...named];
const NAMED_KEYS = named.map((n) => n.key);
// The one code shared by two named metrics (the exam summary's two counts).
const SHARED_CODES = { 2218650: ["mri.scans_ok", "mri.scans_failed"] };
const MAX_FACTS_PER_ROW = 3; // mri.error + at most two named metrics
const NAMED_CODES = [...new Set(named.flatMap((n) => Object.keys(n.codes).map(Number)))].sort((a, b) => a - b);

const finite = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const nonempty = (v) => (v === null || v === undefined || String(v).trim() === "" ? null : String(v).trim());

// Pure: row -> { facts: [{ metric_key, rule_version, dim, value_num, value_text, attrs }], errors }.
// A throwing matcher / value / attrs function is reported (the extract
// refuses a batch with errors); mri.error is always emitted.
function classify(row) {
  const attrs = {};
  const proc = nonempty(process_of(row.type));
  if (proc) attrs.proc = proc;
  for (const k of ["coil", "psd"]) { const v = nonempty(row[k]); if (v) attrs[k] = v; }
  const facts = [{
    metric_key: error_rule.key, rule_version: error_rule.version, dim: String(row.message_number), value_num: null, value_text: null,
    attrs: Object.keys(attrs).length ? attrs : null,
  }];
  const errors = [];
  for (const n of named) {
    const match = n.codes[row.message_number];
    if (!match) continue;
    try {
      const dim = match(row);
      if (dim === null || dim === undefined) continue;
      facts.push({
        metric_key: n.key, rule_version: n.version, dim: String(dim),
        value_num: n.value ? finite(n.value(row)) : null, value_text: null, attrs: n.attrs ? n.attrs(row) : null,
      });
    } catch (e) {
      errors.push({ key: n.key, id: row.id, error: e.message });
    }
  }
  return { facts, errors };
}

// Checked before anything is written (as CV review CV2-EXTRACT P2).
function validate(all = rules, named_rules = named) {
  const errors = validate_rules(all.map((r) => ({ ...r, extract: () => null })));
  for (const r of all) if (!String(r.key).startsWith("mri.")) errors.push(`${r.key}: MRI keys must start with mri.`);
  const GROUPS = ["utilization", "reliability", "hardware", "service", "inventory"];
  const seen = new Map();
  for (const n of named_rules) {
    if (!GROUPS.includes(n.group)) errors.push(`${n.key}: bad group ${n.group}`);
    const codes = Object.keys(n.codes || {});
    if (!codes.length) errors.push(`${n.key}: codes must be non-empty`);
    for (const c of codes) {
      if (!/^\d+$/.test(c)) errors.push(`${n.key}: code ${c} is not an integer`);
      if (typeof n.codes[c] !== "function") errors.push(`${n.key}: code ${c} needs a matcher function`);
      if (seen.has(c)) {
        const pair = SHARED_CODES[c];
        if (!(pair && pair.includes(n.key) && pair.includes(seen.get(c)))) errors.push(`${n.key}: code ${c} also in ${seen.get(c)}`);
      } else seen.set(c, n.key);
    }
    for (const f of ["value", "attrs"]) if (n[f] !== undefined && typeof n[f] !== "function") errors.push(`${n.key}: ${f} must be a function`);
  }
  return errors;
}

const mri_catalog_rows = () => catalog_rows(rules);

module.exports = {
  rules, named, error_rule, NAMED_KEYS, NAMED_CODES, SHARED_CODES, MAX_FACTS_PER_ROW, PRESCAN_REASONS, PRESCAN_DIMS, COIL_INVALID_DIMS,
  classify, validate, mri_catalog_rows,
};
