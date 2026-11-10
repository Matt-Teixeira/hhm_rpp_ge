"use strict";
// GE CV findings registry (PLAN-CV-INSIGHTS.md §10.2; F1-F6 agreed
// 2026-11-10). Each rule is a pure function, as in CT
// (insight/findings/rules.js):
//   evaluate(ctx, D) -> { severity, observed, baseline, from, evidence } | null
// of the system's context (./context.js) and an as-of device day D (a day
// number), evaluated on data days only. `from` = first day of the window
// the result describes (the window ends at D).
//
// Thresholds are the replayed ones of §10.2. Windows: 7 d = D-6..D, 28 d =
// D-27..D. A baseline is the median over the data days in D-28..D-1 and
// needs >= 7 of them. Every rule resolves after QUIET_DAYS evaluated days
// without a trip (CT's state machine).
//
// Evidence holds codes, dims (axis / operation) and counts only, never
// debug text. customer_visible is false for every CV v1 finding (§10.4).
// The CV rows of insight.finding_catalog are generated from this file; keys
// carry the cv_ prefix (the catalog key check allows no dot).
// Bump `version` when a rule's logic or thresholds change.
//
// Nothing in the GE CT run loads this file.
const { validate_finding_rules } = require("../../findings/rules");
const { baseline, top_of, dstr, DETECTOR_OFFSET_CODE } = require("./context");

const QUIET_DAYS = 14;
const BASE = { baseline_days: 28, min_baseline_days: 7 };
const KEY_PREFIX = "cv_";

const day_list = (ctx, name, ns) => ns.map((n) => ({ day: dstr(n), n: ctx.series[name].get(n) }));
const dims_of = (ctx, k, a, b) => top_of(ctx.dims[k], a, b).map(({ k: dim, n }) => ({ dim, n }));

// ---------------------------------------------------------------- rule 1
// A storm day: residual >= min_residual and >= factor x max(baseline, 1),
// with a baseline. Residual = cv.error minus the rows rules 2-5 count,
// minus the detector offset code (context.js).
const STORM = { min_residual: 300, factor: 10, ...BASE, high_storm_days_28d: 3, excluded_code: DETECTOR_OFFSET_CODE,
  excluded_metrics: ["cv.detector_com_error", "cv.anticollision_error", "cv.table_encoder_failure", "cv.pib_com_loss"] };
function storm_day(ctx, n) {
  const key = `storm|${n}`;
  if (ctx.memo.has(key)) return ctx.memo.get(key);
  let r = false;
  if (ctx.is_data(n)) {
    const v = ctx.series.residual.get(n);
    const b = baseline(ctx, "residual", n, STORM.baseline_days, STORM.min_baseline_days);
    r = b !== null && v >= STORM.min_residual && v >= STORM.factor * Math.max(b, 1);
  }
  ctx.memo.set(key, r);
  return r;
}
const cv_error_storm = {
  key: "cv_error_storm", version: 1, category: "reliability", default_severity: "medium", quiet_days: QUIET_DAYS, customer_visible: false,
  label: "GE CV error storm",
  description: "A device day whose errors not explained by another CV finding (all cv.error rows minus detector com, anticollision, table encoder and PIB rows and minus 1200019 detector offset) are >= 300 and >= 10x the median of the 28 days before (needs >= 7 data days). Trips with such a day in the last 7 days; high with >= 3 in the last 28.",
  thresholds: STORM,
  evaluate(ctx, D) {
    const sd = ctx.data_days(D - 6, D).filter((n) => storm_day(ctx, n));
    if (!sd.length) return null;
    const n28 = ctx.data_days(D - 27, D).filter((n) => storm_day(ctx, n)).length;
    const last = sd[sd.length - 1];
    const b = (n) => baseline(ctx, "residual", n, STORM.baseline_days, STORM.min_baseline_days);
    return {
      severity: n28 >= STORM.high_storm_days_28d ? "high" : "medium", observed: ctx.series.residual.get(last), baseline: b(last), from: D - 6,
      evidence: {
        storm_days: sd.map((n) => ({ day: dstr(n), residual: ctx.series.residual.get(n), all_errors: ctx.series.err.get(n), baseline: b(n) })),
        storm_days_28d: n28,
        top_codes: top_of(ctx.codes, D - 6, D, 5).map(({ k, n }) => ({ code: k, n })),
      },
    };
  },
};

// ---------------------------------------------------------------- rule 2
const DETECTOR = { min_per_day: 50, high_days_28d: 3 };
const det_days = (ctx, a, b) => ctx.data_days(a, b).filter((n) => ctx.series.det.get(n) >= DETECTOR.min_per_day);
const cv_detector_com_errors = {
  key: "cv_detector_com_errors", version: 1, category: "reliability", default_severity: "medium", quiet_days: QUIET_DAYS, customer_visible: false,
  label: "GE CV detector communication errors",
  description: "A device day with >= 50 detector communication errors in the last 7 days; high with >= 3 such days in the last 28.",
  thresholds: DETECTOR,
  evaluate(ctx, D) {
    const sd = det_days(ctx, D - 6, D);
    if (!sd.length) return null;
    const n28 = det_days(ctx, D - 27, D).length;
    const last = sd[sd.length - 1];
    return {
      severity: n28 >= DETECTOR.high_days_28d ? "high" : "medium", observed: ctx.series.det.get(last), baseline: null, from: D - 6,
      evidence: {
        storm_days: sd.map((n) => ({ day: dstr(n), n: ctx.series.det.get(n), detector_offset_1200019: ctx.series.offset.get(n) })),
        storm_days_28d: n28, operations: dims_of(ctx, "det", D - 6, D),
      },
    };
  },
};

// ---------------------------------------------------------------- rule 3
// A burst day: >= min_per_day and >= factor x max(baseline, 1); with no
// baseline yet (fewer than 7 data days before), the absolute threshold alone.
const ANTICOLLISION = { min_per_day: 50, factor: 5, ...BASE };
function ac_burst(ctx, n) {
  const v = ctx.series.ac.get(n);
  if (v < ANTICOLLISION.min_per_day) return false;
  const b = baseline(ctx, "ac", n, ANTICOLLISION.baseline_days, ANTICOLLISION.min_baseline_days);
  return b === null || v >= ANTICOLLISION.factor * Math.max(b, 1);
}
const cv_anticollision_burst = {
  key: "cv_anticollision_burst", version: 1, category: "reliability", default_severity: "medium", quiet_days: QUIET_DAYS, customer_visible: false,
  label: "GE CV anticollision error burst",
  description: "A device day with >= 50 anticollision errors and >= 5x the median of the 28 days before (the absolute threshold alone while there are fewer than 7 data days before), in the last 7 days.",
  thresholds: ANTICOLLISION,
  evaluate(ctx, D) {
    const sd = ctx.data_days(D - 6, D).filter((n) => ac_burst(ctx, n));
    if (!sd.length) return null;
    const last = sd[sd.length - 1];
    const b = (n) => baseline(ctx, "ac", n, ANTICOLLISION.baseline_days, ANTICOLLISION.min_baseline_days);
    return {
      severity: "medium", observed: ctx.series.ac.get(last), baseline: b(last), from: D - 6,
      evidence: { burst_days: sd.map((n) => ({ day: dstr(n), n: ctx.series.ac.get(n), baseline: b(n) })), axes: dims_of(ctx, "ac", D - 6, D) },
    };
  },
};

// ---------------------------------------------------------------- rule 4
const TABLE = { min_per_day: 5, min_days_7d: 2, high_days_28d: 10 };
const tbl_days = (ctx, a, b) => ctx.data_days(a, b).filter((n) => ctx.series.tbl.get(n) >= TABLE.min_per_day);
const cv_table_encoder_fault = {
  key: "cv_table_encoder_fault", version: 1, category: "reliability", default_severity: "medium", quiet_days: QUIET_DAYS, customer_visible: false,
  label: "GE CV table encoder / potentiometer fault",
  description: ">= 5 table encoder or potentiometer failures on each of >= 2 device days in the last 7; high with >= 10 such days in the last 28.",
  thresholds: TABLE,
  evaluate(ctx, D) {
    const sd = tbl_days(ctx, D - 6, D);
    if (sd.length < TABLE.min_days_7d) return null;
    const n28 = tbl_days(ctx, D - 27, D).length;
    return {
      severity: n28 >= TABLE.high_days_28d ? "high" : "medium", observed: ctx.series.tbl.sum(D - 6, D), baseline: null, from: D - 6,
      evidence: { days: day_list(ctx, "tbl", sd), days_28d: n28, axes: dims_of(ctx, "tbl", D - 6, D) },
    };
  },
};

// ---------------------------------------------------------------- rule 5
const PIB = { min_7d: 3, high_days_7d: 3 };
const cv_pib_com_loss = {
  key: "cv_pib_com_loss", version: 1, category: "reliability", default_severity: "medium", quiet_days: QUIET_DAYS, customer_visible: false,
  label: "GE CV positioner PIB communication loss",
  description: ">= 3 PIB communication resets or failures in the last 7 device days; high when they fall on >= 3 of those days.",
  thresholds: PIB,
  evaluate(ctx, D) {
    const n = ctx.series.pib.sum(D - 6, D);
    if (n < PIB.min_7d) return null;
    const days = ctx.data_days(D - 6, D).filter((x) => ctx.series.pib.get(x) > 0);
    return {
      severity: days.length >= PIB.high_days_7d ? "high" : "medium", observed: n, baseline: null, from: D - 6,
      evidence: { days: day_list(ctx, "pib", days), kinds: dims_of(ctx, "pib", D - 6, D) },
    };
  },
};

const cv_finding_rules = [cv_error_storm, cv_detector_com_errors, cv_anticollision_burst, cv_table_encoder_fault, cv_pib_com_loss];

function validate_cv_finding_rules(rs = cv_finding_rules) {
  const errs = validate_finding_rules(rs);
  for (const r of rs) {
    if (!r.key.startsWith(KEY_PREFIX)) errs.push(`${r.key}: CV finding keys start with ${KEY_PREFIX}`);
    if (r.kind === "event") errs.push(`${r.key}: CV v1 has windowed rules only`);
    if (r.customer_visible !== false) errs.push(`${r.key}: CV v1 findings are internal (customer_visible false)`);
  }
  return errs;
}

const cv_catalog_rows = (rs = cv_finding_rules) => rs.map((r) => ({
  finding_key: r.key, label: r.label, description: r.description, category: r.category,
  default_severity: r.default_severity, rule_version: r.version, customer_visible: r.customer_visible !== false,
}));

module.exports = {
  cv_finding_rules, cv_catalog_rows, validate_cv_finding_rules, storm_day, ac_burst,
  QUIET_DAYS, KEY_PREFIX, STORM, DETECTOR, ANTICOLLISION, TABLE, PIB,
};
