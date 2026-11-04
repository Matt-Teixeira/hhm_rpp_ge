"use strict";
// Per-system evaluation context for the findings rules (PLAN-CT-INSIGHTS.md
// §14.2). Pure: built from the inputs that findings/load.js reads (or a test
// fixture), never touches the database.
//
// Days are device wall-clock days ('YYYY-MM-DD', the date of host_local),
// handled as integer day numbers (days since 1970-01-01). A window "7 d as of
// D" is D-6..D inclusive.
//
// Inputs (one system):
//   days         [{day, start_at, last_at}]  data days: days with any fact.
//                start_at = the instant of the device day's local midnight,
//                last_at = the newest fact that day (both ISO / Date)
//   daily        [{day, m, dim, n}]          ge_ct_daily cells of SERIES_METRICS
//   safe         [{t, day, code}]            scan.safe_state facts (no message text)
//   boots        [{t, day, clean}]           system.boot derived facts
//   shutdowns    [{t, day}]                  system.shutdown facts
//   service_enter [{t, day}]                 service.mode 'enter' facts
//   abort_codes  [{day, code, n}]            scan.abort.system per day and ermes code
//   replacements [{t, day, install_date, confidence, old_mas, tube_source, calibrations}]

const DAY_MS = 24 * 3600 * 1000;
const dnum = (s) => Math.round(Date.parse(`${String(s).slice(0, 10)}T00:00:00Z`) / DAY_MS);
const dstr = (n) => new Date(n * DAY_MS).toISOString().slice(0, 10);
const iso = (t) => (t instanceof Date ? t : new Date(t)).toISOString();
const tms = (t) => (t instanceof Date ? t.getTime() : Date.parse(t));

// Fast Calibration as agreed in §14.1 / rule 5.
const FAST_CAL_STEPS = ["Fast Calibration", "Cold Tube Warmup (Fast Calibration)"];
// Safe-state exclusions (rule 4): the power-cycle side effect.
const SAFE_EXCLUDED_CODES = ["260116316"];
const SAFE_POWER_CYCLE_MIN = 30;
// Safe states are counted as incidents: the same code again within 30 min
// of its previous event is the same incident (one press / one outage logs
// several lines; tuned 2026-11-04, plan §14 checkpoint 4).
const SAFE_INCIDENT_GAP_MIN = 30;
const SERVICE_BEFORE_BOOT_H = 12; // rule 9

// Daily series used by the rules: name -> predicate on a daily cell.
const SERIES = {
  rotor_stop: (c) => c.m === "tube.rotor_unexpected_stop",
  rotor_not_at_speed: (c) => c.m === "tube.rotor_not_at_speed",
  abort_system: (c) => c.m === "scan.abort.system",
  exams: (c) => c.m === "exam.start",
  fast_cal: (c) => c.m === "prep.tube_temp" && FAST_CAL_STEPS.includes(c.dim),
  env_plenum: (c) => c.m === "env.plenum_temp",
  env_detector_temp: (c) => c.m === "env.detector_temp_low",
  env_humidity: (c) => c.m === "env.humidity_out_of_range",
  env_psu: (c) => c.m === "env.psu_temp_out_of_spec" || c.m === "env.psu_voltage_out_of_spec",
  env_psu_temp: (c) => c.m === "env.psu_temp_out_of_spec",
  env_psu_voltage: (c) => c.m === "env.psu_voltage_out_of_spec",
  warmup_skipped: (c) => c.m === "op.warmup_skipped",
  warmup_zone: (c) => c.m === "op.scan_in_warmup_zone",
  air_overdue: (c) => c.m === "calibration.air_overdue",
};
const SERIES_METRICS = [
  "tube.rotor_unexpected_stop", "tube.rotor_not_at_speed", "scan.abort.system", "exam.start", "prep.tube_temp",
  "env.plenum_temp", "env.detector_temp_low", "env.humidity_out_of_range", "env.psu_temp_out_of_spec",
  "env.psu_voltage_out_of_spec", "op.warmup_skipped", "op.scan_in_warmup_zone", "calibration.air_overdue", "process.restart",
];

// Dense per-day arrays over [lo, hi] with prefix sums, so every window sum is O(1).
class Dense {
  constructor(lo, hi) { this.lo = lo; this.hi = hi; this.v = new Float64Array(hi - lo + 1); this.p = null; }
  add(d, x) { if (d >= this.lo && d <= this.hi) { this.v[d - this.lo] += x; this.p = null; } }
  get(d) { return d >= this.lo && d <= this.hi ? this.v[d - this.lo] : 0; }
  sum(a, b) {
    if (!this.p) { this.p = new Float64Array(this.v.length + 1); for (let i = 0; i < this.v.length; i++) this.p[i + 1] = this.p[i] + this.v[i]; }
    const i = Math.max(a, this.lo) - this.lo, j = Math.min(b, this.hi) - this.lo;
    return j < i ? 0 : this.p[j + 1] - this.p[i];
  }
}

// today: 'YYYY-MM-DD'. Data with a device day after today (a clock running
// ahead) is ignored, so a run is a pure function of (inputs, today).
function build_context(inputs, today) {
  const T = dnum(today);
  const days = inputs.days.map((d) => ({ n: dnum(d.day), day: String(d.day).slice(0, 10), start_at: iso(d.start_at), last_at: iso(d.last_at) }))
    .filter((d) => d.n <= T).sort((a, b) => a.n - b.n);
  const ctx = { system_id: inputs.system_id, today, T, days, by_day: new Map(days.map((d) => [d.n, d])) };
  if (!days.length) return Object.assign(ctx, { empty: true });
  const lo = days[0].n - 70, hi = T;
  ctx.lo = lo;
  const dense = () => new Dense(lo, hi);
  const data = dense();
  for (const d of days) data.add(d.n, 1);
  ctx.data = data;

  // series: count per day, and an indicator "n > 0 that day"
  ctx.series = {};
  ctx.ind = {};
  for (const name of Object.keys(SERIES)) { ctx.series[name] = dense(); ctx.ind[name] = dense(); }
  ctx.restarts = new Map(); // day -> [{process, n}]
  ctx.first_seen = {};      // series name -> first day with n > 0
  for (const c of inputs.daily) {
    const d = dnum(c.day);
    if (d > T) continue;
    const n = Number(c.n);
    if (c.m === "process.restart") {
      if (!ctx.restarts.has(d)) ctx.restarts.set(d, []);
      ctx.restarts.get(d).push({ process: c.dim, n });
    }
    for (const [name, pred] of Object.entries(SERIES)) {
      if (!pred(c)) continue;
      ctx.series[name].add(d, n);
      if (n > 0 && ctx.ind[name].get(d) === 0) ctx.ind[name].add(d, 1);
      if (n > 0 && !(ctx.first_seen[name] <= d)) ctx.first_seen[name] = d;
    }
  }
  // derived indicators: scan day without Fast Cal; scan day with a bypass
  ctx.ind.scan_no_fast_cal = dense();
  ctx.ind.scan_bypass = dense();
  ctx.ind.scan_skipped = dense();
  ctx.ind.scan_zone = dense();
  for (let d = lo; d <= hi; d++) {
    if (!ctx.ind.exams.get(d)) continue;
    if (!ctx.ind.fast_cal.get(d)) ctx.ind.scan_no_fast_cal.add(d, 1);
    if (ctx.ind.warmup_skipped.get(d) || ctx.ind.warmup_zone.get(d)) ctx.ind.scan_bypass.add(d, 1);
    if (ctx.ind.warmup_skipped.get(d)) ctx.ind.scan_skipped.add(d, 1);
    if (ctx.ind.warmup_zone.get(d)) ctx.ind.scan_zone.add(d, 1);
  }

  // safe states, with the power-cycle exclusions applied (rule 4)
  // Only boots/shutdowns up to the as-of day: later data must not change an
  // as-of result (review PHASE4-RULES F2).
  const upto = (x) => dnum(x.day) <= T;
  const cycles = [...(inputs.boots || []).filter(upto).map((b) => tms(b.t)), ...(inputs.shutdowns || []).filter(upto).map((s) => tms(s.t))]
    .sort((a, b) => a - b);
  const near_cycle = (t) => {
    // binary search for the nearest boot/shutdown
    let a = 0, b = cycles.length - 1;
    while (a <= b) { const m = (a + b) >> 1; if (cycles[m] < t) a = m + 1; else b = m - 1; }
    const lim = SAFE_POWER_CYCLE_MIN * 60000;
    return (a < cycles.length && cycles[a] - t <= lim) || (a > 0 && t - cycles[a - 1] <= lim);
  };
  ctx.safe = [];
  ctx.safe_excluded = { code: dense(), power_cycle: dense(), no_code: dense() };
  for (const s of inputs.safe || []) {
    const d = dnum(s.day);
    if (d > T) continue;
    const code = s.code === null || s.code === undefined ? "" : String(s.code);
    // no code: can't be "the same code" as anything (review PHASE4-RUN-VERIFY F1)
    if (code === "") { ctx.safe_excluded.no_code.add(d, 1); continue; }
    if (SAFE_EXCLUDED_CODES.includes(code)) { ctx.safe_excluded.code.add(d, 1); continue; }
    if (near_cycle(tms(s.t))) { ctx.safe_excluded.power_cycle.add(d, 1); continue; }
    ctx.safe.push({ d, code, t: tms(s.t) });
  }
  // incidents per code (after the exclusions); an incident's day is its first event's
  ctx.safe.sort((a, b) => a.t - b.t);
  const prev = new Map();
  for (const s of ctx.safe) {
    const p = prev.get(s.code);
    s.new_incident = p === undefined || s.t - p > SAFE_INCIDENT_GAP_MIN * 60000;
    prev.set(s.code, s.t);
  }

  // unclean boots without service mode entered in the 12 h before (rule 9)
  const enters = (inputs.service_enter || []).filter(upto).map((s) => tms(s.t)).sort((a, b) => a - b);
  const service_before = (t) => {
    let a = 0, b = enters.length - 1;
    while (a <= b) { const m = (a + b) >> 1; if (enters[m] < t) a = m + 1; else b = m - 1; }
    return a > 0 && t - enters[a - 1] <= SERVICE_BEFORE_BOOT_H * 3600000;
  };
  ctx.unclean = [];
  ctx.unclean_service = dense();
  for (const b of inputs.boots || []) {
    const d = dnum(b.day);
    if (d > T || b.clean) continue;
    if (service_before(tms(b.t))) { ctx.unclean_service.add(d, 1); continue; }
    ctx.unclean.push({ d, t: iso(b.t) });
  }
  ctx.unclean.sort((a, b) => (a.t < b.t ? -1 : 1));

  ctx.abort_codes = (inputs.abort_codes || []).map((a) => ({ d: dnum(a.day), code: String(a.code ?? ""), n: Number(a.n) })).filter((a) => a.d <= T);
  ctx.replacements = (inputs.replacements || []).map((r) => ({ ...r, d: dnum(r.day), install: dnum(r.install_date || r.day) }))
    .filter((r) => r.d <= T).sort((a, b) => a.install - b.install || a.d - b.d);
  return ctx;
}

// Instant of a data day's local midnight. Only data days have one: every
// finding opens and resolves on a data day (review PHASE4-RULES F3).
function day_start(ctx, d) {
  const x = ctx.by_day.get(d);
  if (!x) throw new Error(`${ctx.system_id}: ${dstr(d)} is not a data day`);
  return x.start_at;
}

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

module.exports = {
  build_context, day_start, median, dnum, dstr, DAY_MS, SERIES, SERIES_METRICS, FAST_CAL_STEPS,
  SAFE_EXCLUDED_CODES, SAFE_POWER_CYCLE_MIN, SAFE_INCIDENT_GAP_MIN, SERVICE_BEFORE_BOOT_H,
};
