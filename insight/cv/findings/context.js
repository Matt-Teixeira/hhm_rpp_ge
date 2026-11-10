"use strict";
// Per-system evaluation context for the GE CV findings rules
// (PLAN-CV-INSIGHTS.md §10). Pure: built from the inputs that load.js reads
// (or a test fixture); never touches the database.
//
// Same shape as the CT context (insight/findings/context.js), so CT's
// open/resolve fold (insight/findings/state.js) runs on it unchanged:
//   ctx.system_id, ctx.days [{n, day, start_at, last_at}], ctx.by_day, ctx.empty.
//
// Days are device wall-clock days ('YYYY-MM-DD', the date of host_local),
// handled as integer day numbers. A window "7 d as of D" is D-6..D.
//
// Inputs (one system):
//   days   [{day, start_at, last_at}]  data days: days with any CV fact.
//          start_at = the instant of the device day's local midnight (from
//          the day's first fact), last_at = the newest fact that day.
//   daily  [{day, m, dim, n}]          ge_cv_daily cells of SERIES_METRICS
//
// Nothing in the GE CT run loads this file.

const DAY_MS = 24 * 3600 * 1000;
const dnum = (s) => Math.round(Date.parse(`${String(s).slice(0, 10)}T00:00:00Z`) / DAY_MS);
const dstr = (n) => new Date(n * DAY_MS).toISOString().slice(0, 10);
const iso = (t) => (t instanceof Date ? t : new Date(t)).toISOString();

// 1200019 "detector offset out of limits" comes with the detector com storms
// (11 of its 12 days, plan §6.3); the storm rule leaves it out with them.
const DETECTOR_OFFSET_CODE = "1200019";

// Named metrics that have their own finding (rules 2-5). Their rows are not
// counted again by the storm rule (§10.2: the storm counts the residual).
const NAMED = {
  det: "cv.detector_com_error",
  ac: "cv.anticollision_error",
  tbl: "cv.table_encoder_failure",
  pib: "cv.pib_com_loss",
};
const SERIES_METRICS = ["cv.error", ...Object.values(NAMED)];

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

  const s = { err: dense(), offset: dense() };
  for (const k of Object.keys(NAMED)) s[k] = dense();
  ctx.codes = new Map(); // day -> Map(code -> n), cv.error only (evidence)
  ctx.dims = {};         // named key -> Map(day -> Map(dim -> n)) (evidence)
  for (const k of Object.keys(NAMED)) ctx.dims[k] = new Map();
  const bump = (m, d, k, n) => { if (!m.has(d)) m.set(d, new Map()); const x = m.get(d); x.set(k, (x.get(k) || 0) + n); };
  for (const c of inputs.daily) {
    const d = dnum(c.day);
    if (d > T || !ctx.by_day.has(d)) continue; // a cell always lies on a data day; guard anyway
    const n = Number(c.n), dim = c.dim === null || c.dim === undefined ? "" : String(c.dim);
    if (c.m === "cv.error") {
      s.err.add(d, n);
      if (dim === DETECTOR_OFFSET_CODE) s.offset.add(d, n);
      bump(ctx.codes, d, dim, n);
      continue;
    }
    for (const [k, m] of Object.entries(NAMED)) if (c.m === m) { s[k].add(d, n); bump(ctx.dims[k], d, dim, n); }
  }
  // residual: the cv.error rows no other CV finding counts (each counted row
  // has one cv.error fact and at most one named fact, so this is exact)
  s.residual = dense();
  for (const d of days) s.residual.add(d.n, s.err.get(d.n) - s.det.get(d.n) - s.ac.get(d.n) - s.tbl.get(d.n) - s.pib.get(d.n) - s.offset.get(d.n));
  ctx.series = s;
  ctx.memo = new Map();
  return ctx;
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

module.exports = { build_context, baseline, median, top_of, dnum, dstr, DAY_MS, NAMED, SERIES_METRICS, DETECTOR_OFFSET_CODE };
