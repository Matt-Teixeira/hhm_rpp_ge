"use strict";
// GE CV rule registry (PLAN-CV-INSIGHTS.md §6.2, agreed 2026-11-09 as M1-M3).
//
// One log.ge_cv_syserror row -> either an ignore entry (no fact) or
//   - a cv.error fact (dim = the error code), always, and
//   - at most one named-metric fact, matched on code + readable debug text.
// Rules are pure: no DB, no clock. Only non-encoded columns are read
// (errorcode, subsystem, debugtext, sourcefile); GE's encoded fields
// (errortext, fru, majorfunction, minorfunction) are never selected.
//
// The catalog (insight.metric_catalog, keys cv.*) is generated from these
// objects (rules/engine.js catalog_rows), so the registry is the single
// source of truth. Bump a rule's `version` whenever its output changes;
// facts are replaced only by a newer version.
//
// Nothing in the GE CT run loads this file.
const { validate_rules, catalog_rows } = require("../rules/engine");

// "Front L-Arm" -> "front_l_arm"
const norm = (s) => String(s || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
const text = (r) => (r.debugtext === null || r.debugtext === undefined ? "" : String(r.debugtext));
const sub = (r) => (r.subsystem === null || r.subsystem === undefined ? "" : String(r.subsystem).trim());

const base = { value_kind: "event", unit: null, customer_visible: false, model_specific: false };

// The catch-all: every counted row. dim = the error code.
const error_rule = {
  ...base,
  key: "cv.error",
  version: 1,
  label: "Error log entries",
  category: "reliability",
  description: "Every counted GE CV sysError entry (RTA relays excluded), by error code (dim). Row count = event count; repeatcount is a running index and is never summed.",
};

// Named metrics: `codes` is the complete list the rule can match (pinned by
// the tests and by the independent SQL); `match` returns the dim, or null.
const named = [
  {
    ...base,
    key: "cv.detector_com_error",
    version: 1,
    label: "Detector communication errors",
    category: "reliability",
    description: "FPGA driver 'Detector com error' (codes 1200014, 1200114). dim = the detector operation that failed (e.g. scanSetupDm).",
    codes: [1200014, 1200114],
    match: (r) => (/Detector com error/.test(text(r)) ? ((/CDetector\w*::(\w+)/.exec(text(r)) || [])[1] || "") : null),
  },
  {
    ...base,
    key: "cv.positioner_collision",
    version: 1,
    label: "Positioner collisions",
    category: "reliability",
    description: "Lift (1050168) and collimator (1050170) collision. COLLISION SENSOR ACTIVATED and COLLISION NOT CLEARED are not counted here: they mostly accompany a collision already counted (§6.2).",
    codes: [1050168, 1050170],
    match: (r) => (r.errorcode === 1050168 && /LIFT COLLISION/.test(text(r)) ? "lift"
      : r.errorcode === 1050170 && /COLLIMATOR COLLISION/.test(text(r)) ? "collimator" : null),
  },
  {
    ...base,
    key: "cv.anticollision_error",
    version: 1,
    label: "Anticollision errors",
    category: "reliability",
    description: "ANTICOLLISION CINEMATIC ERROR (1050142-1050145, 1050301, 1050302) and 'Anticollision error on axis' (1050177). dim = the axis.",
    codes: [1050142, 1050143, 1050144, 1050145, 1050301, 1050302, 1050177],
    match: (r) => {
      const t = text(r);
      if (r.errorcode === 1050177) {
        const m = /Anticollision error on axis (.+?) in motion state/.exec(t);
        return /Anticollision error on axis/.test(t) ? norm(m ? m[1] : "") : null;
      }
      const m = /ANTICOLLISION CINEMATIC ERROR .*error on ([^"]+)/.exec(t);
      return m ? norm(m[1]) : null;
    },
  },
  {
    ...base,
    key: "cv.table_encoder_failure",
    version: 1,
    label: "Table encoder / potentiometer failures",
    category: "reliability",
    description: "Table potentiometer (1050709 height, 1050710 lateral, 1050711 longitudinal) and encoder (1050182 longitudinal, 1050187 / 1050188 rotation) failures. dim = the axis.",
    codes: [1050709, 1050710, 1050711, 1050182, 1050187, 1050188],
    match: (r) => ({ 1050709: "height", 1050710: "lateral", 1050711: "longitudinal", 1050182: "longitudinal", 1050187: "rotation", 1050188: "rotation" })[r.errorcode] ?? null,
  },
  {
    ...base,
    key: "cv.pib_com_loss",
    version: 1,
    label: "PIB communication loss",
    category: "reliability",
    description: "'PIB : COM Reset' / 'PIB : COM Fail' (1050024). The rack reset logged 10 ms later under 1050297 is the same event and is not counted here.",
    codes: [1050024],
    match: (r) => { const m = /PIB : COM (Reset|Fail)/.exec(text(r)); return m ? m[1].toLowerCase() : null; },
  },
  {
    ...base,
    key: "cv.emergency_backout",
    version: 1,
    label: "Emergency backout",
    category: "reliability",
    description: "'Emergency backout has been pressed' (1050297). The paired 'released' entry is not counted.",
    codes: [1050297],
    match: (r) => (/Emergency backout has been pressed/.test(text(r)) ? "" : null),
  },
  {
    ...base,
    key: "cv.dose_export_rejected",
    version: 1,
    label: "Dose export rejected",
    category: "compliance",
    description: "DICOM dose-report export 'Association rejected' (2800176).",
    codes: [2800176],
    match: (r) => (/Association rejected/.test(text(r)) ? "" : null),
  },
  {
    ...base,
    key: "cv.worklist_query_failed",
    version: 1,
    label: "Worklist query failures",
    category: "reliability",
    description: "DICOM modality worklist query failures from MwlDJRLogger (2800036 BROWSER_NETWORK_FAILED, 2800175 BROWSER_WL_QUERY_FAILED). Plan §2's 'network failure' (M2).",
    codes: [2800036, 2800175],
    match: (r) => { const m = /BROWSER_(NETWORK|WL_QUERY)_FAILED/.exec(text(r)); return m ? (m[1] === "NETWORK" ? "network_failed" : "wl_query_failed") : null; },
  },
];

// Reviewed ignore list (CT Phase 2 coverage rule): rows that give no fact.
const ignore = [
  {
    key: "rta_relay",
    reason: "RTA relaying a positioner error already logged by the positioner (subsystem RTA, source file XRImChainPos, debug text '(null)'): counting it would double the positioner errors. §6.1.",
    match: (r) => sub(r) === "RTA" && r.sourcefile === "XRImChainPos",
  },
];

const rules = [error_rule, ...named];
const NAMED_KEYS = named.map((n) => n.key);
const MAX_FACTS_PER_ROW = 2; // cv.error + at most one named metric

// Pure: row -> { ignore: key } | { facts: [{ metric_key, rule_version, dim, value_num, value_text, attrs }], errors }.
// Two named metrics matching one row is a registry bug: reported as an
// error, and neither named fact is emitted (cv.error still is).
function classify(row) {
  const ig = ignore.find((i) => i.match(row));
  if (ig) return { ignore: ig.key, facts: [], errors: [] };
  const errors = [];
  const facts = [{
    metric_key: error_rule.key, rule_version: error_rule.version, dim: String(row.errorcode), value_num: null, value_text: null,
    attrs: { repeatcount: row.repeatcount ?? null, sourcefile: row.sourcefile ?? null, sourceline: row.sourceline ?? null },
  }];
  const hits = [];
  for (const n of named) {
    if (!n.codes.includes(row.errorcode)) continue;
    let dim;
    try { dim = n.match(row); } catch (e) { errors.push({ key: n.key, id: row.id, error: e.message }); continue; }
    if (dim === null || dim === undefined) continue;
    hits.push({ metric_key: n.key, rule_version: n.version, dim: String(dim), value_num: null, value_text: null, attrs: null });
  }
  if (hits.length > 1) errors.push({ key: hits.map((h) => h.metric_key).join("+"), id: row.id, error: "row matches more than one named metric" });
  else facts.push(...hits);
  return { facts, errors };
}

// The registry (or a given one, for tests) is checked before anything is
// written: dry-run, backfill --rehearse and --apply all refuse an invalid
// registry before the catalog upsert (review CV2-EXTRACT P2).
function validate(all = rules, named_rules = named) {
  const errors = validate_rules(all.map((r) => ({ ...r, extract: () => null })));
  for (const r of all) if (!String(r.key).startsWith("cv.")) errors.push(`${r.key}: CV keys must start with cv.`);
  const seen = new Map();
  for (const n of named_rules) {
    if (!Array.isArray(n.codes) || !n.codes.length || !n.codes.every(Number.isInteger)) errors.push(`${n.key}: codes must be a non-empty integer list`);
    if (typeof n.match !== "function") errors.push(`${n.key}: match must be a function`);
    for (const c of n.codes || []) { if (seen.has(c)) errors.push(`${n.key}: code ${c} also in ${seen.get(c)}`); seen.set(c, n.key); }
  }
  return errors;
}

const cv_catalog_rows = () => catalog_rows(rules);

module.exports = { rules, named, ignore, error_rule, NAMED_KEYS, MAX_FACTS_PER_ROW, classify, validate, cv_catalog_rows, norm };
