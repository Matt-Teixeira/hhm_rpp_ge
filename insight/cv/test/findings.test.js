"use strict";
// node insight/cv/test/findings.test.js  (no DB needed)
// GE CV findings (PLAN-CV-INSIGHTS.md §10): the rules, CT's fold over them,
// the CV run's pure parts, and the real-data fixture against the
// independent SQL (tools/build_findings_fixtures.js).
const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const fs = require("fs");
const { build_context, baseline, top_of, dnum, dstr } = require("../findings/context");
const { cv_finding_rules, cv_catalog_rows, validate_cv_finding_rules, storm_day, ac_burst, STORM, DETECTOR, ANTICOLLISION, TABLE, PIB, QUIET_DAYS } = require("../findings/rules");
const { replay_system } = require("../../findings/state");
const { compare_findings } = require("../../findings/verify");
const { invariants } = require("../findings/verify");
const { FINDINGS_SQL } = require("../findings/verify_sql");
const { as_cv_rows, preflight, MIN_SCHEMA_VERSION_APPLY } = require("../findings/run");
const { DAYS_SQL, DAILY_SQL } = require("../findings/load");

const FX = path.join(__dirname, "..", "__fixtures__", "findings");
const rule = (k) => cv_finding_rules.find((r) => r.key === k);

// Synthetic system: `n` consecutive data days from 2026-01-01; cells(i) -> [{m, dim, n}]
function synth(n, cells, { gaps = [] } = {}) {
  const d0 = dnum("2026-01-01");
  const days = [], daily = [];
  for (let i = 0; i < n; i++) {
    if (gaps.includes(i)) continue;
    const day = dstr(d0 + i);
    days.push({ day, start_at: `${day}T08:00:00.000Z`, last_at: `${day}T20:00:00.000Z` });
    for (const c of cells(i)) daily.push({ day, ...c });
  }
  return { system_id: "SYN", days, daily };
}
const quiet = (i) => [{ m: "cv.error", dim: "100", n: 20 }];
const D = (i) => dnum("2026-01-01") + i;
const replay = (inp, today) => as_cv_rows(replay_system(build_context(inp, today), cv_finding_rules));

// ------------------------------------------------------------------ registry
test("registry: 5 cv_ windowed rules, internal, valid; catalog generated from it", () => {
  assert.deepStrictEqual(validate_cv_finding_rules(), []);
  assert.deepStrictEqual(cv_finding_rules.map((r) => r.key),
    ["cv_error_storm", "cv_detector_com_errors", "cv_anticollision_burst", "cv_table_encoder_fault", "cv_pib_com_loss"]);
  for (const r of cv_catalog_rows()) {
    assert.match(r.finding_key, /^cv_[a-z0-9_]+$/);
    assert.strictEqual(r.customer_visible, false);
    assert.strictEqual(r.category, "reliability");
  }
  for (const r of cv_finding_rules) assert.strictEqual(r.quiet_days, QUIET_DAYS);
  assert.ok(validate_cv_finding_rules([{ ...rule("cv_pib_com_loss"), key: "pib_loss" }]).some((e) => /start with cv_/.test(e)));
  assert.ok(validate_cv_finding_rules([{ ...rule("cv_pib_com_loss"), customer_visible: true }]).some((e) => /internal/.test(e)));
});

test("the independent SQL writes out the same thresholds as the registry", () => {
  const sql = FINDINGS_SQL.replace(/\s+/g, " ");
  for (const s of [`res_n >= ${STORM.min_baseline_days}`, `res >= ${STORM.min_residual}`, `res >= ${STORM.factor} * greatest(res_med, 1)`,
    `y.d BETWEEN x.d - ${STORM.baseline_days} AND x.d - 1`, `storm28 >= ${STORM.high_storm_days_28d}`, `dim = '${STORM.excluded_code}'`,
    `det >= ${DETECTOR.min_per_day}`, `det28 >= ${DETECTOR.high_days_28d}`,
    `ac >= ${ANTICOLLISION.min_per_day}`, `ac_n < ${ANTICOLLISION.min_baseline_days}`, `ac >= ${ANTICOLLISION.factor} * greatest(ac_med, 1)`,
    `tbl >= ${TABLE.min_per_day}`, `t5_7 >= ${TABLE.min_days_7d}`, `t5_28 >= ${TABLE.high_days_28d}`,
    `pib7 >= ${PIB.min_7d}`, `pibd7 >= ${PIB.high_days_7d}`, `${QUIET_DAYS} AS q`]) {
    assert.ok(sql.includes(s), s);
  }
  for (const m of STORM.excluded_metrics) assert.ok(sql.includes(`metric_key = '${m}'`), m);
});

// ------------------------------------------------------------------ context
test("context: residual excludes rows of rules 2-5 and 1200019; data after today and off-data-day cells ignored", () => {
  const inp = synth(3, (i) => [{ m: "cv.error", dim: "1200014", n: 100 }, { m: "cv.error", dim: "1200019", n: 30 }, { m: "cv.error", dim: "5", n: 7 },
    { m: "cv.detector_com_error", dim: "scanModeDm", n: 100 }, { m: "cv.positioner_collision", dim: "lift", n: 9 }]);
  inp.daily.push({ day: "2026-01-05", m: "cv.error", dim: "5", n: 999 }); // not a data day
  const ctx = build_context(inp, "2026-01-02");
  assert.strictEqual(ctx.days.length, 2);
  assert.strictEqual(ctx.series.err.get(D(0)), 137);
  assert.strictEqual(ctx.series.residual.get(D(0)), 7);
  assert.strictEqual(ctx.series.err.get(D(2)), 0, "after today");
  assert.strictEqual(ctx.series.err.get(dnum("2026-01-05")), 0);
  assert.deepStrictEqual(top_of(ctx.codes, D(0), D(1), 2), [{ k: "1200014", n: 200 }, { k: "1200019", n: 60 }]);
});

test("baseline: median of the data days in D-28..D-1, null below 7 of them", () => {
  const inp = synth(40, (i) => [{ m: "cv.error", dim: "1", n: i + 1 }], { gaps: [30, 31] });
  const ctx = build_context(inp, "2026-12-31");
  assert.strictEqual(baseline(ctx, "residual", D(6), 28, 7), null, "6 days before");
  assert.strictEqual(baseline(ctx, "residual", D(7), 28, 7), 4, "days 0..6 -> 1..7");
  assert.strictEqual(baseline(ctx, "residual", D(8), 28, 7), 4.5);
  // D(35): window D(7)..D(34) minus the two gap days = 26 values
  assert.strictEqual(baseline(ctx, "residual", D(35), 28, 7), 20.5);
});

// ------------------------------------------------------------------ rules
test("storm: >= 300 and >= 10x max(baseline, 1), needs a baseline; high with 3 storm days in 28", () => {
  const big = (v) => (i) => (i === 20 ? [{ m: "cv.error", dim: "9", n: v }] : quiet(i));
  assert.ok(storm_day(build_context(synth(30, big(300)), "2026-12-31"), D(20)));
  assert.ok(!storm_day(build_context(synth(30, big(299)), "2026-12-31"), D(20)));
  // baseline 40 -> needs 400
  const b40 = (v) => (i) => (i === 20 ? [{ m: "cv.error", dim: "9", n: v }] : [{ m: "cv.error", dim: "1", n: 40 }]);
  assert.ok(!storm_day(build_context(synth(30, b40(399)), "2026-12-31"), D(20)));
  assert.ok(storm_day(build_context(synth(30, b40(400)), "2026-12-31"), D(20)));
  // no baseline yet (day 5)
  assert.ok(!storm_day(build_context(synth(30, (i) => (i === 5 ? [{ m: "cv.error", dim: "9", n: 5000 }] : quiet(i))), "2026-12-31"), D(5)));
  // rows of the named findings and 1200019 don't count
  const named = (i) => (i === 20 ? [{ m: "cv.error", dim: "1200014", n: 900 }, { m: "cv.detector_com_error", dim: "x", n: 900 },
    { m: "cv.error", dim: "1200019", n: 400 }] : quiet(i));
  assert.ok(!storm_day(build_context(synth(30, named), "2026-12-31"), D(20)));
  // severity
  const three = (i) => ([12, 16, 20].includes(i) ? [{ m: "cv.error", dim: "9", n: 1000 }] : quiet(i));
  const r = rule("cv_error_storm").evaluate(build_context(synth(30, three), "2026-12-31"), D(20));
  assert.strictEqual(r.severity, "high");
  assert.strictEqual(r.observed, 1000);
  assert.deepStrictEqual(r.evidence.storm_days.map((x) => x.day), ["2026-01-17", "2026-01-21"]);
  assert.strictEqual(rule("cv_error_storm").evaluate(build_context(synth(30, big(500)), "2026-12-31"), D(20)).severity, "medium");
  assert.strictEqual(rule("cv_error_storm").evaluate(build_context(synth(30, big(500)), "2026-12-31"), D(27)), null, "outside the 7 days");
});

test("detector com: a day >= 50 in the last 7; high with 3 such days in 28", () => {
  const det = (days, v) => (i) => (days.includes(i) ? [{ m: "cv.detector_com_error", dim: "scanModeDm", n: v }, { m: "cv.error", dim: "1200014", n: v }] : quiet(i));
  const r = (inp, d) => rule("cv_detector_com_errors").evaluate(build_context(inp, "2026-12-31"), D(d));
  assert.strictEqual(r(synth(30, det([10], 49)), 10), null);
  assert.strictEqual(r(synth(30, det([10], 50)), 16).severity, "medium");
  assert.strictEqual(r(synth(30, det([10], 50)), 17), null);
  assert.strictEqual(r(synth(30, det([0, 10, 20], 60)), 20).severity, "high");
  assert.strictEqual(r(synth(30, det([0, 10, 24], 60)), 27).severity, "high", "days 0..27");
  assert.strictEqual(r(synth(30, det([0, 10, 24], 60)), 28).severity, "medium", "day 0 left the 28 days");
});

test("anticollision: >= 50 and >= 5x max(baseline, 1); the absolute threshold alone without a baseline", () => {
  const ac = (base, v, at) => (i) => [{ m: "cv.anticollision_error", dim: "pivot", n: i === at ? v : base }, { m: "cv.error", dim: "1050143", n: i === at ? v : base }];
  assert.ok(ac_burst(build_context(synth(30, ac(0, 50, 20)), "2026-12-31"), D(20)));
  assert.ok(!ac_burst(build_context(synth(30, ac(0, 49, 20)), "2026-12-31"), D(20)));
  assert.ok(!ac_burst(build_context(synth(30, ac(11, 54, 20)), "2026-12-31"), D(20)), "5 x 11 = 55");
  assert.ok(ac_burst(build_context(synth(30, ac(11, 55, 20)), "2026-12-31"), D(20)));
  assert.ok(ac_burst(build_context(synth(30, ac(30, 50, 3)), "2026-12-31"), D(3)), "no baseline at day 3");
  const r = rule("cv_anticollision_burst").evaluate(build_context(synth(30, ac(2, 80, 20)), "2026-12-31"), D(22));
  assert.deepStrictEqual([r.severity, r.observed, r.baseline], ["medium", 80, 2]);
});

test("table encoder: >= 5 on >= 2 days in 7; high with >= 10 such days in 28", () => {
  const tb = (days, v) => (i) => (days.includes(i) ? [{ m: "cv.table_encoder_failure", dim: "lateral", n: v }, { m: "cv.error", dim: "1050710", n: v }] : quiet(i));
  const r = (inp, d) => rule("cv_table_encoder_fault").evaluate(build_context(inp, "2026-12-31"), D(d));
  assert.strictEqual(r(synth(30, tb([10], 400)), 10), null);
  assert.strictEqual(r(synth(30, tb([10, 12], 4)), 12), null);
  const m = r(synth(30, tb([10, 12], 5)), 12);
  assert.deepStrictEqual([m.severity, m.observed], ["medium", 10]);
  assert.strictEqual(r(synth(30, tb([10, 17], 5)), 17), null, "7 days apart");
  assert.strictEqual(r(synth(30, tb([...Array(10).keys()].map((x) => x + 15), 5)), 24).severity, "high");
});

test("PIB: >= 3 in 7 days; high on >= 3 days", () => {
  const pb = (per) => (i) => (per[i] ? [{ m: "cv.pib_com_loss", dim: "reset", n: per[i] }, { m: "cv.error", dim: "1050024", n: per[i] }] : quiet(i));
  const r = (per, d) => rule("cv_pib_com_loss").evaluate(build_context(synth(30, pb(per)), "2026-12-31"), D(d));
  assert.strictEqual(r({ 10: 2 }, 10), null);
  assert.strictEqual(r({ 10: 3 }, 10).severity, "medium");
  assert.strictEqual(r({ 10: 1, 11: 1, 12: 1 }, 12).severity, "high");
  assert.strictEqual(r({ 10: 3 }, 17), null);
});

// ------------------------------------------------------------------ fold and run
test("CT's fold over CV rules: open, 14 evaluated quiet days, resolve; a later trip opens a new finding", () => {
  const det = (i) => ([10, 40].includes(i) ? [{ m: "cv.detector_com_error", dim: "x", n: 100 }, { m: "cv.error", dim: "1200014", n: 100 }] : quiet(i));
  const rows = replay(synth(60, det, { gaps: [20, 21] }), "2026-12-31").filter((r) => r.finding_key === "cv_detector_com_errors");
  assert.deepStrictEqual(rows.map((r) => [r.status, r.evidence.opened_day, r.evidence.last_trip_day, r.evidence.resolved_day, r.source]), [
    ["resolved", "2026-01-11", "2026-01-17", "2026-02-02", "ge_cv"], // last trip day 16 + 14 data days (20, 21 missing)
    ["open", "2026-02-10", "2026-02-16", null, "ge_cv"], // 13 data days after its last trip: still open
  ]);
  const later = replay(synth(61, det, { gaps: [20, 21] }), "2026-12-31").filter((r) => r.finding_key === "cv_detector_com_errors");
  assert.strictEqual(later[1].evidence.resolved_day, "2026-03-02", "resolves on the 14th");
  assert.strictEqual(rows[0].opened_at, "2026-01-11T08:00:00.000Z");
  assert.strictEqual(rows[0].window_start, "2026-01-11T08:00:00.000Z");
  assert.strictEqual(rows[0].window_end, "2026-01-18T08:00:00.000Z");
});

test("as-of purity: a replay as of an earlier day equals the full replay cut there", () => {
  const fx = JSON.parse(fs.readFileSync(path.join(FX, "inputs.json")));
  const s = fx.systems.find((x) => x.system_id === "SME02412");
  const early = replay(s, "2026-09-20");
  assert.ok(early.length > 0);
  const later = replay({ ...s, daily: [...s.daily, { day: "2026-09-21", m: "cv.detector_com_error", dim: "x", n: 1e6 }] }, "2026-09-20");
  assert.deepStrictEqual(later, early);
});

test("as_cv_rows: relabels the fold's rows as ge_cv and refuses a non-CV key", () => {
  assert.deepStrictEqual(as_cv_rows([{ finding_key: "cv_pib_com_loss", source: "ge_ct", x: 1 }]), [{ finding_key: "cv_pib_com_loss", source: "ge_cv", x: 1 }]);
  assert.throws(() => as_cv_rows([{ finding_key: "tube_replaced", source: "ge_ct" }]), /not a CV finding key/);
});

test("preflight refusals: limited user, schema version (008 for --apply), derive caught up, C1 for --apply", async () => {
  process.env.INSIGHT_PG_USER = "insight_writer";
  const fake = ({ user = "insight_writer", su = false, v = 8, derive = { s: "ok", p: {}, c: null }, inv = [] } = {}) => ({
    one: async (sql) => (/current_user/.test(sql) ? { u: user, su } : { v }),
    oneOrNone: async () => derive,
    any: async () => inv,
  });
  await assert.rejects(preflight(fake({ user: "avantehs_admin" }), { mode: "rehearse" }), /expected the limited/);
  await assert.rejects(preflight(fake({ su: true }), { mode: "rehearse" }), /expected the limited/);
  await assert.rejects(preflight(fake({ v: 6 }), { mode: "rehearse" }), /version 6 < 7/);
  await assert.rejects(preflight(fake({ v: 7 }), { mode: "apply" }), new RegExp(`version 7 < ${MIN_SCHEMA_VERSION_APPLY}.*C3`));
  await assert.rejects(preflight(fake({ derive: { s: "ok", p: { SME08640: ["2026-11-10"] }, c: null } }), { mode: "rehearse" }), /derive is not caught up/);
  await assert.rejects(preflight(fake({ derive: { s: "ok", p: {}, c: true } }), { mode: "rehearse" }), /code labels owed: true/);
  // review CV4-FINDINGS P2: no derive state, a failed derive, or facts / daily disagreeing must fail closed
  await assert.rejects(preflight(fake({ derive: null }), { mode: "rehearse" }), /no successful run on record \(status: no job state\)/);
  await assert.rejects(preflight(fake({ derive: { s: "error", p: null, c: null } }), { mode: "rehearse" }), /status: error/);
  await assert.rejects(preflight(fake({ inv: [{ system_id: "SME08640", day: "2026-11-09", kind: "facts_only" }, { system_id: "SME08640", day: "2026-11-10", kind: "facts_only" }] }), { mode: "rehearse" }),
    /disagree.*SME08640 facts_only: 2 days \(2026-11-09\.\.2026-11-10\)/);
  await assert.rejects(preflight(fake({ inv: [{ system_id: "SME02412", day: "2026-11-10", kind: "daily_only" }] }), { mode: "rehearse" }), /SME02412 daily_only: 1 days/);
  assert.deepStrictEqual(await preflight(fake({ v: 7 }), { mode: "rehearse" }), { user: "insight_writer", schema_version: 7 });
  // C1 is not done in this checkout (no CT verifier exports CV_AWARE yet)
  await assert.rejects(preflight(fake(), { mode: "apply" }), /C1/);
});

test("loader SQL reads only CV tables and the rule series", () => {
  for (const s of [DAYS_SQL, DAILY_SQL]) {
    assert.doesNotMatch(s, /ge_ct_|\blog\./);
    assert.match(s, /insight\.ge_cv_(facts|daily)/);
  }
  assert.doesNotMatch(FINDINGS_SQL, /ge_ct_|\blog\.|debugtext/);
});

test("cli: findings / verify-findings arguments", () => {
  const { args } = require("../cli");
  assert.deepStrictEqual((({ cmd, rehearse, replay, system }) => ({ cmd, rehearse, replay, system }))(args(["findings", "--rehearse", "--replay", "--system", "SME02412"])),
    { cmd: "findings", rehearse: true, replay: true, system: "SME02412" });
  assert.throws(() => args(["findings"]), /exactly one/);
  assert.throws(() => args(["findings", "--rehearse", "--apply"]), /exactly one/);
  assert.throws(() => args(["findings", "--apply", "--full"]), /takes only/);
  assert.throws(() => args(["findings", "--apply", "--system"]), /needs a system id/);
  assert.throws(() => args(["verify-findings", "--apply"]), /no flags/);
  assert.throws(() => args(["derive", "--apply", "--replay"]), /only for findings/);
});

// ------------------------------------------------------------------ real data
test("fixture: the JS replay equals the independent SQL on real data (both systems)", () => {
  const fx = JSON.parse(fs.readFileSync(path.join(FX, "inputs.json")));
  const ex = JSON.parse(fs.readFileSync(path.join(FX, "expected.json")));
  assert.strictEqual(fx.today, ex.today);
  const rows = fx.systems.flatMap((s) => replay(s, fx.today));
  const c = compare_findings(ex.findings, rows);
  assert.deepStrictEqual({ missing: c.missing, extra: c.extra, differ: c.differ }, { missing: [], extra: [], differ: [] });
  const last = new Map(fx.systems.map((s) => [s.system_id, s.days[s.days.length - 1].day]));
  assert.deepStrictEqual(invariants(rows.map((r) => ({ ...r, data_through_text: r.data_through })), last), []);
  for (const r of rows) assert.doesNotMatch(JSON.stringify(r.evidence), /[A-Za-z]{3,} [a-z]{3,} [a-z]{3,}/, "no debug text in evidence");
});

test("fixture: the §10.7 named cases", () => {
  const fx = JSON.parse(fs.readFileSync(path.join(FX, "inputs.json")));
  const rows = fx.systems.flatMap((s) => replay(s, fx.today));
  const got = rows.map((r) => `${r.system_id} ${r.finding_key} ${r.severity} ${r.evidence.opened_day} ${r.evidence.resolved_day || "open"}`).sort();
  assert.deepStrictEqual(got, [
    "SME02412 cv_anticollision_burst medium 2026-05-01 2026-06-19",
    "SME02412 cv_anticollision_burst medium 2026-09-12 2026-10-12",
    "SME02412 cv_anticollision_burst medium 2026-10-15 2026-11-06",
    "SME02412 cv_detector_com_errors high 2026-06-19 2026-08-01",
    "SME02412 cv_detector_com_errors high 2026-09-04 open",
    "SME02412 cv_detector_com_errors medium 2026-05-19 2026-06-11",
    "SME02412 cv_error_storm high 2026-09-11 2026-10-14",
    "SME02412 cv_pib_com_loss high 2026-09-11 2026-10-12",
    "SME02412 cv_table_encoder_fault high 2026-05-04 2026-06-18",
    "SME02412 cv_table_encoder_fault medium 2026-09-15 2026-10-12",
    "SME02412 cv_table_encoder_fault medium 2026-10-16 2026-11-06",
    "SME08640 cv_error_storm medium 2026-08-28 2026-09-17",
  ]);
});
