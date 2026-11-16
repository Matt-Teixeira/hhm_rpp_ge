"use strict";
// GE MRI findings registry (PLAN-MRI-INSIGHTS.md §9.2; F1-F12 agreed
// 2026-11-16). Each rule is a pure function, as in CT and CV:
//   evaluate(ctx, D) -> { severity, observed, baseline, from, evidence } | null
// of the system's context (./context.js) and an as-of device day D (a day
// number), evaluated on data days only. `from` = first day of the window
// the result describes (the window ends at D); always D-6 here.
//
// Windows: 7 d = D-6..D, 28 d = D-27..D. A baseline is the median over the
// data days in D-28..D-1 and needs >= 7 of them (rules 5, 7, 10); rule 1
// pools the scans of D-34..D-7. Every rule resolves after QUIET_DAYS
// evaluated days without a trip (CT's state machine).
//
// Evidence holds counts, codes, dims (reasons, kinds, process names) and
// device days only, never message text. customer_visible is false for every
// MRI v1 finding (F11). The mri_* rows of insight.finding_catalog are
// generated from this file. Bump `version` when a rule's logic or
// thresholds change; the independent SQL (verify_sql.js) writes the same
// thresholds out, so a one-sided edit shows up as a difference.
//
// Nothing in the GE CT or CV run loads this file.
const { validate_finding_rules } = require("../../findings/rules");
const { baseline, crashes, top_of, dstr, PRESCAN_OPERATOR_REASONS, TPS_STARTUP_CODE, CRYO_PREFIX, RESTART_WINDOW_MIN } = require("./context");

const QUIET_DAYS = 14;
const KEY_PREFIX = "mri_";
const BASE = { baseline_days: 28, min_baseline_days: 7 };

const sum7 = (ctx, k, D) => ctx.series[k].sum(D - 6, D);
const days_with = (ctx, k, a, b, min = 1) => ctx.data_days(a, b).filter((n) => ctx.series[k].get(n) >= min);
const day_list = (ctx, k, ns) => ns.map((n) => ({ day: dstr(n), n: ctx.series[k].get(n) }));
const dims_of = (ctx, k, a, b) => top_of(ctx.dims[k], a, b).map(({ k: dim, n }) => ({ dim, n }));
const base = (ctx, k, n, b = BASE) => baseline(ctx, k, n, b.baseline_days, b.min_baseline_days);
// A day >= min and >= factor x max(baseline, 1), with a baseline.
const spike = (ctx, k, n, p) => {
  const v = ctx.series[k].get(n);
  if (v < p.min_per_day) return false;
  const b = base(ctx, k, n);
  return b !== null && v >= p.factor * Math.max(b, 1);
};
const rule = (o) => ({ version: 1, category: "reliability", default_severity: "medium", quiet_days: QUIET_DAYS, customer_visible: false, ...o });

// ---------------------------------------------------------------- rule 1
const FAILED_SCANS = { min_failed_7d: 10, min_share_pct: 5, factor: 3, baseline_from: -34, baseline_to: -7, min_baseline_scans: 100 };
const mri_failed_scans_high = rule({
  key: "mri_failed_scans_high", label: "GE MRI failed scans well above the system's own rate",
  description: "Failed share of the scans in the exam summaries over the last 7 device days >= 5% and >= 3x the system's share over the 4 weeks before the window (needs >= 100 scans there), with >= 10 failed scans.",
  thresholds: FAILED_SCANS,
  evaluate(ctx, D) {
    const P = FAILED_SCANS;
    const f = sum7(ctx, "failed", D), all = f + sum7(ctx, "ok", D);
    const bf = ctx.series.failed.sum(D + P.baseline_from, D + P.baseline_to);
    const ball = bf + ctx.series.ok.sum(D + P.baseline_from, D + P.baseline_to);
    // integer comparisons (the SQL does the same): f/all >= 5%, f/all >= 3 x bf/ball
    if (ball < P.min_baseline_scans || f < P.min_failed_7d || 100 * f < P.min_share_pct * all || f * ball < P.factor * bf * all) return null;
    return {
      severity: "medium", observed: (100 * f) / all, baseline: (100 * bf) / ball, from: D - 6,
      evidence: { failed_7d: f, scans_7d: all, baseline_failed: bf, baseline_scans: ball, baseline_window: [dstr(D + P.baseline_from), dstr(D + P.baseline_to)] },
    };
  },
});

// ---------------------------------------------------------------- rule 2
const COOLING = { min_days_7d: 3, burst_per_day: 50, high_kind_prefix: CRYO_PREFIX }; // high: a burst day, or any hec_cryo* kind in the 7 days
const mri_cooling_fault = rule({
  key: "mri_cooling_fault", category: "environment", label: "GE MRI cooling / environment alarms",
  description: "Cooling alarms (water flow, HEC coolant and cryo compressor, leak sensor, RF coil airflow, gradient coil temperature) on >= 3 of the last 7 data days, or >= 50 on one day; high with such a burst or any HEC cryo-compressor alarm (the only cryogen signal).",
  thresholds: COOLING,
  evaluate(ctx, D) {
    const days = days_with(ctx, "cool", D - 6, D);
    const bursts = days_with(ctx, "cool", D - 6, D, COOLING.burst_per_day);
    if (days.length < COOLING.min_days_7d && !bursts.length) return null;
    const cryo = sum7(ctx, "cryo", D); // kinds starting with COOLING.high_kind_prefix
    return {
      severity: bursts.length || cryo > 0 ? "high" : "medium", observed: sum7(ctx, "cool", D), baseline: null, from: D - 6,
      evidence: { days: day_list(ctx, "cool", days), burst_days: bursts.map(dstr), cryo_alarms_7d: cryo, kinds: dims_of(ctx, "cool", D - 6, D) },
    };
  },
});

// ---------------------------------------------------------------- rule 3
const TPS = { min_days_7d: 2, high_days_28d: 4, codes: ["2227556", TPS_STARTUP_CODE] };
const tps_days = (ctx, a, b) => ctx.data_days(a, b).filter((n) => ctx.series.tps_failed.get(n) + ctx.series.tps_startup.get(n) > 0);
const mri_tps_reset_failures = rule({
  key: "mri_tps_reset_failures", label: "GE MRI TPS reset failures",
  description: "A TPS reset failure ('Reset/Download TPS was not successful' 2227556, or 'StartupCondition error ... TPS reset failure' 2256925) on >= 2 of the last 7 data days; high with >= 4 such days in the last 28.",
  thresholds: TPS,
  evaluate(ctx, D) {
    const days = tps_days(ctx, D - 6, D);
    if (days.length < TPS.min_days_7d) return null;
    const n28 = tps_days(ctx, D - 27, D).length;
    return {
      severity: n28 >= TPS.high_days_28d ? "high" : "medium", observed: days.length, baseline: null, from: D - 6,
      evidence: { days: days.map((n) => ({ day: dstr(n), not_successful: ctx.series.tps_failed.get(n), startup_condition: ctx.series.tps_startup.get(n) })),
        days_28d: n28, resets_started_7d: sum7(ctx, "tps_reset", D) },
    };
  },
});

// ---------------------------------------------------------------- rule 4
const CRASH = { min_per_process_7d: 5, high_per_process_7d: 20, restart_window_min: RESTART_WINDOW_MIN }; // a restart event on a day <= D
const mri_process_crash_loop = rule({
  key: "mri_process_crash_loop", label: "GE MRI process crash loop",
  description: "One process dies >= 5 times in the last 7 device days, counting only deaths not at a software restart (no start, stop, System Up or stop companion within 10 device minutes; Q-D1); high with >= 20.",
  thresholds: CRASH,
  evaluate(ctx, D) {
    const t = crashes(ctx, D);
    const hit = [...t].filter(([, n]) => n >= CRASH.min_per_process_7d).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
    if (!hit.length) return null;
    const max = hit[0][1];
    return {
      severity: max >= CRASH.high_per_process_7d ? "high" : "medium", observed: max, baseline: null, from: D - 6,
      evidence: { processes: hit.map(([process, n]) => ({ process, n })),
        all_deaths_not_at_restart_7d: [...t].reduce((a, [, n]) => a + n, 0) },
    };
  },
});

// ---------------------------------------------------------------- rule 5
const PRESCAN = { min_per_day: 15, factor: 5, ...BASE, operator_reasons_excluded: PRESCAN_OPERATOR_REASONS };
const mri_prescan_failures = rule({
  key: "mri_prescan_failures", label: "GE MRI prescan failures well above baseline",
  description: "A device day in the last 7 with >= 15 prescan failures (operator reasons left out: stop / pause button, operator request, door open, table not at scan plane) and >= 5x the median of the 28 days before (needs >= 7 data days).",
  thresholds: PRESCAN,
  evaluate(ctx, D) {
    const sd = ctx.data_days(D - 6, D).filter((n) => spike(ctx, "prescan", n, PRESCAN));
    if (!sd.length) return null;
    const last = sd[sd.length - 1];
    return {
      severity: "medium", observed: ctx.series.prescan.get(last), baseline: base(ctx, "prescan", last), from: D - 6,
      evidence: { burst_days: sd.map((n) => ({ day: dstr(n), n: ctx.series.prescan.get(n), baseline: base(ctx, "prescan", n) })),
        reasons: dims_of(ctx, "prescan", D - 6, D) },
    };
  },
});

// ---------------------------------------------------------------- rule 6
const COIL = { min_days_7d: 4, high_days_28d: 14 };
const mri_coil_fault = rule({
  key: "mri_coil_fault", label: "GE MRI coil faults",
  description: "Coil faults (bias / transmit / T/R driver open circuit, coil ID, connection) on >= 4 of the last 7 data days; high with >= 14 such days in the last 28.",
  thresholds: COIL,
  evaluate(ctx, D) {
    const days = days_with(ctx, "coil", D - 6, D);
    if (days.length < COIL.min_days_7d) return null;
    const n28 = days_with(ctx, "coil", D - 27, D).length;
    return {
      severity: n28 >= COIL.high_days_28d ? "high" : "medium", observed: sum7(ctx, "coil", D), baseline: null, from: D - 6,
      evidence: { days: day_list(ctx, "coil", days), days_28d: n28, kinds: dims_of(ctx, "coil", D - 6, D) },
    };
  },
});

// ---------------------------------------------------------------- rule 7
const TABLE = { min_per_day: 10, factor: 5, ...BASE, persistent_per_day: 10, persistent_days_7d: 5 };
const mri_table_fault = rule({
  key: "mri_table_fault", label: "GE MRI patient table / cradle faults",
  description: "Spike: a device day in the last 7 with >= 10 table faults and >= 5x the median of the 28 days before (needs >= 7 data days). Persistent: >= 10 table faults on each of >= 5 of the last 7 data days.",
  thresholds: TABLE,
  evaluate(ctx, D) {
    const sd = ctx.data_days(D - 6, D).filter((n) => spike(ctx, "table", n, TABLE));
    const pd = days_with(ctx, "table", D - 6, D, TABLE.persistent_per_day);
    const persistent = pd.length >= TABLE.persistent_days_7d;
    if (!sd.length && !persistent) return null;
    const last = sd[sd.length - 1];
    return {
      severity: "medium", observed: sd.length ? ctx.series.table.get(last) : sum7(ctx, "table", D), baseline: sd.length ? base(ctx, "table", last) : null, from: D - 6,
      evidence: { variant: sd.length && persistent ? "spike+persistent" : sd.length ? "spike" : "persistent",
        spike_days: sd.map((n) => ({ day: dstr(n), n: ctx.series.table.get(n), baseline: base(ctx, "table", n) })),
        persistent_days: pd.length, kinds: dims_of(ctx, "table", D - 6, D) },
    };
  },
});

// ---------------------------------------------------------------- rule 8
const IQ = { min_days_7d: 2, code: "2218672" };
const mri_image_quality_warning = rule({
  key: "mri_image_quality_warning", label: "GE MRI image-quality warning (GE's own)",
  description: "GE's message 'This system has a failure that could significantly degrade Image Quality' (2218672) on >= 2 of the last 7 data days.",
  thresholds: IQ,
  evaluate(ctx, D) {
    const days = days_with(ctx, "iq", D - 6, D);
    if (days.length < IQ.min_days_7d) return null;
    return { severity: "medium", observed: sum7(ctx, "iq", D), baseline: null, from: D - 6, evidence: { days: day_list(ctx, "iq", days) } };
  },
});

// ---------------------------------------------------------------- rule 9
const PM = { min_days_7d: 3 };
const mri_pm_overdue = rule({
  key: "mri_pm_overdue", category: "compliance", default_severity: "low", label: "GE MRI planned maintenance overdue (GE message)",
  description: "GE's 'overdue for Planned Maintenance' message (2218671 unscheduled, 2218673 scheduled) on >= 3 of the last 7 data days.",
  thresholds: PM,
  evaluate(ctx, D) {
    const days = days_with(ctx, "pm", D - 6, D);
    if (days.length < PM.min_days_7d) return null;
    return { severity: "low", observed: days.length, baseline: null, from: D - 6, evidence: { days: day_list(ctx, "pm", days), kinds: dims_of(ctx, "pm", D - 6, D) } };
  },
});

// ---------------------------------------------------------------- rule 10
const STORM = { min_residual: 300, factor: 10, ...BASE, high_storm_days_28d: 3 };
const storm_day = (ctx, n) => {
  const key = `storm|${n}`;
  if (!ctx.memo.has(key)) ctx.memo.set(key, ctx.is_data(n) && spike(ctx, "residual", n, { min_per_day: STORM.min_residual, factor: STORM.factor }));
  return ctx.memo.get(key);
};
const mri_error_storm = rule({
  key: "mri_error_storm", label: "GE MRI error storm",
  description: "A device day whose errors not explained by another MRI finding (reliability, hardware and not yet reviewed codes, minus the codes of rules 2-9 and the restart signatures) are >= 300 and >= 10x the median of the 28 days before (needs >= 7 data days). Trips with such a day in the last 7; high with >= 3 in the last 28.",
  thresholds: STORM,
  evaluate(ctx, D) {
    const sd = ctx.data_days(D - 6, D).filter((n) => storm_day(ctx, n));
    if (!sd.length) return null;
    const n28 = ctx.data_days(D - 27, D).filter((n) => storm_day(ctx, n)).length;
    const last = sd[sd.length - 1];
    return {
      severity: n28 >= STORM.high_storm_days_28d ? "high" : "medium", observed: ctx.series.residual.get(last), baseline: base(ctx, "residual", last), from: D - 6,
      evidence: { storm_days: sd.map((n) => ({ day: dstr(n), residual: ctx.series.residual.get(n), baseline: base(ctx, "residual", n) })),
        storm_days_28d: n28, top_codes: top_of(ctx.dims.residual, D - 6, D, 5).map(({ k, n }) => ({ code: k, n })) },
    };
  },
});

// ---------------------------------------------------------------- rule 11
const UNCLEAN = { min_7d: 3 };
const mri_unclean_restarts = rule({
  key: "mri_unclean_restarts", default_severity: "low", label: "GE MRI software restarts without a clean stop",
  description: ">= 3 software sessions ended by a new start with no stop (sw_stop or its companion 200002364) between, in the last 7 device days, each counted on the day of that new start.",
  thresholds: UNCLEAN,
  evaluate(ctx, D) {
    const n = sum7(ctx, "unclean", D);
    if (n < UNCLEAN.min_7d) return null;
    return { severity: "low", observed: n, baseline: null, from: D - 6, evidence: { days: day_list(ctx, "unclean", days_with(ctx, "unclean", D - 6, D)) } };
  },
});

const mri_finding_rules = [
  mri_failed_scans_high, mri_cooling_fault, mri_tps_reset_failures, mri_process_crash_loop, mri_prescan_failures,
  mri_coil_fault, mri_table_fault, mri_image_quality_warning, mri_pm_overdue, mri_error_storm, mri_unclean_restarts,
];

function validate_mri_finding_rules(rs = mri_finding_rules) {
  const errs = validate_finding_rules(rs);
  for (const r of rs) {
    if (!r.key.startsWith(KEY_PREFIX)) errs.push(`${r.key}: MRI finding keys start with ${KEY_PREFIX}`);
    if (r.kind === "event") errs.push(`${r.key}: MRI v1 has windowed rules only`);
    if (r.customer_visible !== false) errs.push(`${r.key}: MRI v1 findings are internal (customer_visible false)`);
    if (r.quiet_days !== QUIET_DAYS) errs.push(`${r.key}: quiet period ${r.quiet_days} != ${QUIET_DAYS}`);
  }
  return errs;
}

const mri_catalog_rows = (rs = mri_finding_rules) => rs.map((r) => ({
  finding_key: r.key, label: r.label, description: r.description, category: r.category,
  default_severity: r.default_severity, rule_version: r.version, customer_visible: r.customer_visible !== false,
}));

module.exports = {
  mri_finding_rules, mri_catalog_rows, validate_mri_finding_rules, storm_day, spike,
  QUIET_DAYS, KEY_PREFIX, FAILED_SCANS, COOLING, TPS, CRASH, PRESCAN, COIL, TABLE, IQ, PM, STORM, UNCLEAN,
};
