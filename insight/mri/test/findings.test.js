"use strict";
// node insight/mri/test/findings.test.js  (no DB needed)
// GE MRI findings (PLAN-MRI-INSIGHTS.md §9): the rules, CT's fold over them,
// the MRI run's pure parts, and the real-data fixture against the
// independent SQL (tools/build_findings_fixtures.js).
const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const fs = require("fs");
const ctxm = require("../findings/context");
const { build_context, crashes, in_residual, dnum, dstr, RESIDUAL_EXCLUDED_CODES, PRESCAN_OPERATOR_REASONS, SERIES_METRICS } = ctxm;
const R = require("../findings/rules");
const { mri_finding_rules, mri_catalog_rows, validate_mri_finding_rules, QUIET_DAYS } = R;
const { replay_system, trips } = require("../../findings/state");
const { compare_findings } = require("../../findings/verify");
const { invariants } = require("../findings/verify");
const { FINDINGS_SQL, RESIDUAL_EXCLUDED, PRESCAN_OPERATOR } = require("../findings/verify_sql");
const run = require("../findings/run");
const { as_mri_rows, preflight } = run;
const { DAYS_SQL, DAILY_SQL, EVENTS_SQL, DEATHS_SQL } = require("../findings/load");
const { expand } = require("../tools/build_findings_fixtures");
const { CATEGORY_CODES } = require("../codes_reviewed");

const FX = path.join(__dirname, "..", "__fixtures__", "findings");
const rule = (k) => mri_finding_rules.find((r) => r.key === k);
const NOISE = String(CATEGORY_CODES.noise[0]);   // a reviewed noise code: never in the residual
const HW = "2252246";                              // a reviewed hardware code with no rule of its own (CAN quick reset)

// Synthetic system: `n` consecutive data days from 2026-01-01; cells(i) -> [{m, dim, n, v}]
function synth(n, cells = () => [], { gaps = [], events = [], deaths = [] } = {}) {
  const d0 = dnum("2026-01-01");
  const days = [], daily = [];
  for (let i = 0; i < n; i++) {
    if (gaps.includes(i)) continue;
    const day = dstr(d0 + i);
    days.push({ day, start_at: `${day}T05:00:00.000Z`, last_at: `${day}T20:00:00.000Z` });
    daily.push({ day, m: "mri.error", dim: NOISE, n: 20, v: null });
    for (const c of cells(i)) daily.push({ day, v: null, ...c });
  }
  return { system_id: "SYN", days, daily, events, deaths };
}
const D = (i) => dnum("2026-01-01") + i;
const at = (i, hms) => `${dstr(D(i))}T${hms}`;
const ctx_of = (inp, today = "2026-12-31") => build_context(inp, today);
const ev = (key, inp, i, today) => rule(key).evaluate(ctx_of(inp, today), D(i));
const replay = (inp, today = "2026-12-31") => as_mri_rows(replay_system(build_context(inp, today), mri_finding_rules));
const on = (days, c) => (i) => (days.includes(i) ? (Array.isArray(c) ? c : [c]) : []);

// ------------------------------------------------------------------ registry
test("registry: 11 mri_ windowed rules, internal, valid; categories; catalog generated from it", () => {
  assert.deepStrictEqual(validate_mri_finding_rules(), []);
  assert.deepStrictEqual(mri_finding_rules.map((r) => r.key), [
    "mri_failed_scans_high", "mri_cooling_fault", "mri_tps_reset_failures", "mri_process_crash_loop", "mri_prescan_failures",
    "mri_coil_fault", "mri_table_fault", "mri_image_quality_warning", "mri_pm_overdue", "mri_error_storm", "mri_unclean_restarts"]);
  const cat = Object.fromEntries(mri_catalog_rows().map((r) => [r.finding_key, `${r.category}/${r.default_severity}`]));
  assert.strictEqual(cat.mri_cooling_fault, "environment/medium");
  assert.strictEqual(cat.mri_pm_overdue, "compliance/low");
  assert.strictEqual(cat.mri_unclean_restarts, "reliability/low");
  for (const r of mri_catalog_rows()) {
    assert.match(r.finding_key, /^mri_[a-z0-9_]+$/);
    assert.strictEqual(r.customer_visible, false);
    assert.strictEqual(r.rule_version, 1);
  }
  for (const r of mri_finding_rules) assert.strictEqual(r.quiet_days, QUIET_DAYS);
  assert.strictEqual(QUIET_DAYS, 14);
  assert.ok(validate_mri_finding_rules([{ ...rule("mri_pm_overdue"), key: "pm_overdue" }]).some((e) => /start with mri_/.test(e)));
  assert.ok(validate_mri_finding_rules([{ ...rule("mri_pm_overdue"), customer_visible: true }]).some((e) => /internal/.test(e)));
  assert.ok(validate_mri_finding_rules([{ ...rule("mri_pm_overdue"), quiet_days: 7 }]).some((e) => /quiet period/.test(e)));
});

test("the independent SQL writes out the same thresholds and code lists as the registry", () => {
  const sql = FINDINGS_SQL.replace(/\s+/g, " ");
  assert.deepStrictEqual([...RESIDUAL_EXCLUDED].map(String).sort(), [...RESIDUAL_EXCLUDED_CODES].sort(), "rule 10's excluded codes");
  assert.deepStrictEqual(PRESCAN_OPERATOR, PRESCAN_OPERATOR_REASONS);
  const { FAILED_SCANS: F, COOLING: C, TPS, CRASH, PRESCAN: P, COIL, TABLE: T, IQ, PM, STORM: S, UNCLEAN: U } = R;
  for (const s of [
    `okb + flb >= ${F.min_baseline_scans}`, `fl7 >= ${F.min_failed_7d}`, `100 * fl7 >= ${F.min_share_pct} * (ok7 + fl7)`, `fl7 * (okb + flb) >= ${F.factor} * flb * (ok7 + fl7)`,
    `'${-F.baseline_from} days' PRECEDING AND '${-F.baseline_to} days' PRECEDING`,
    `coold7 >= ${C.min_days_7d}`, `cool >= ${C.burst_per_day}`, `left(y.dim, 8) = 'hec_cryo'`,
    `tpsd7 >= ${TPS.min_days_7d}`, `tpsd28 >= ${TPS.high_days_28d}`, `y.dim = '${TPS.codes[1]}'`,
    `crash_max >= ${CRASH.min_per_process_7d}`, `crash_max >= ${CRASH.high_per_process_7d}`, `interval '10 minutes'`,
    `pre >= ${P.min_per_day}`, `pre_n >= ${P.min_baseline_days}`, `pre >= ${P.factor} * greatest(pre_med, 1)`,
    `coild7 >= ${COIL.min_days_7d}`, `coild28 >= ${COIL.high_days_28d}`,
    `tbl >= ${T.min_per_day} AND tbl_n >= ${T.min_baseline_days} AND tbl >= ${T.factor} * greatest(tbl_med, 1)`,
    `(tbl >= ${T.persistent_per_day})::int`, `tpd7 >= ${T.persistent_days_7d}`,
    `iqd7 >= ${IQ.min_days_7d}`, `pmd7 >= ${PM.min_days_7d}`,
    `res >= ${S.min_residual} AND res_n >= ${S.min_baseline_days} AND res >= ${S.factor} * greatest(res_med, 1)`, `st28 >= ${S.high_storm_days_28d}`,
    `y.d BETWEEN x.d - ${S.baseline_days} AND x.d - 1`, `uc7 >= ${U.min_7d}`, `${QUIET_DAYS} AS q`,
    `c.category IN ('reliability', 'hardware')`]) {
    assert.ok(sql.includes(s), s);
  }
  assert.strictEqual(ctxm.RESTART_WINDOW_MIN, 10);
});

// ------------------------------------------------------------------ context
test("context: the residual (rule 10) by code category, minus finding codes and restart signatures", () => {
  assert.strictEqual(in_residual(HW), true, "hardware, no rule of its own");
  assert.strictEqual(in_residual("2223625"), true, "reliability");
  assert.strictEqual(in_residual("987654321"), true, "a code never reviewed counts until it is");
  assert.strictEqual(in_residual(NOISE), false, "noise");
  assert.strictEqual(in_residual(String(CATEGORY_CODES.service[0])), false, "service");
  assert.strictEqual(in_residual("2218650"), false, "utilization (exam summary)");
  for (const c of ["2261733", "2227556", "2256925", "200002354", "2224666", "2252301", "103453", "2218672", "2218671", "200002364", "200002379", "5600", "200002347"]) {
    assert.strictEqual(in_residual(c), false, c);
  }
  const inp = synth(3, (i) => [{ m: "mri.error", dim: HW, n: 7 }, { m: "mri.error", dim: "2261733", n: 5 }, { m: "mri.error", dim: "2256925", n: 2 }]);
  const c = ctx_of(inp, "2026-01-02");
  assert.strictEqual(c.series.residual.get(D(1)), 7);
  assert.strictEqual(c.series.tps_startup.get(D(1)), 2);
  assert.strictEqual(c.series.residual.get(D(2)), 0, "after today: ignored");
  assert.strictEqual(c.days.length, 2);
});

test("context: scan sums from value_sum, prescan operator reasons left out, cryo kinds, off-data-day cells ignored", () => {
  const inp = synth(2, () => [
    { m: "mri.scans_ok", dim: "", n: 3, v: 40 }, { m: "mri.scans_failed", dim: "", n: 3, v: 2 },
    { m: "mri.prescan_failed", dim: "driver_module_error", n: 4 }, { m: "mri.prescan_failed", dim: "stop_button", n: 9 },
    { m: "mri.cooling_fault", dim: "hec_cryo_compressor_flow_low", n: 1 }, { m: "mri.cooling_fault", dim: "brm_water_flow", n: 2 }]);
  inp.daily.push({ day: "2026-01-05", m: "mri.coil_fault", dim: "x", n: 99, v: null }); // not a data day
  const c = ctx_of(inp);
  assert.deepStrictEqual([c.series.ok.get(D(0)), c.series.failed.get(D(0)), c.series.prescan.get(D(0)), c.series.cool.get(D(0)), c.series.cryo.get(D(0))], [40, 2, 4, 3, 1]);
  assert.strictEqual(c.series.coil.sum(D(0), D(10)), 0);
  assert.deepStrictEqual(PRESCAN_OPERATOR_REASONS, ["stop_button", "pause_button", "operator_request", "door_open", "table_not_at_scan_plane"]);
  assert.ok(SERIES_METRICS.includes("mri.error") && SERIES_METRICS.every((m) => m.startsWith("mri.")));
});

test("context: unclean restarts = a start after a start (stop companion counts as a stop; System Up doesn't), on the new start's day", () => {
  const events = [
    { at: at(0, "08:00:00"), kind: "start" }, { at: at(0, "08:00:30"), kind: "up" }, { at: at(1, "07:00:00"), kind: "start" }, // unclean, day 1
    { at: at(1, "19:00:00"), kind: "stop" }, { at: at(2, "07:00:00"), kind: "start" },                                       // clean
    { at: at(3, "07:00:00"), kind: "start" }, { at: at(3, "07:30:00"), kind: "start" },                                      // two unclean, day 3
    { at: at(5, "07:00:00"), kind: "start" },                                                                                // unclean, day 5: after today
  ];
  const c = ctx_of(synth(6, () => [], { events }), "2026-01-04");
  assert.deepStrictEqual([0, 1, 2, 3, 4, 5].map((i) => c.series.unclean.get(D(i))), [0, 1, 0, 2, 0, 0]);
});

test("context: a death is at a restart within 10 device minutes; as of its own day only by events on a day <= it (Q-D1, CT F2)", () => {
  const deaths = [
    { at: at(2, "23:55:00"), process: "autoview" },   // a start at 00:05 the next day
    { at: at(2, "12:00:00"), process: "autoview" },   // a stop 10 min before: at a restart
    { at: at(2, "13:00:00"), process: "autoview" },   // nothing near: a crash
    { at: at(2, "14:00:00"), process: "RtpHost" },    // a System Up 10:01 later: a crash
  ];
  const events = [{ at: at(2, "11:50:00"), kind: "stop" }, { at: at(3, "00:05:00"), kind: "start" }, { at: at(2, "14:10:01"), kind: "up" }];
  const inp = synth(5, () => [], { deaths, events });
  assert.deepStrictEqual([...crashes(ctx_of(inp), D(2))], [["autoview", 2], ["RtpHost", 1]], "as of its own day: the next day's start doesn't count");
  assert.deepStrictEqual([...crashes(ctx_of(inp), D(3))], [["autoview", 1], ["RtpHost", 1]], "a day later it does");
  assert.deepStrictEqual([...crashes(ctx_of(inp, dstr(D(2))), D(2))], [["autoview", 2], ["RtpHost", 1]], "a run on day 2 sees the same");
  assert.deepStrictEqual([...crashes(ctx_of(inp), D(9))], [], "out of the window");
});

test("review MRI4-FINDINGS P2: a restart just after midnight never changes the trip of the day before", () => {
  // 4 deaths on days 2-4, a 5th at 23:55 on day 5; variant A adds a start at 00:05 on day 6.
  const deaths = [at(2, "11:00:00"), at(2, "12:00:00"), at(3, "12:00:00"), at(4, "12:00:00"), at(5, "23:55:00")].map((t) => ({ at: t, process: "synthproc" }));
  const A = synth(20, () => [], { deaths, events: [{ at: at(6, "00:05:00"), kind: "start" }] });
  const B = synth(20, () => [], { deaths });
  const day = (inp, today, i) => rule("mri_process_crash_loop").evaluate(ctx_of(inp, today), D(i));
  for (const today of [dstr(D(5)), dstr(D(6)), "2026-12-31"]) {
    assert.deepStrictEqual(day(A, today, 5), day(B, today, 5), `day 5 as of ${today}: the same with or without the day-6 start`);
    assert.strictEqual(day(A, today, 5).observed, 5);
  }
  assert.strictEqual(day(A, "2026-12-31", 6), null, "on day 6 the start is that day's data: the 23:55 death is at a restart");
  assert.strictEqual(day(B, "2026-12-31", 6).observed, 5);
  // and day by day: every as-of day sees exactly what a run on that day saw, for deaths on either side of midnight
  const both = synth(20, () => [], {
    deaths: [...deaths, { at: at(9, "00:03:00"), process: "synthproc" }, ...[8, 8, 9, 9].map((i, k) => ({ at: at(i, `1${k}:00:00`), process: "synthproc" }))],
    events: [{ at: at(6, "00:05:00"), kind: "start" }, { at: at(8, "23:58:00"), kind: "stop" }],
  });
  const full = ctx_of(both);
  for (let i = 0; i < 20; i++) assert.deepStrictEqual([...crashes(full, D(i))], [...crashes(ctx_of(both, dstr(D(i))), D(i))], `day ${i}`);
});

// ------------------------------------------------------------------ rules: boundaries
test("rule 1 failed scans: >= 10 failed, >= 5%, >= 3x the share of D-34..D-7 (>= 100 scans there)", () => {
  const scans = (ok, f) => [{ m: "mri.scans_ok", dim: "", n: 1, v: ok }, { m: "mri.scans_failed", dim: "", n: 1, v: f }];
  // days 0-27: 100 scans with 1 failed a day (baseline 1%); day 40: the week
  const mk = (ok, f) => synth(41, (i) => (i < 28 ? scans(99, 1) : i === 40 ? scans(ok, f) : []));
  const r = ev("mri_failed_scans_high", mk(190, 10), 40);
  assert.ok(r, "10 of 200 = 5% vs 1%");
  assert.strictEqual(r.observed, 5);
  assert.ok(Math.abs(r.baseline - 1) < 1e-9);
  assert.deepStrictEqual([r.evidence.failed_7d, r.evidence.scans_7d, r.evidence.baseline_window], [10, 200, ["2026-01-07", "2026-02-03"]]);
  assert.strictEqual(ev("mri_failed_scans_high", mk(191, 10), 40), null, "4.98%");
  assert.strictEqual(ev("mri_failed_scans_high", mk(80, 9), 40), null, "9 failed");
  // 3x: baseline 4% -> needs 12%
  const mk2 = (ok, f) => synth(41, (i) => (i < 28 ? scans(96, 4) : i === 40 ? scans(ok, f) : []));
  assert.ok(ev("mri_failed_scans_high", mk2(88, 12), 40));
  assert.strictEqual(ev("mri_failed_scans_high", mk2(89, 12), 40), null);
  // baseline needs 100 scans in D-34..D-7
  const thin = synth(41, (i) => (i === 10 ? scans(98, 1) : i === 40 ? scans(50, 50) : []));
  assert.strictEqual(ev("mri_failed_scans_high", thin, 40), null, "99 baseline scans");
  const just = synth(41, (i) => (i === 10 ? scans(99, 1) : i === 40 ? scans(50, 50) : []));
  assert.ok(ev("mri_failed_scans_high", just, 40), "100 baseline scans");
});

test("rule 2 cooling: >= 3 days in 7 or >= 50 in a day; high on a burst or a cryo-compressor alarm", () => {
  const c = (kind, n) => ({ m: "mri.cooling_fault", dim: kind, n });
  assert.strictEqual(ev("mri_cooling_fault", synth(10, on([3, 5], c("rf_coil_airflow", 9))), 6), null);
  const r = ev("mri_cooling_fault", synth(10, on([3, 5, 6], c("rf_coil_airflow", 9))), 6);
  assert.deepStrictEqual([r.severity, r.observed], ["medium", 27]);
  assert.strictEqual(ev("mri_cooling_fault", synth(10, on([3, 5, 6], c("hec_cryo_compressor_flow_low", 1))), 6).severity, "high");
  assert.strictEqual(ev("mri_cooling_fault", synth(10, on([2], c("brm_water_flow", 49))), 6), null);
  const b = ev("mri_cooling_fault", synth(10, on([2], c("brm_water_flow", 50))), 8);
  assert.deepStrictEqual([b.severity, b.evidence.burst_days], ["high", ["2026-01-03"]]);
  assert.strictEqual(ev("mri_cooling_fault", synth(10, on([2], c("brm_water_flow", 50))), 9), null, "out of the window");
});

test("rule 3 TPS: a failure (2227556 or 2256925) on >= 2 days in 7; high with >= 4 in 28", () => {
  const f = { m: "mri.tps_reset_failed", dim: "", n: 1 }, s = { m: "mri.error", dim: "2256925", n: 6 };
  assert.strictEqual(ev("mri_tps_reset_failures", synth(30, on([5], [f, s])), 6), null, "one day");
  const r = ev("mri_tps_reset_failures", synth(30, (i) => (i === 1 ? [f] : i === 6 ? [s] : [])), 6);
  assert.deepStrictEqual([r.severity, r.observed, r.evidence.days.map((x) => [x.not_successful, x.startup_condition])], ["medium", 2, [[1, 0], [0, 6]]]);
  assert.strictEqual(ev("mri_tps_reset_failures", synth(30, on([1, 20, 25, 27], f)), 28).severity, "high", "days 1, 20, 25, 27 in D-27..D");
  assert.strictEqual(ev("mri_tps_reset_failures", synth(30, on([1, 20, 25, 27], f)), 29).severity, "medium", "day 1 left the 28 days");
});

test("rule 4 crash loop: one process >= 5 not at a restart in 7 days; high at 20", () => {
  const deaths = (n, p = "autoview", i0 = 1) => Array.from({ length: n }, (_, k) => ({ at: at(i0 + (k % 6), `1${k % 10}:00:00`), process: p }));
  assert.strictEqual(ev("mri_process_crash_loop", synth(10, () => [], { deaths: deaths(4) }), 7), null);
  const r = ev("mri_process_crash_loop", synth(10, () => [], { deaths: [...deaths(5), ...deaths(4, "RtpHost")] }), 7);
  assert.deepStrictEqual([r.severity, r.observed, r.evidence.processes, r.evidence.all_deaths_not_at_restart_7d], ["medium", 5, [{ process: "autoview", n: 5 }], 9]);
  assert.strictEqual(ev("mri_process_crash_loop", synth(10, () => [], { deaths: deaths(20) }), 7).severity, "high");
  const restart = Array.from({ length: 6 }, (_, k) => ({ at: at(1 + k, "10:05:00"), kind: "start" }));
  assert.strictEqual(ev("mri_process_crash_loop", synth(10, () => [], { deaths: deaths(5), events: restart }), 7), null, "the 10:00 deaths are at a restart");
});

test("rule 5 prescan: a day >= 15 (operator reasons out) and >= 5x max(baseline, 1), needs a baseline", () => {
  const p = (dim, n) => ({ m: "mri.prescan_failed", dim, n });
  const base3 = (i) => (i < 20 ? [p("try_again", 3)] : []);
  assert.ok(ev("mri_prescan_failures", synth(30, (i) => [...base3(i), ...(i === 25 ? [p("driver_module_error", 15)] : [])]), 25));
  assert.strictEqual(ev("mri_prescan_failures", synth(30, (i) => [...base3(i), ...(i === 25 ? [p("driver_module_error", 14)] : [])]), 25), null, "14");
  assert.strictEqual(ev("mri_prescan_failures", synth(30, (i) => [...base3(i), ...(i === 25 ? [p("driver_module_error", 10), p("stop_button", 10)] : [])]), 25), null, "operator reasons");
  // baseline: median of D-28..D-1 = 3 -> needs 15; with median 4 -> needs 20
  const b4 = (i) => (i < 25 ? [p("try_again", 4)] : []);
  assert.strictEqual(ev("mri_prescan_failures", synth(30, (i) => [...b4(i), ...(i === 25 ? [p("x", 15)] : [])]), 25), null);
  const r = ev("mri_prescan_failures", synth(30, (i) => [...b4(i), ...(i === 25 ? [p("x", 20)] : [])]), 25);
  assert.deepStrictEqual([r.observed, r.baseline], [20, 4]);
  assert.strictEqual(ev("mri_prescan_failures", synth(30, (i) => (i === 5 ? [p("x", 99)] : [])), 5), null, "5 data days before: no baseline");
});

test("rule 6 coil faults: >= 4 days in 7; high with >= 14 in 28", () => {
  const c = { m: "mri.coil_fault", dim: "bias_open_circuit", n: 1 };
  assert.strictEqual(ev("mri_coil_fault", synth(10, on([1, 3, 5], c)), 6), null);
  assert.strictEqual(ev("mri_coil_fault", synth(10, on([1, 3, 5, 6], c)), 6).severity, "medium");
  const every = (i) => [c];
  assert.strictEqual(ev("mri_coil_fault", synth(30, every), 12).severity, "medium", "13 days");
  assert.strictEqual(ev("mri_coil_fault", synth(30, every), 13).severity, "high", "14 days");
});

test("rule 7 table: spike (>= 10 and >= 5x baseline) or persistent (>= 10 on >= 5 days of 7)", () => {
  const t = (n) => ({ m: "mri.table_fault", dim: "clutch_slip", n });
  const s = ev("mri_table_fault", synth(30, (i) => (i < 20 ? [t(1)] : i === 25 ? [t(10)] : [])), 25);
  assert.deepStrictEqual([s.evidence.variant, s.observed, s.baseline], ["spike", 10, 1]);
  assert.strictEqual(ev("mri_table_fault", synth(30, (i) => (i < 20 ? [t(1)] : i === 25 ? [t(9)] : [])), 25), null);
  // chronic 12 a day: no spike (baseline 12), persistent from the 5th day of 7
  const chronic = synth(30, (i) => [t(12)]);
  const p = ev("mri_table_fault", chronic, 25);
  assert.deepStrictEqual([p.evidence.variant, p.observed, p.baseline], ["persistent", 84, null]);
  assert.strictEqual(ev("mri_table_fault", synth(30, (i) => (i >= 19 && i !== 23 && i !== 24 ? [t(12)] : [t(9)])), 25).evidence.variant, "persistent", "5 of 19..25");
  assert.strictEqual(ev("mri_table_fault", synth(30, (i) => (i >= 20 && i !== 23 && i !== 24 ? [t(12)] : [t(9)])), 25), null, "4 days");
});

test("rules 8, 9, 11: IQ on >= 2 days, PM on >= 3 days (low), >= 3 unclean restarts (low)", () => {
  const iq = { m: "mri.iq_warning", dim: "", n: 15 }, pm = { m: "mri.pm_overdue", dim: "scheduled", n: 5 };
  assert.strictEqual(ev("mri_image_quality_warning", synth(10, on([6], iq)), 6), null);
  assert.deepStrictEqual((({ severity, observed }) => ({ severity, observed }))(ev("mri_image_quality_warning", synth(10, on([0, 6], iq)), 6)), { severity: "medium", observed: 30 });
  assert.strictEqual(ev("mri_pm_overdue", synth(10, on([4, 6], pm)), 6), null);
  assert.deepStrictEqual((({ severity, observed }) => ({ severity, observed }))(ev("mri_pm_overdue", synth(10, on([0, 4, 6], pm)), 6)), { severity: "low", observed: 3 });
  const starts = (is) => is.map((i) => ({ at: at(i, "07:00:00"), kind: "start" }));
  assert.strictEqual(ev("mri_unclean_restarts", synth(10, () => [], { events: starts([0, 2, 4]) }), 6), null, "2 unclean");
  assert.deepStrictEqual((({ severity, observed }) => ({ severity, observed }))(ev("mri_unclean_restarts", synth(10, () => [], { events: starts([0, 2, 4, 6]) }), 6)), { severity: "low", observed: 3 });
});

test("rule 10 storm: residual >= 300 and >= 10x max(baseline, 1); high with 3 storm days in 28; finding codes don't count", () => {
  const e = (dim, n) => ({ m: "mri.error", dim, n });
  const quiet = (i) => (i < 20 ? [e(HW, 20)] : []);
  assert.strictEqual(ev("mri_error_storm", synth(30, (i) => [...quiet(i), ...(i === 25 ? [e(HW, 199)] : [])]), 25), null, "199 (+ baseline 20 x 10 = 200)");
  const r = ev("mri_error_storm", synth(30, (i) => [...quiet(i), ...(i === 25 ? [e(HW, 300)] : [])]), 25);
  assert.deepStrictEqual([r.severity, r.observed, r.baseline, r.evidence.top_codes], ["medium", 300, 20, [{ code: HW, n: 320 }]]);
  assert.strictEqual(ev("mri_error_storm", synth(30, (i) => [...quiet(i), ...(i === 25 ? [e("2261733", 5000), e(NOISE, 5000)] : [])]), 25), null, "cooling + noise codes");
  const three = synth(40, (i) => [e(HW, 2), ...([20, 25, 30].includes(i) ? [e(HW, 400)] : [])]);
  assert.strictEqual(ev("mri_error_storm", three, 30).severity, "high");
});

// ------------------------------------------------------------------ fold, purity, run
test("CT's fold over MRI rules: open, 14 evaluated quiet days, resolve; a later trip opens a new finding", () => {
  const iq = (i) => ([10, 11, 40, 41].includes(i) ? [{ m: "mri.iq_warning", dim: "", n: 3 }] : []);
  const rows = replay(synth(60, iq, { gaps: [20, 21] })).filter((r) => r.finding_key === "mri_image_quality_warning");
  assert.deepStrictEqual(rows.map((r) => [r.status, r.evidence.opened_day, r.evidence.last_trip_day, r.evidence.resolved_day, r.source]), [
    ["resolved", "2026-01-12", "2026-01-17", "2026-02-02", "ge_mri"], // 2nd day opens; last trip day 16 + 14 data days (20, 21 missing)
    ["open", "2026-02-11", "2026-02-16", null, "ge_mri"],             // 13 data days after its last trip: still open
  ]);
  const later = replay(synth(61, iq, { gaps: [20, 21] })).filter((r) => r.finding_key === "mri_image_quality_warning");
  assert.strictEqual(later[1].evidence.resolved_day, "2026-03-02", "resolves on the 14th");
  assert.strictEqual(rows[0].opened_at, "2026-01-12T05:00:00.000Z");
  assert.strictEqual(rows[0].resolved_at, "2026-02-02T05:00:00.000Z");
  assert.strictEqual(rows[0].window_start, "2026-01-11T05:00:00.000Z", "the last trip's 7 days");
  assert.strictEqual(rows[0].window_end, "2026-01-18T05:00:00.000Z");
});

test("as-of purity on real data: every rule's result on a day is the same whatever data comes later", () => {
  const fx = JSON.parse(fs.readFileSync(path.join(FX, "inputs.json")));
  let checked = 0;
  for (const s of fx.systems.map(expand)) {
    const full = build_context(s, fx.today);
    const ds = full.days;
    for (const cut of [ds[Math.floor(ds.length / 3)], ds[Math.floor((2 * ds.length) / 3)]]) {
      const early = build_context(s, cut.day);
      for (const r of mri_finding_rules) {
        const a = trips(early, r);
        const b = trips(full, r).filter((x) => x.day <= cut.day);
        assert.deepStrictEqual(a, b, `${s.system_id} ${r.key} as of ${cut.day}`);
        checked += a.length;
      }
    }
  }
  assert.ok(checked > 2000, `${checked} trip days compared`);
});

test("as_mri_rows: relabels the fold's rows as ge_mri and refuses a non-MRI key", () => {
  assert.deepStrictEqual(as_mri_rows([{ finding_key: "mri_pm_overdue", source: "ge_ct", x: 1 }]), [{ finding_key: "mri_pm_overdue", source: "ge_mri", x: 1 }]);
  assert.throws(() => as_mri_rows([{ finding_key: "cv_pib_com_loss", source: "ge_ct" }]), /not an MRI finding key/);
  assert.throws(() => as_mri_rows([{ finding_key: "tube_replaced", source: "ge_ct" }]), /not an MRI finding key/);
});

test("preflight refusals: limited user, schema 9, derive caught up; --apply refused until C1-MRI", async () => {
  process.env.INSIGHT_PG_USER = "insight_writer";
  const fake = ({ user = "insight_writer", su = false, v = 9, derive = { s: "ok", p: {}, c: null }, inv = [] } = {}) => ({
    one: async (sql) => (/current_user/.test(sql) ? { u: user, su } : { v }),
    oneOrNone: async () => derive,
    any: async () => inv,
  });
  await assert.rejects(preflight(fake({ user: "avantehs_admin" }), { mode: "rehearse" }), /expected the limited/);
  await assert.rejects(preflight(fake({ su: true }), { mode: "rehearse" }), /expected the limited/);
  await assert.rejects(preflight(fake({ v: 8 }), { mode: "rehearse" }), /version 8 < 9: apply migration 009/);
  await assert.rejects(preflight(fake({ derive: { s: "ok", p: { SME00001: { days: ["2026-11-10"] } }, c: null } }), { mode: "rehearse" }), /derive is not caught up \(pending: SME00001/);
  await assert.rejects(preflight(fake({ derive: { s: "ok", p: {}, c: true } }), { mode: "rehearse" }), /code labels owed: true/);
  await assert.rejects(preflight(fake({ derive: null }), { mode: "rehearse" }), /no successful run on record \(status: no job state\)/);
  await assert.rejects(preflight(fake({ derive: { s: "error", p: null, c: null } }), { mode: "rehearse" }), /status: error/);
  await assert.rejects(preflight(fake({ inv: [{ system_id: "SME00001", day: "2026-11-09", kind: "facts_only" }, { system_id: "SME00001", day: "2026-11-10", kind: "facts_only" }] }), { mode: "rehearse" }),
    /ge_mri_daily disagree.*SME00001 facts_only: 2 days \(2026-11-09\.\.2026-11-10\)/);
  assert.deepStrictEqual(await preflight(fake(), { mode: "rehearse" }), { user: "insight_writer", schema_version: 9 });
  // C1-MRI is not done in this checkout: the CT verifiers don't export MRI_AWARE (plan §6.4).
  // The C1-MRI change flips this, with the "C1-MRI interlock" test in mri.test.js.
  await assert.rejects(preflight(fake(), { mode: "apply" }), /refusing --apply: CT verifiers not yet scoped to CT keys \(plan §6.4 C1-MRI\): \.\.\/verify_facts, \.\.\/derive\/verify, \.\.\/findings\/verify/);
});

test("mri_ key filters are plain prefix tests (no LIKE with a backslash); every statement keeps to source ge_mri", () => {
  for (const f of ["run.js", "verify.js", "verify_sql.js", "load.js"]) {
    const src = fs.readFileSync(path.join(__dirname, "..", "findings", f), "utf8").replace(/^\s*\/\/.*$/gm, ""); // code, not comments
    assert.doesNotMatch(src, /LIKE '[^']*\\/, `${f}: LIKE with a backslash`);
    assert.doesNotMatch(src, /'ge_c[tv]'|cv_'|left\(finding_key, 3\)/, `${f}: names another source`);
  }
  assert.match(run.OTHERS_SQL, /source <> 'ge_mri'/);
  assert.match(run.OTHERS_SQL, /left\(finding_key, 4\) <> 'mri_'/);
  assert.match(run.COUNTS_SQL, /left\(finding_key, 4\) = 'mri_'/);
  const src = fs.readFileSync(path.join(__dirname, "..", "findings", "run.js"), "utf8");
  for (const m of src.match(/(DELETE FROM|UPDATE) insight\.findings[^"`]*/g)) assert.match(m, /source = 'ge_mri'/, m);
});

test("loader and verifier SQL read only MRI tables", () => {
  for (const s of [DAYS_SQL, DAILY_SQL, EVENTS_SQL, DEATHS_SQL, FINDINGS_SQL]) {
    assert.doesNotMatch(s, /ge_c[tv]_|\blog\.|\bapi\.|message\b/);
    assert.match(s, /insight\.ge_mri_(facts|daily)/);
  }
});

test("isolation: the findings modules load only MRI, shared db and CT's pure findings pieces", () => {
  const ok = new Set(["../../db", "../../findings/run", "../../findings/state", "../../findings/verify", "../../findings/rules",
    "../load", "../rules", "../codes_reviewed", "../derived_sql", "./context", "./rules", "./load", "./verify", "./verify_sql", "./run"]);
  for (const f of fs.readdirSync(path.join(__dirname, "..", "findings"))) {
    const src = fs.readFileSync(path.join(__dirname, "..", "findings", f), "utf8");
    for (const m of src.matchAll(/require\(\s*["'`]([^"'`]+)["'`]\s*\)/g)) assert.ok(ok.has(m[1]), `${f}: require(${m[1]})`);
  }
});

test("cli: findings / verify-findings arguments", () => {
  const { args } = require("../cli");
  assert.deepStrictEqual((({ cmd, rehearse, replay, system }) => ({ cmd, rehearse, replay, system }))(args(["findings", "--rehearse", "--replay", "--system", "SME00001"])),
    { cmd: "findings", rehearse: true, replay: true, system: "SME00001" });
  assert.throws(() => args(["findings"]), /exactly one/);
  assert.throws(() => args(["findings", "--rehearse", "--apply"]), /exactly one/);
  assert.throws(() => args(["findings", "--apply", "--full"]), /takes only/);
  assert.throws(() => args(["findings", "--apply", "--system"]), /needs a system id/);
  assert.throws(() => args(["verify-findings", "--apply"]), /no flags/);
  assert.throws(() => args(["derive", "--apply", "--replay"]), /only for findings/);
});

// ------------------------------------------------------------------ real data
test("fixture: the JS replay equals the independent SQL on real data (17 systems)", () => {
  const fx = JSON.parse(fs.readFileSync(path.join(FX, "inputs.json")));
  const ex = JSON.parse(fs.readFileSync(path.join(FX, "expected.json")));
  assert.strictEqual(fx.today, ex.today);
  assert.strictEqual(fx.systems.length, 17);
  const rows = fx.systems.map(expand).flatMap((s) => replay(s, fx.today));
  const c = compare_findings(ex.findings, rows);
  assert.deepStrictEqual({ missing: c.missing, extra: c.extra, differ: c.differ }, { missing: [], extra: [], differ: [] });
  const last = new Map(fx.systems.map((s) => [s.system_id, s.days[s.days.length - 1][0]]));
  assert.deepStrictEqual(invariants(rows.map((r) => ({ ...r, data_through_text: r.data_through })), last), []);
  for (const r of rows) {
    const e = JSON.stringify(r.evidence);
    assert.doesNotMatch(e, /[A-Za-z]{3,} [a-z]{3,} [a-z]{3,}/, "no message text in evidence");
    assert.doesNotMatch(e, /\d+\.\d+\.\d+\.\d+|[0-9A-F]{2}(:[0-9A-F]{2}){5}/i, "no IP / MAC");
  }
});

test("fixture: carries codes, dims, counts, process names and device times only", () => {
  const fx = JSON.parse(fs.readFileSync(path.join(FX, "inputs.json")));
  for (const s of fx.systems) {
    assert.match(s.system_id, /^SME\d{5}$/);
    for (const [day, m, dim, n, v] of s.daily) {
      assert.match(day, /^\d{4}-\d{2}-\d{2}$/);
      assert.match(m, /^[a-z_]+$/);
      assert.match(dim, /^(-?[0-9]+|[a-z0-9_]*)$/, `${m} ${dim}`);
      assert.ok(Number.isInteger(n) && n > 0 && (v === undefined || Number.isFinite(v)));
    }
    for (const [t, kind] of s.events) { assert.match(t, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/); assert.ok(["start", "stop", "up"].includes(kind)); }
    for (const [t, p] of s.deaths) { assert.match(t, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/); assert.match(p, /^[A-Za-z0-9_.:-]{2,40}$/); }
  }
});

test("fixture: the §9.2 list (as of 2026-11-16, 69 findings, 26 open)", () => {
  const fx = JSON.parse(fs.readFileSync(path.join(FX, "inputs.json")));
  const rows = fx.systems.map(expand).flatMap((s) => replay(s, fx.today));
  assert.strictEqual(fx.today, "2026-11-16");
  assert.deepStrictEqual([rows.length, rows.filter((r) => r.status === "open").length], [69, 26]);
  const per = {};
  for (const r of rows) per[r.finding_key] = (per[r.finding_key] || 0) + 1;
  assert.deepStrictEqual(per, { mri_coil_fault: 13, mri_cooling_fault: 7, mri_error_storm: 8, mri_failed_scans_high: 3, mri_image_quality_warning: 2,
    mri_pm_overdue: 9, mri_prescan_failures: 6, mri_process_crash_loop: 3, mri_table_fault: 10, mri_tps_reset_failures: 5, mri_unclean_restarts: 3 });
  const CURRENT = ["SME02582", "SME19647", "SME21284", "SME21914", "SME21920", "SME21932"];
  const open = rows.filter((r) => r.status === "open" && CURRENT.includes(r.system_id))
    .map((r) => `${r.system_id} ${r.finding_key} ${r.severity} ${r.evidence.opened_day}`).sort();
  assert.deepStrictEqual(open, [
    "SME02582 mri_image_quality_warning medium 2025-05-05",
    "SME02582 mri_prescan_failures medium 2026-11-11",
    "SME19647 mri_coil_fault high 2026-05-05",
    "SME19647 mri_table_fault medium 2026-05-06",
    "SME21284 mri_pm_overdue low 2026-05-05",
    "SME21914 mri_error_storm medium 2026-11-14",
    "SME21914 mri_process_crash_loop high 2026-02-09",
    "SME21914 mri_table_fault medium 2026-11-09",
  ]);
  const ep = (sys, key) => rows.filter((r) => r.system_id === sys && r.finding_key === key).map((r) => `${r.evidence.opened_day}..${r.evidence.resolved_day || "open"} ${r.severity}`);
  assert.deepStrictEqual(ep("SME21920", "mri_cooling_fault"), ["2026-05-19..2026-06-18 high", "2026-07-29..2026-08-27 high", "2026-09-02..2026-09-30 high"]);
  assert.deepStrictEqual(ep("SME21824", "mri_tps_reset_failures"), ["2026-07-17..2026-08-07 medium", "2026-08-10..2026-09-11 high"]);
  assert.deepStrictEqual(ep("SME21284", "mri_failed_scans_high"), ["2026-08-06..2026-08-31 medium"]);
  assert.deepStrictEqual(ep("SME21923", "mri_cooling_fault"), ["2026-05-05..open medium"]);
});
