"use strict";
// Per-system evaluation context for the GE MRI findings rules
// (PLAN-MRI-INSIGHTS.md §9). Pure: built from the inputs that load.js reads
// (or a test), never touches the database.
//
// Same shape as the CT context (insight/findings/context.js), so CT's
// open/resolve fold (insight/findings/state.js) runs on it unchanged:
//   ctx.system_id, ctx.days [{n, day, start_at, last_at}], ctx.by_day, ctx.empty.
//
// Days are device wall-clock days ('YYYY-MM-DD', the date of host_local),
// handled as integer day numbers. A window "7 d as of D" is D-6..D.
//
// Inputs (one system):
//   days    [{day, start_at, last_at}]  data days: days with any MRI fact.
//           start_at = the instant of the device day's local midnight (from
//           the day's first fact), last_at = the newest fact that day.
//   daily   [{day, m, dim, n, v}]       ge_mri_daily cells of SERIES_METRICS
//           and every mri.error cell (dim = code); v = value_sum.
//   events  [{at, kind}]                restart events in source order
//           (host_local, record number, metric key): kind 'start' (sw_start),
//           'stop' (sw_stop or its companion 200002364), 'up' (System Up).
//   deaths  [{at, process}]             mri.process_death facts.
//   `at` = device wall clock 'YYYY-MM-DDTHH:MM:SS'.
//
// As of D, nothing after D is used (CT review F2): a death on D is "at a
// restart" (Q-D1: a restart event within RESTART_WINDOW_MIN device minutes,
// ../derived_sql.js) only by a restart event on a day <= D (plan §9.2 rule 4).
//
// Nothing in the GE CT or CV run loads this file.
const { CODE_CATEGORY } = require("../codes_reviewed");
const { named } = require("../rules");
const { RESTART_WINDOW_MIN, STOP_COMPANION } = require("../derived_sql");

const DAY_MS = 24 * 3600 * 1000;
const dnum = (s) => Math.round(Date.parse(`${String(s).slice(0, 10)}T00:00:00Z`) / DAY_MS);
const dstr = (n) => new Date(n * DAY_MS).toISOString().slice(0, 10);
const iso = (t) => (t instanceof Date ? t : new Date(t)).toISOString();
const local_ms = (at) => Date.parse(`${String(at).slice(0, 19)}Z`);

// The metrics the rules read (besides mri.error).
const M = {
  ok: "mri.scans_ok", failed: "mri.scans_failed", cool: "mri.cooling_fault", tps_failed: "mri.tps_reset_failed",
  tps_reset: "mri.tps_reset", prescan: "mri.prescan_failed", coil: "mri.coil_fault", table: "mri.table_fault",
  iq: "mri.iq_warning", pm: "mri.pm_overdue",
};
const SERIES_METRICS = ["mri.error", ...Object.values(M)];

// 'StartupCondition error on AGP resulted in TPS reset failure' (an mri.error code; plan §9.2 rule 3).
const TPS_STARTUP_CODE = "2256925";
// Prescan reasons that are an operator action, not a fault (plan §9.5 F3).
const PRESCAN_OPERATOR_REASONS = ["stop_button", "pause_button", "operator_request", "door_open", "table_not_at_scan_plane"];
// Cooling kinds that make a cooling finding high (the only cryogen signal; F4).
const CRYO_PREFIX = "hec_cryo";

// Rule 10's residual (plan §9.2, F2): mri.error codes of these reviewed
// categories, or not yet reviewed, minus the codes below.
const RESIDUAL_CATEGORIES = ["reliability", "hardware"];
// Metrics with a finding of their own (rules 2-9): their codes leave the residual.
const FINDING_METRICS = ["mri.cooling_fault", "mri.tps_reset_failed", "mri.process_death", "mri.prescan_failed",
  "mri.coil_fault", "mri.table_fault", "mri.iq_warning", "mri.pm_overdue"];
// Software start / stop, the stop companion, 'exited with status', msgView initialized.
const RESTART_SIGNATURE_CODES = ["200002347", "200002348", String(STOP_COMPANION), "200002379", "5600"];
const RESIDUAL_EXCLUDED_CODES = [...new Set([
  ...named.filter((n) => FINDING_METRICS.includes(n.key)).flatMap((n) => Object.keys(n.codes)),
  TPS_STARTUP_CODE, ...RESTART_SIGNATURE_CODES,
])].map(String).sort((a, b) => Number(a) - Number(b));
const EXCLUDED = new Set(RESIDUAL_EXCLUDED_CODES);
function in_residual(code) {
  if (EXCLUDED.has(String(code))) return false;
  const cat = CODE_CATEGORY.get(Number(code));
  return cat === undefined || RESIDUAL_CATEGORIES.includes(cat);
}

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
  const lo = days[0].n - 35, hi = T;
  const dense = () => new Dense(lo, hi);
  ctx.lo = lo;
  ctx.is_data = (n) => ctx.by_day.has(n);
  ctx.data_days = (a, b) => days.filter((d) => d.n >= a && d.n <= b).map((d) => d.n);

  const s = {};
  for (const k of ["ok", "failed", "cool", "cryo", "tps_failed", "tps_startup", "tps_reset", "prescan", "coil", "table", "iq", "pm", "residual", "unclean"]) s[k] = dense();
  ctx.dims = { cool: new Map(), prescan: new Map(), coil: new Map(), table: new Map(), pm: new Map(), residual: new Map() }; // day -> Map(dim -> n), evidence
  const bump = (m, d, k, n) => { if (!m.has(d)) m.set(d, new Map()); const x = m.get(d); x.set(k, (x.get(k) || 0) + n); };
  const op = new Set(PRESCAN_OPERATOR_REASONS);
  for (const c of inputs.daily) {
    const d = dnum(c.day);
    if (d > T || !ctx.by_day.has(d)) continue; // a cell always lies on a data day; guard anyway
    const n = Number(c.n), dim = c.dim === null || c.dim === undefined ? "" : String(c.dim);
    switch (c.m) {
      case "mri.error":
        if (dim === TPS_STARTUP_CODE) s.tps_startup.add(d, n);
        if (in_residual(dim)) { s.residual.add(d, n); bump(ctx.dims.residual, d, dim, n); }
        break;
      case M.ok: s.ok.add(d, Number(c.v || 0)); break;
      case M.failed: s.failed.add(d, Number(c.v || 0)); break;
      case M.cool: s.cool.add(d, n); if (dim.startsWith(CRYO_PREFIX)) s.cryo.add(d, n); bump(ctx.dims.cool, d, dim, n); break;
      case M.tps_failed: s.tps_failed.add(d, n); break;
      case M.tps_reset: s.tps_reset.add(d, n); break;
      case M.prescan: if (!op.has(dim)) { s.prescan.add(d, n); bump(ctx.dims.prescan, d, dim, n); } break;
      case M.coil: s.coil.add(d, n); bump(ctx.dims.coil, d, dim, n); break;
      case M.table: s.table.add(d, n); bump(ctx.dims.table, d, dim, n); break;
      case M.iq: s.iq.add(d, n); break;
      case M.pm: s.pm.add(d, n); bump(ctx.dims.pm, d, dim, n); break;
      default: break;
    }
  }

  // Events on device days after today are not data yet.
  const ev = (inputs.events || []).filter((e) => dnum(e.at) <= T);
  // Rule 11: a software session ended by a new start with no stop between,
  // counted on the day of that new start (System Up lines are not sessions).
  const sw = ev.filter((e) => e.kind === "start" || e.kind === "stop");
  for (let i = 1; i < sw.length; i++) if (sw[i].kind === "start" && sw[i - 1].kind === "start") s.unclean.add(dnum(sw[i].at), 1);

  // Rule 4: deaths not at a restart, per day and process. strict = no
  // restart event within the window on a day <= the death's day (used when
  // the death is on the as-of day D); full = none at all up to today (used
  // for earlier days, whose window can't reach past D).
  const times = ev.map((e) => ({ t: local_ms(e.at), d: dnum(e.at) })).sort((a, b) => a.t - b.t);
  const W = RESTART_WINDOW_MIN * 60 * 1000;
  const first_at_or_after = (t) => { let a = 0, b = times.length; while (a < b) { const m = (a + b) >> 1; if (times[m].t < t) a = m + 1; else b = m; } return a; };
  ctx.deaths = new Map(); // day -> Map(process -> {strict, full})
  for (const x of inputs.deaths || []) {
    const d = dnum(x.at);
    if (d > T || !ctx.by_day.has(d)) continue;
    const t = local_ms(x.at);
    let any = false, early = false;
    for (let i = first_at_or_after(t - W); i < times.length && times[i].t <= t + W; i++) { any = true; if (times[i].d <= d) early = true; }
    if (!ctx.deaths.has(d)) ctx.deaths.set(d, new Map());
    const m = ctx.deaths.get(d), p = String(x.process);
    const c = m.get(p) || { strict: 0, full: 0 };
    if (!early) c.strict++;
    if (!any) c.full++;
    m.set(p, c);
  }
  ctx.series = s;
  ctx.memo = new Map();
  return ctx;
}

// Deaths not at a restart in D-6..D per process, as of D.
function crashes(ctx, D) {
  const t = new Map();
  for (let d = D - 6; d <= D; d++) {
    for (const [p, c] of ctx.deaths.get(d) || []) {
      const n = d === D ? c.strict : c.full;
      if (n) t.set(p, (t.get(p) || 0) + n);
    }
  }
  return t;
}

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// Median of a series over the data days in D-days..D-1; null with fewer
// than min_days of them.
function baseline(ctx, name, D, days, min_days) {
  const key = `${name}|${D}|${days}|${min_days}`;
  if (ctx.memo.has(key)) return ctx.memo.get(key);
  const xs = ctx.data_days(D - days, D - 1).map((n) => ctx.series[name].get(n));
  const b = xs.length >= min_days ? median(xs) : null;
  ctx.memo.set(key, b);
  return b;
}

// Summed dims of a per-day Map over a window, largest first (ties by key), at most `top`.
function top_of(per_day, a, b, top = Infinity) {
  const t = new Map();
  for (let d = a; d <= b; d++) for (const [k, n] of per_day.get(d) || []) t.set(k, (t.get(k) || 0) + n);
  return [...t].sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0)).slice(0, top).map(([k, n]) => ({ k, n }));
}

module.exports = {
  build_context, crashes, baseline, median, top_of, in_residual, dnum, dstr, DAY_MS, M, SERIES_METRICS,
  TPS_STARTUP_CODE, PRESCAN_OPERATOR_REASONS, CRYO_PREFIX, RESIDUAL_CATEGORIES, FINDING_METRICS, RESTART_SIGNATURE_CODES,
  RESIDUAL_EXCLUDED_CODES, RESTART_WINDOW_MIN,
};
