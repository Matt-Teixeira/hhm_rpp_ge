"use strict";
// Findings registry (PLAN-CT-INSIGHTS.md §14.2, rules 1-10; agreed
// 2026-11-04). Each windowed rule is a pure function
//   evaluate(ctx, D) -> { severity, observed, baseline, from, evidence } | null
// of the system's context (findings/context.js) and an as-of device day D
// (a day number). null = does not trip on D. `from` = first day of the
// window the result describes (the window ends at D).
//
// tube_replaced is event-driven (kind "event"): its findings come from the
// tube.replacement facts, not from a daily trip (findings/state.js).
//
// The catalog (insight.finding_catalog) is generated from this file.
// Bump `version` when a rule's logic or thresholds change.
const { median, dstr, SAFE_EXCLUDED_CODES, SAFE_POWER_CYCLE_MIN, SAFE_INCIDENT_GAP_MIN, SERVICE_BEFORE_BOOT_H, FAST_CAL_STEPS } = require("./context");

const SEVERITIES = ["info", "low", "medium", "high"];
const rank = (s) => SEVERITIES.indexOf(s);
const QUIET_DAYS = 14;      // evaluated days without a trip before a finding resolves
const QUIET_DAYS_DAILY = 7; // rules on a single device day
const pct = (a, b) => (b > 0 ? Math.round((10000 * a) / b) / 100 : null); // 2 decimals
const days_list = (ctx, ind, a, b) => { const out = []; for (let d = a; d <= b; d++) if (ctx.ind[ind].get(d)) out.push(dstr(d)); return out; };

// ---------------------------------------------------------------- rule 1
const ROTOR = { min_stops: 5, sustained_weeks: 3, of_weeks: 4, spike_factor: 2, baseline_weeks: 8, min_baseline_weeks: 4 };
const tube_rotor_instability = {
  key: "tube_rotor_instability", version: 1, category: "tube", default_severity: "high", quiet_days: QUIET_DAYS,
  label: "Tube rotor instability",
  description: "Unexpected tube rotor stops. Sustained (high): >= 5 stops in >= 3 of the last 4 weeks. Spike (medium): >= 5 this week and >= 2x the median of the 8 weeks before (weeks with data; needs >= 4).",
  thresholds: ROTOR,
  evaluate(ctx, D) {
    const week = (k) => ({ from: D - 6 - 7 * k, to: D - 7 * k });
    const stops = (k) => ctx.series.rotor_stop.sum(week(k).from, week(k).to);
    const recent = [0, 1, 2, 3].map(stops);
    const sustained = recent.filter((c) => c >= ROTOR.min_stops).length >= ROTOR.sustained_weeks;
    const base = [];
    for (let k = 1; k <= ROTOR.baseline_weeks; k++) if (ctx.data.sum(week(k).from, week(k).to) > 0) base.push(stops(k));
    const med = base.length >= ROTOR.min_baseline_weeks ? median(base) : null;
    const spike = recent[0] >= ROTOR.min_stops && med !== null && recent[0] >= ROTOR.spike_factor * med;
    if (!sustained && !spike) return null;
    return {
      severity: sustained ? "high" : "medium", observed: recent[0], baseline: med, from: week(3).from,
      evidence: {
        variants: [sustained && "sustained", spike && "spike"].filter(Boolean),
        weeks: [0, 1, 2, 3].map((k) => ({ from: dstr(week(k).from), to: dstr(week(k).to), rotor_stops: recent[k],
          rotor_not_at_speed: ctx.series.rotor_not_at_speed.sum(week(k).from, week(k).to) })),
        baseline_weeks_with_data: base.length, baseline_week_stops: base, baseline_median: med,
      },
    };
  },
};

// ---------------------------------------------------------------- rule 2
const process_restart_loop = {
  key: "process_restart_loop", version: 1, category: "reliability", default_severity: "medium", quiet_days: QUIET_DAYS_DAILY,
  label: "Process restart loop",
  description: "One process restarted >= 50 times in a device day.",
  thresholds: { min_restarts_per_day: 50 },
  evaluate(ctx, D) {
    const procs = (ctx.restarts.get(D) || []).slice().sort((a, b) => b.n - a.n || (a.process < b.process ? -1 : 1));
    if (!procs.length || procs[0].n < 50) return null;
    return { severity: "medium", observed: procs[0].n, baseline: null, from: D,
      evidence: { process: procs[0].process, restarts: procs[0].n, processes: procs.slice(0, 5) } };
  },
};

// ---------------------------------------------------------------- rule 3
const ABORT = { chronic_days: 28, chronic_rate: 50, chronic_min_exams: 20, spike_days: 7, spike_rate: 30, spike_factor: 3,
  spike_min_exams: 10, baseline_from: 62, baseline_to: 7,
  // tuned 2026-11-04 (plan §14 checkpoint 4): one exam can log 100+ abort
  // lines, so a single exam / day must not make a finding
  spike_min_aborts: 10, min_abort_days: 2 };
const abort_rate_high = {
  key: "abort_rate_high", version: 1, category: "reliability", default_severity: "medium", quiet_days: QUIET_DAYS,
  label: "High system abort rate",
  description: "System aborts (exception class Abort, log lines) per 100 exams. Chronic: >= 50 over 28 days (>= 20 exams). Spike: >= 30 over 7 days (>= 10 exams, >= 10 aborts) and >= 3x the system's own rate over the 8 weeks before. Either needs aborts on >= 2 days of its window.",
  thresholds: ABORT,
  evaluate(ctx, D) {
    const ab = (a, b) => ctx.series.abort_system.sum(a, b), ex = (a, b) => ctx.series.exams.sum(a, b);
    const a28 = ab(D - 27, D), e28 = ex(D - 27, D), a7 = ab(D - 6, D), e7 = ex(D - 6, D);
    const ab_ = ab(D - ABORT.baseline_from, D - ABORT.baseline_to), eb = ex(D - ABORT.baseline_from, D - ABORT.baseline_to);
    // integer comparisons (no float rounding at the threshold)
    const days28 = ctx.ind.abort_system.sum(D - 27, D), days7 = ctx.ind.abort_system.sum(D - 6, D);
    const chronic = e28 >= ABORT.chronic_min_exams && 100 * a28 >= ABORT.chronic_rate * e28 && days28 >= ABORT.min_abort_days;
    const spike = e7 >= ABORT.spike_min_exams && a7 >= ABORT.spike_min_aborts && days7 >= ABORT.min_abort_days
      && 100 * a7 >= ABORT.spike_rate * e7 && eb > 0 && a7 * eb >= ABORT.spike_factor * ab_ * e7;
    if (!chronic && !spike) return null;
    const codes = new Map();
    for (const c of ctx.abort_codes) if (c.d >= D - 27 && c.d <= D) codes.set(c.code, (codes.get(c.code) || 0) + c.n);
    return {
      severity: "medium", observed: chronic ? pct(a28, e28) : pct(a7, e7), baseline: eb > 0 ? pct(ab_, eb) : null,
      from: chronic ? D - 27 : D - 6,
      evidence: {
        variants: [chronic && "chronic", spike && "spike"].filter(Boolean),
        d28: { aborts: a28, exams: e28, per_100: pct(a28, e28), days_with_aborts: days28 },
        d7: { aborts: a7, exams: e7, per_100: pct(a7, e7), days_with_aborts: days7 },
        baseline_8w: { aborts: ab_, exams: eb, per_100: pct(ab_, eb) },
        top_ermes_28d: [...codes.entries()].sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1)).slice(0, 5).map(([code, n]) => ({ code, n })),
      },
    };
  },
};

// ---------------------------------------------------------------- rule 4
const safe_state_recurrent = {
  key: "safe_state_recurrent", version: 1, category: "reliability", default_severity: "medium", quiet_days: QUIET_DAYS,
  label: "Recurrent safe state",
  description: `The same safe-state code in >= 3 separate incidents in 7 days (a new incident after ${SAFE_INCIDENT_GAP_MIN} min without that code), excluding safe states without a code, ${SAFE_EXCLUDED_CODES.join(", ")} (slip-ring comms down), and any within ${SAFE_POWER_CYCLE_MIN} min of a boot or shutdown.`,
  thresholds: { min_incidents_7d: 3, incident_gap_min: SAFE_INCIDENT_GAP_MIN, excluded_codes: SAFE_EXCLUDED_CODES, power_cycle_min: SAFE_POWER_CYCLE_MIN },
  evaluate(ctx, D) {
    const per = new Map();
    for (const s of ctx.safe) {
      if (s.d < D - 6 || s.d > D) continue;
      const v = per.get(s.code) || { code: s.code, incidents: 0, events: 0 };
      v.events++; if (s.new_incident) v.incidents++; per.set(s.code, v);
    }
    const codes = [...per.values()].sort((a, b) => b.incidents - a.incidents || b.events - a.events || (a.code < b.code ? -1 : 1));
    if (!codes.length || codes[0].incidents < 3) return null;
    return { severity: "medium", observed: codes[0].incidents, baseline: null, from: D - 6,
      evidence: { codes: codes.filter((c) => c.incidents >= 3), other_codes: codes.filter((c) => c.incidents < 3),
        excluded_7d: { code: ctx.safe_excluded.code.sum(D - 6, D), power_cycle: ctx.safe_excluded.power_cycle.sum(D - 6, D),
          no_code: ctx.safe_excluded.no_code.sum(D - 6, D) } } };
  },
};

// ---------------------------------------------------------------- rule 5
const prep_noncompliance = {
  key: "prep_noncompliance", version: 1, category: "compliance", default_severity: "low", quiet_days: QUIET_DAYS,
  label: "Daily prep not done",
  description: `In the last 14 days, more than half of the scan days (days with an exam) had no Fast Calibration (${FAST_CAL_STEPS.join(" / ")}). Needs >= 5 scan days.`,
  thresholds: { days: 14, max_share_without: 0.5, min_scan_days: 5, steps: FAST_CAL_STEPS },
  evaluate(ctx, D) {
    const scan = ctx.ind.exams.sum(D - 13, D), without = ctx.ind.scan_no_fast_cal.sum(D - 13, D);
    if (scan < 5 || 2 * without <= scan) return null;
    return { severity: "low", observed: pct(without, scan), baseline: null, from: D - 13,
      evidence: { scan_days: scan, scan_days_without_fast_cal: without, days_without: days_list(ctx, "scan_no_fast_cal", D - 13, D) } };
  },
};

// ---------------------------------------------------------------- rule 6 (event)
const tube_replaced = {
  key: "tube_replaced", version: 1, category: "tube", default_severity: "info", kind: "event", open_days: 30,
  label: "Tube replaced",
  description: "A tube replacement was detected (counter reset). Opens on the install date (first day with data on or after it), resolves 30 days later or at the next replacement. info = confirmed by service calibrations; low = counter_only (needs field-service review).",
  thresholds: { open_days: 30 },
  events(ctx) {
    return ctx.replacements.map((r) => ({
      day: r.install, severity: r.confidence === "confirmed" ? "info" : "low", observed: r.old_mas ?? null, baseline: null,
      evidence: { confidence: r.confidence, install_date: dstr(r.install), reset_at: new Date(r.t).toISOString(), reset_day: dstr(r.d),
        old_tube_mas: r.old_mas ?? null, tube_source: r.tube_source ?? null, calibrations_in_window: r.calibrations ?? null },
    }));
  },
};

// ---------------------------------------------------------------- rule 7
const ENV = [
  ["env_plenum", "Plenum temperature out of tolerance", "env.plenum_temp", ["env_plenum"]],
  ["env_detector_temp", "Detector temperature low", "env.detector_temp_low", ["env_detector_temp"]],
  ["env_humidity", "Humidity out of range", "env.humidity_out_of_range", ["env_humidity"]],
  ["env_psu", "Power supply out of spec", "env.psu_temp_out_of_spec / env.psu_voltage_out_of_spec", ["env_psu_temp", "env_psu_voltage"]],
];
const env_rules = ENV.map(([key, label, metrics, parts]) => ({
  key, version: 1, category: "environment", default_severity: "medium", quiet_days: QUIET_DAYS, label,
  description: `Environment out of tolerance (${metrics}) on >= 3 of the last 7 device days.`,
  thresholds: { min_days_7d: 3 },
  evaluate(ctx, D) {
    const n = ctx.ind[key].sum(D - 6, D);
    if (n < 3) return null;
    const evidence = { days: days_list(ctx, key, D - 6, D), events_7d: ctx.series[key].sum(D - 6, D) };
    if (parts.length > 1) evidence.by_metric = Object.fromEntries(parts.map((p) => [p, { days: ctx.ind[p].sum(D - 6, D), events: ctx.series[p].sum(D - 6, D) }]));
    return { severity: "medium", observed: n, baseline: null, from: D - 6, evidence };
  },
}));

// ---------------------------------------------------------------- rule 8
const warmup_bypass_habit = {
  key: "warmup_bypass_habit", version: 1, category: "compliance", default_severity: "low", quiet_days: QUIET_DAYS,
  label: "Warm-up bypass habit",
  description: "A skipped tube warm-up or a scan in the warm-up (yellow) zone on >= 50% of the scan days in the last 28 days. Only systems that log it.",
  thresholds: { days: 28, min_share: 0.5 },
  evaluate(ctx, D) {
    const capable = [ctx.first_seen.warmup_skipped, ctx.first_seen.warmup_zone].some((f) => f !== undefined && f <= D);
    if (!capable) return null;
    const scan = ctx.ind.exams.sum(D - 27, D), bypass = ctx.ind.scan_bypass.sum(D - 27, D);
    if (scan === 0 || 2 * bypass < scan) return null;
    return { severity: "low", observed: pct(bypass, scan), baseline: null, from: D - 27,
      evidence: { scan_days: scan, scan_days_with_bypass: bypass, with_skipped_warmup: ctx.ind.scan_skipped.sum(D - 27, D),
        with_warmup_zone_scan: ctx.ind.scan_zone.sum(D - 27, D) } };
  },
};

// ---------------------------------------------------------------- rule 9
const powered_off_without_shutdown = {
  key: "powered_off_without_shutdown", version: 1, category: "compliance", default_severity: "low", quiet_days: QUIET_DAYS,
  label: "Powered off without a shutdown",
  description: `>= 3 unclean boots (no desktop shutdown before the boot) in 7 days, not counting boots with service mode entered in the ${SERVICE_BEFORE_BOOT_H} h before.`,
  thresholds: { min_unclean_7d: 3, service_before_h: SERVICE_BEFORE_BOOT_H },
  evaluate(ctx, D) {
    const boots = ctx.unclean.filter((b) => b.d >= D - 6 && b.d <= D);
    if (boots.length < 3) return null;
    return { severity: "low", observed: boots.length, baseline: null, from: D - 6,
      evidence: { unclean_boots: boots.map((b) => b.t), excluded_service_mode: ctx.unclean_service.sum(D - 6, D) } };
  },
};

// ---------------------------------------------------------------- rule 10
const air_calibration_overdue = {
  key: "air_calibration_overdue", version: 1, category: "compliance", default_severity: "low", quiet_days: QUIET_DAYS,
  label: "Air calibration overdue",
  description: "The system logged that air calibration is overdue on >= 3 of the last 7 device days (the system then limits scanning to the large focal spot).",
  thresholds: { min_days_7d: 3 },
  evaluate(ctx, D) {
    const n = ctx.ind.air_overdue.sum(D - 6, D);
    if (n < 3) return null;
    return { severity: "low", observed: n, baseline: null, from: D - 6, evidence: { days: days_list(ctx, "air_overdue", D - 6, D) } };
  },
};

const finding_rules = [
  tube_rotor_instability, process_restart_loop, abort_rate_high, safe_state_recurrent, prep_noncompliance,
  tube_replaced, ...env_rules, warmup_bypass_habit, powered_off_without_shutdown, air_calibration_overdue,
];

function validate_finding_rules(rs = finding_rules) {
  const errs = [], seen = new Set();
  for (const r of rs) {
    if (!/^[a-z][a-z0-9_]*$/.test(r.key)) errs.push(`${r.key}: bad key`);
    if (seen.has(r.key)) errs.push(`${r.key}: duplicate`);
    seen.add(r.key);
    if (!SEVERITIES.includes(r.default_severity)) errs.push(`${r.key}: bad default severity`);
    if (!["utilization", "tube", "reliability", "compliance", "environment", "inventory"].includes(r.category)) errs.push(`${r.key}: bad category`);
    if (!(r.version > 0)) errs.push(`${r.key}: bad version`);
    if (r.kind === "event" ? typeof r.events !== "function" : typeof r.evaluate !== "function" || !(r.quiet_days > 0)) errs.push(`${r.key}: incomplete`);
  }
  return errs;
}

const catalog_rows = (rs = finding_rules) => rs.map((r) => ({
  finding_key: r.key, label: r.label, description: r.description, category: r.category,
  default_severity: r.default_severity, rule_version: r.version, customer_visible: r.customer_visible !== false,
}));

module.exports = { finding_rules, catalog_rows, validate_finding_rules, SEVERITIES, rank, QUIET_DAYS, QUIET_DAYS_DAILY, ROTOR, ABORT };
