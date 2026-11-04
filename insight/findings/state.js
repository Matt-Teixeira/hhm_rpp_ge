"use strict";
// Open / resolve state machine and replay (PLAN-CT-INSIGHTS.md §14.2 items
// 2-3). Pure.
//
// Evaluated days are the system's data days up to `today` (a run can only
// evaluate a day it has data for, so replay over data days is what daily
// runs would have produced). For each windowed rule, day by day:
//   - trip and no open finding  -> open (opened on that day)
//   - trip and open             -> extend: last trip = that day, severity = max (never falls)
//   - no trip, open, and `quiet_days` evaluated days since the last trip -> resolve on that day
// So at most one finding per (system, finding_key) is open, and a re-trip
// after it resolved opens a new one.
//
// tube_replaced (kind "event") opens on each replacement's install day (the
// first data day on or after it, so a finding always opens on a data day;
// review PHASE4-RULES F3) and resolves on the first evaluated day >=
// install + 30, or on the next replacement's opening day, whichever comes
// first. A replacement whose install day has no data day yet is not shown yet.
//
// Times: opened_at / resolved_at = the instant of the device day's local
// midnight (context.day_start). window_start / window_end bound the last
// trip's window in device days, using the as-of day's clock offset.
// last_evaluated = newest fact of the finding's data_through day. Nothing
// depends on the wall-clock time of the run, so a replay is idempotent.
const { finding_rules, rank } = require("./rules");
const { day_start, dstr, DAY_MS } = require("./context");

const shift = (isoStr, days) => new Date(Date.parse(isoStr) + days * DAY_MS).toISOString();

// One step of the fold for a windowed rule. `st` is the open finding or null;
// returns { st, closed } (closed = a finding resolved on this step).
function step(rule, st, i, D, r) {
  if (r) {
    if (!st) {
      return { st: { opened: D, opened_i: i, severity: r.severity, first: { day: D, ...r }, last: { day: D, ...r }, last_i: i,
        trip_days: 1, severity_history: [{ day: dstr(D), severity: r.severity }] }, closed: null };
    }
    const up = rank(r.severity) > rank(st.severity);
    return { st: { ...st, severity: up ? r.severity : st.severity, last: { day: D, ...r }, last_i: i, trip_days: st.trip_days + 1,
      severity_history: up ? [...st.severity_history, { day: dstr(D), severity: r.severity }] : st.severity_history }, closed: null };
  }
  if (st && i - st.last_i >= rule.quiet_days) return { st: null, closed: { ...st, resolved: D } };
  return { st, closed: null };
}

function result_evidence(x) {
  return { day: dstr(x.day), severity: x.severity, observed: x.observed, baseline: x.baseline,
    window: [dstr(x.from), dstr(x.day)], ...x.evidence };
}

function windowed_row(ctx, rule, f, last_day) {
  const end = f.resolved ?? last_day;
  const as_of = ctx.by_day.get(f.last.day);
  return {
    system_id: ctx.system_id, finding_key: rule.key, source: "ge_ct",
    status: f.resolved !== undefined ? "resolved" : "open", severity: f.severity,
    opened_at: day_start(ctx, f.opened), resolved_at: f.resolved !== undefined ? day_start(ctx, f.resolved) : null,
    window_start: shift(as_of.start_at, f.last.from - f.last.day), window_end: shift(as_of.start_at, 1),
    observed: f.last.observed ?? null, baseline: f.last.baseline ?? null,
    evidence: {
      rule_version: rule.version, thresholds: rule.thresholds, quiet_days: rule.quiet_days,
      opened_day: dstr(f.opened), last_trip_day: dstr(f.last.day), trip_days: f.trip_days,
      resolved_day: f.resolved !== undefined ? dstr(f.resolved) : null, severity_history: f.severity_history,
      first: result_evidence(f.first), last: result_evidence(f.last),
    },
    rule_version: rule.version, data_through: dstr(end), last_evaluated: ctx.by_day.get(end).last_at,
  };
}

function replay_windowed(ctx, rule) {
  const rows = [];
  let st = null;
  ctx.days.forEach((d, i) => {
    const r = rule.evaluate(ctx, d.n);
    const o = step(rule, st, i, d.n, r);
    st = o.st;
    if (o.closed) rows.push(windowed_row(ctx, rule, o.closed));
  });
  if (st) rows.push(windowed_row(ctx, rule, st, ctx.days[ctx.days.length - 1].n));
  return rows;
}

function replay_events(ctx, rule) {
  const first_data_on_or_after = (n) => { const x = ctx.days.find((d) => d.n >= n); return x ? x.n : undefined; };
  const sorted = rule.events(ctx).map((e) => ({ ...e, open: first_data_on_or_after(e.day) })).filter((e) => e.open !== undefined)
    .sort((a, b) => a.open - b.open || a.day - b.day);
  // two replacements opening on the same data day: the later install wins
  const evs = sorted.filter((e, j) => !(sorted[j + 1] && sorted[j + 1].open === e.open));
  const last_day = ctx.days[ctx.days.length - 1].n;
  return evs.map((e, j) => {
    const next = evs[j + 1];
    let resolved = first_data_on_or_after(e.day + rule.open_days);
    if (next && (resolved === undefined || next.open < resolved)) resolved = next.open;
    const end = resolved ?? last_day;
    const end_day = ctx.by_day.get(end);
    return {
      system_id: ctx.system_id, finding_key: rule.key, source: "ge_ct",
      status: resolved !== undefined ? "resolved" : "open", severity: e.severity,
      opened_at: day_start(ctx, e.open), resolved_at: resolved !== undefined ? day_start(ctx, resolved) : null,
      window_start: day_start(ctx, e.open), window_end: shift(day_start(ctx, e.open), rule.open_days),
      observed: e.observed, baseline: e.baseline,
      evidence: { rule_version: rule.version, thresholds: rule.thresholds, opened_day: dstr(e.open),
        resolved_day: resolved !== undefined ? dstr(resolved) : null,
        resolved_by: resolved === undefined ? null : next && next.open === resolved ? "next_replacement" : "open_days", ...e.evidence },
      rule_version: rule.version, data_through: dstr(end), last_evaluated: end_day.last_at,
    };
  });
}

// All findings of one system as of `today` (ctx built with that today).
function replay_system(ctx, rules = finding_rules) {
  if (ctx.empty) return [];
  const rows = [];
  for (const rule of rules) rows.push(...(rule.kind === "event" ? replay_events(ctx, rule) : replay_windowed(ctx, rule)));
  return rows.sort((a, b) => (a.finding_key < b.finding_key ? -1 : a.finding_key > b.finding_key ? 1 : a.opened_at < b.opened_at ? -1 : 1));
}

// Per-day trips of a windowed rule (for tests and the review report).
function trips(ctx, rule) {
  return ctx.days.map((d) => ({ day: d.day, r: rule.evaluate(ctx, d.n) })).filter((x) => x.r);
}

module.exports = { replay_system, replay_windowed, replay_events, step, trips };
