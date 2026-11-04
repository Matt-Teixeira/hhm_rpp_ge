"use strict";
// node insight/test/findings.test.js   (no DB needed)
// Findings registry, state machine and replay (PLAN-CT-INSIGHTS.md §14.2,
// §14.4). Real cases: insight/rules/__fixtures__/findings (built by
// insight/tools/build_findings_fixtures.js; expected findings from the
// independent SQL). Boundaries: synthetic systems below.
const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const fs = require("fs");
const { build_context, dnum, dstr } = require("../findings/context");
const { finding_rules, catalog_rows, validate_finding_rules } = require("../findings/rules");
const { replay_system, step } = require("../findings/state");
const { compare_findings, invariants } = require("../findings/verify");

const FIX = path.join(__dirname, "..", "rules", "__fixtures__", "findings");
const fx = JSON.parse(fs.readFileSync(path.join(FIX, "inputs.json"), "utf8"));
const expected = JSON.parse(fs.readFileSync(path.join(FIX, "expected.json"), "utf8"));

const expand = (c) => ({
  system_id: c.system_id,
  days: c.days.map(([day, start_at, last_at]) => ({ day, start_at, last_at })),
  daily: c.daily.map(([day, m, dim, n]) => ({ day, m, dim, n })),
  safe: c.safe.map(([t, day, code]) => ({ t, day, code })),
  boots: c.boots.map(([t, day, clean]) => ({ t, day, clean })),
  shutdowns: c.shutdowns.map(([t, day]) => ({ t, day })),
  service_enter: c.service_enter.map(([t, day]) => ({ t, day })),
  abort_codes: c.abort_codes.map(([day, code, n]) => ({ day, code, n })),
  replacements: c.replacements,
});
const replay = (s, today = fx.today) => replay_system(build_context(expand(fx.inputs[s]), today));
const all = Object.keys(fx.inputs).flatMap((s) => replay(s));
const of = (s, k) => all.filter((r) => r.system_id === s && r.finding_key === k);

// ------------------------------------------------------------ real cases

test("fixture replay equals the independent SQL exactly (76 findings, 13 systems)", () => {
  const c = compare_findings(expected.findings, all);
  assert.deepStrictEqual({ missing: c.missing, extra: c.extra, differ: c.differ }, { missing: [], extra: [], differ: [] });
  assert.strictEqual(all.length, expected.findings.length);
  const last = new Map(Object.entries(fx.inputs).map(([s, c]) => [s, c.days.filter((d) => d[0] <= fx.today).pop()[0]]));
  assert.deepStrictEqual(invariants(all.map((r) => ({ ...r, data_through_text: r.data_through })), last), []);
});

test("§14.4 named problems: SME21859 rotor (high), SME18531 restart loop, SME21867 chronic aborts", () => {
  const rotor = of("SME21859", "tube_rotor_instability");
  assert.strictEqual(rotor.length, 1);
  assert.strictEqual(rotor[0].severity, "high");
  assert.strictEqual(rotor[0].status, "open");
  assert.deepStrictEqual(rotor[0].evidence.first.variants, ["sustained"]); // high from its first trip
  assert.ok(rotor[0].evidence.opened_day <= "2026-05-17", rotor[0].evidence.opened_day); // data starts 04-27: needs 3 weeks
  const loop = of("SME18531", "process_restart_loop");
  assert.strictEqual(loop.length, 1);
  assert.strictEqual(loop[0].evidence.opened_day, "2026-09-12");
  assert.strictEqual(loop[0].status, "resolved");
  assert.strictEqual(loop[0].evidence.last_trip_day, "2026-09-14");
  assert.ok(loop[0].evidence.resolved_day > "2026-09-14");
  assert.strictEqual(loop[0].evidence.first.process, "device_eventlog");
  const ab = of("SME21867", "abort_rate_high");
  assert.ok(ab.some((r) => r.evidence.first.variants.includes("chronic") || r.evidence.last.variants.includes("chronic")));
  const codes = ab.flatMap((r) => r.evidence.last.top_ermes_28d.map((c) => c.code));
  assert.ok(codes.includes("260007391") || codes.includes("260101023"), codes.join(","));
});

test("§14.1 rotor spikes: SME18536 (two episodes) and SME01430, medium", () => {
  const a = of("SME18536", "tube_rotor_instability");
  assert.strictEqual(a.length, 2);
  assert.ok(a.every((r) => r.severity === "medium" && r.evidence.first.variants.includes("spike")));
  assert.ok(a[0].evidence.opened_day >= "2026-06-15" && a[0].evidence.opened_day <= "2026-06-21");
  assert.ok(a[1].evidence.opened_day >= "2026-08-10" && a[1].evidence.opened_day <= "2026-08-16");
  const b = of("SME01430", "tube_rotor_instability");
  assert.strictEqual(b.length, 1);
  assert.ok(b[0].evidence.opened_day >= "2026-07-06" && b[0].evidence.opened_day <= "2026-07-12");
  // rotor_not_at_speed is carried as evidence
  assert.ok("rotor_not_at_speed" in of("SME21859", "tube_rotor_instability")[0].evidence.last.weeks[0]);
});

test("§14.1 prep outliers SME21855, SME01429, SME16618 open; chronic environment open", () => {
  for (const s of ["SME21855", "SME01429", "SME16618"]) {
    const p = of(s, "prep_noncompliance");
    assert.ok(p.some((r) => r.status === "open" && r.severity === "low"), s);
  }
  for (const [s, k] of [["SME20608", "env_plenum"], ["SME20608", "env_psu"], ["SME01430", "env_plenum"], ["SME18531", "env_plenum"]]) {
    assert.ok(of(s, k).some((r) => r.status === "open" && r.severity === "medium"), `${s} ${k}`);
  }
  for (const s of ["SME21849", "SME21873", "SME15218"]) assert.ok(of(s, "air_calibration_overdue").length >= 1, s);
  assert.ok(of("SME01430", "powered_off_without_shutdown").length >= 1);
  assert.ok(of("SME01429", "powered_off_without_shutdown").length >= 1);
});

test("tube_replaced: one per replacement, opened on the install date, info / low (counter_only)", () => {
  const t = all.filter((r) => r.finding_key === "tube_replaced");
  assert.deepStrictEqual(t.map((r) => `${r.system_id} ${r.evidence.install_date} ${r.severity}`).sort(), [
    "SME15218 2026-05-28 info", "SME15218 2026-09-23 info", "SME16618 2026-06-03 info",
    "SME21873 2025-08-14 info", "SME21873 2025-09-02 low", "SME21873 2025-12-08 info", "SME21873 2026-01-28 info",
  ]);
  const first = t.find((r) => r.system_id === "SME21873" && r.evidence.install_date === "2025-08-14");
  assert.strictEqual(first.evidence.resolved_by, "next_replacement"); // 19 days later
  assert.strictEqual(first.evidence.resolved_day, "2025-09-02");
  assert.ok(t.every((r) => r.status === "resolved"));
});

test("a system that stopped sending keeps its open findings, data_through = its last day", () => {
  const s = all.filter((r) => r.system_id === "SME00875" && r.status === "open");
  assert.ok(s.length >= 1);
  assert.ok(s.every((r) => r.data_through === "2026-05-28"));
});

test("replay is deterministic and history-stable (as-of 2026-09-15 resolved rows unchanged by 11-04)", () => {
  const again = Object.keys(fx.inputs).flatMap((s) => replay(s));
  assert.strictEqual(JSON.stringify(again), JSON.stringify(all));
  const late = new Map(all.map((r) => [`${r.system_id}|${r.finding_key}|${r.opened_at}`, JSON.stringify(r)]));
  const early = Object.keys(fx.inputs).flatMap((s) => replay(s, "2026-09-15"));
  let resolved = 0;
  for (const r of early) {
    const k = `${r.system_id}|${r.finding_key}|${r.opened_at}`;
    assert.ok(late.has(k), `${k} vanished`);
    if (r.status === "resolved") { resolved++; assert.strictEqual(late.get(k), JSON.stringify(r), k); }
  }
  assert.ok(resolved > 10);
});

// ------------------------------------------------------- synthetic systems

// device day of an instant on a synthetic system (clock at UTC-5)
const local_day = (t) => new Date(Date.parse(t) - 5 * 3600000).toISOString().slice(0, 10);
// days: 'YYYY-MM-DD' list (data days); cells: [day, metric, dim, n]
function sys({ from = "2026-01-01", n = 120, skip = [], cells = [], safe = [], boots = [], shutdowns = [], service_enter = [], replacements = [] } = {}) {
  const days = [];
  for (let i = 0; i < n; i++) {
    const d = dstr(dnum(from) + i);
    if (!skip.includes(d)) days.push({ day: d, start_at: `${d}T05:00:00.000Z`, last_at: `${d}T20:00:00.000Z` });
  }
  return { system_id: "SYN", days, daily: cells.map(([day, m, dim, cnt]) => ({ day, m, dim: dim || "", n: cnt })), safe, boots, shutdowns,
    service_enter: service_enter.map((t) => ({ t, day: local_day(t) })), abort_codes: [], replacements };
}
const day = (i, from = "2026-01-01") => dstr(dnum(from) + i);
const rule = (k) => finding_rules.find((r) => r.key === k);
const rows = (inp, today, key) => replay_system(build_context(inp, today)).filter((r) => r.finding_key === key);

test("state machine: opens on a trip, resolves after quiet_days evaluated days, re-trip opens a new row", () => {
  const r = { quiet_days: 3 };
  const trip = { severity: "low", observed: 1, baseline: null, from: 0, evidence: {} };
  let st = null; const closed = [];
  const seq = [1, 0, 0, 1, 0, 0, 0, 1]; // trips on 0, 3 (within 3 -> same), 7 (4 after 3 -> resolved on 6, new on 7)
  seq.forEach((x, i) => { const o = step(r, st, i, 100 + i, x ? trip : null); st = o.st; if (o.closed) closed.push(o.closed); });
  assert.strictEqual(closed.length, 1);
  assert.strictEqual(closed[0].opened, 100);
  assert.strictEqual(closed[0].resolved, 106);
  assert.strictEqual(closed[0].trip_days, 2);
  assert.strictEqual(st.opened, 107);
});

test("state machine: severity rises while open, never falls", () => {
  const r = { quiet_days: 14 };
  const t = (severity) => ({ severity, observed: 1, baseline: null, from: 0, evidence: {} });
  let st = null;
  ["medium", "high", "medium"].forEach((s, i) => { st = step(r, st, i, i, t(s)).st; });
  assert.strictEqual(st.severity, "high");
  assert.deepStrictEqual(st.severity_history.map((h) => h.severity), ["medium", "high"]);
  assert.strictEqual(st.last.severity, "medium");
});

test("evaluated days are data days: a gap in the data does not count toward the quiet period", () => {
  // air overdue on days 0-2 trips on day 2; then 20 calendar days without data, then 14 data days
  const cells = [0, 1, 2].map((i) => [day(i), "calibration.air_overdue", "", 1]);
  const skip = []; for (let i = 3; i < 23; i++) skip.push(day(i));
  const inp = sys({ n: 60, skip, cells });
  const r = rows(inp, day(59), "air_calibration_overdue");
  assert.strictEqual(r.length, 1);
  // trips on days 2, 23, 24 (window still holds 3 days? no: window D-6..D; days 0-2 drop out by day 9) -> only day 2
  // quiet period: 14 evaluated days after day 2 = data days 23..36 -> resolves on day 36
  assert.strictEqual(r[0].evidence.last_trip_day, day(2));
  assert.strictEqual(r[0].evidence.resolved_day, day(36));
  assert.strictEqual(r[0].opened_at, `${day(2)}T05:00:00.000Z`);
  assert.strictEqual(r[0].resolved_at, `${day(36)}T05:00:00.000Z`);
  assert.strictEqual(r[0].data_through, day(36));
});

test("process_restart_loop: >= 50 for one process in a day; quiet period 7", () => {
  const inp = sys({ n: 40, cells: [[day(5), "process.restart", "pet_acq", 49], [day(10), "process.restart", "pet_acq", 30], [day(10), "process.restart", "device_eventlog", 50]] });
  const r = rows(inp, day(39), "process_restart_loop");
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].evidence.opened_day, day(10));
  assert.strictEqual(r[0].evidence.first.process, "device_eventlog");
  assert.strictEqual(r[0].evidence.resolved_day, day(17));
});

test("rotor: sustained = >= 5 in >= 3 of 4 weeks (high); spike needs >= 4 baseline weeks; median of an even count", () => {
  const T = 90;
  const wk = (k, n) => [day(T - 7 * k - 3), "tube.rotor_unexpected_stop", "", n]; // one day inside week k as of day T
  // sustained: weeks 0, 1, 3 >= 5 (week 2 = 4)
  let r = rule("tube_rotor_instability").evaluate(build_context(sys({ n: T + 1, cells: [wk(0, 5), wk(1, 6), wk(2, 4), wk(3, 5)] }), day(T)), dnum(day(T)));
  assert.strictEqual(r.severity, "high");
  // spike: baseline weeks 1..8 = 1,1,2,2,3,3,4,4 -> median 2.5; this week 5 = 2x -> trips (>=); 4 would not (< 5)
  const base = [1, 1, 2, 2, 3, 3, 4, 4].map((n, i) => wk(i + 1, n));
  r = rule("tube_rotor_instability").evaluate(build_context(sys({ n: T + 1, cells: [wk(0, 5), ...base] }), day(T)), dnum(day(T)));
  assert.strictEqual(r.severity, "medium");
  assert.strictEqual(r.baseline, 2.5);
  const hi = [6, 6, 6, 6, 6, 6, 6, 6].map((n, i) => wk(i + 1, n)); // median 6 -> 2x = 12; 11 not a spike, but sustained
  r = rule("tube_rotor_instability").evaluate(build_context(sys({ n: T + 1, cells: [wk(0, 11), ...hi] }), day(T)), dnum(day(T)));
  assert.deepStrictEqual(r.evidence.variants, ["sustained"]);
  // only 3 weeks of data before this week: no baseline, no spike
  const young = sys({ from: day(T - 27), n: 28, cells: [wk(0, 9)] });
  assert.strictEqual(rule("tube_rotor_instability").evaluate(build_context(young, day(T)), dnum(day(T))), null);
});

test("abort_rate_high: chronic >= 50/100 with >= 20 exams; spike needs a baseline with exams", () => {
  const T = 80, e = rule("abort_rate_high");
  const at = (cells) => e.evaluate(build_context(sys({ n: T + 1, cells }), day(T)), dnum(day(T)));
  // chronic boundary: 10 aborts / 20 exams in 28 days = 50 -> trips; 19 exams -> not
  assert.ok(at([[day(T - 20), "exam.start", "", 20], [day(T - 20), "scan.abort.system", "", 10]]));
  assert.strictEqual(at([[day(T - 20), "exam.start", "", 19], [day(T - 20), "scan.abort.system", "", 10]]), null);
  // spike: 3/10 in 7 days = 30, baseline 1/30 -> 3x 3.33 -> trips; no baseline exams -> no spike
  const spike = at([[day(T - 1), "exam.start", "", 10], [day(T - 1), "scan.abort.system", "", 3], [day(T - 30), "exam.start", "", 30], [day(T - 30), "scan.abort.system", "", 1]]);
  assert.deepStrictEqual(spike.evidence.variants, ["spike"]);
  assert.strictEqual(spike.observed, 30);
  assert.strictEqual(spike.baseline, 3.33);
  assert.strictEqual(at([[day(T - 1), "exam.start", "", 10], [day(T - 1), "scan.abort.system", "", 3]]), null);
});

test("safe_state_recurrent: same code >= 3 in 7 days; 260116316 and +-30 min of a boot/shutdown excluded", () => {
  const T = 30, k = rule("safe_state_recurrent");
  const s = (i, code, hh = "15:00") => ({ t: `${day(i)}T${hh}:00.000Z`, day: day(i), code, msg: "x" });
  const at = (safe, boots = [], shutdowns = []) => k.evaluate(build_context(sys({ n: T + 1, safe, boots, shutdowns }), day(T)), dnum(day(T)));
  assert.ok(at([s(T, "1"), s(T - 2, "1"), s(T - 6, "1")]));
  assert.strictEqual(at([s(T, "1"), s(T - 2, "1"), s(T - 7, "1")]), null); // outside the window
  assert.strictEqual(at([s(T, "1"), s(T - 2, "1"), s(T - 3, "2")]), null); // different codes
  assert.strictEqual(at([s(T, "260116316"), s(T - 1, "260116316"), s(T - 2, "260116316")]), null);
  const boot = [{ t: `${day(T)}T15:30:00.000Z`, day: day(T), clean: true }];
  assert.strictEqual(at([s(T, "1"), s(T - 2, "1"), s(T - 6, "1")], boot), null); // 30 min before a boot
  assert.ok(at([s(T, "1", "14:59"), s(T - 2, "1"), s(T - 6, "1")], boot)); // 31 min
  assert.strictEqual(at([s(T, "1"), s(T - 2, "1"), s(T - 6, "1")], [], [{ t: `${day(T)}T14:31:00.000Z`, day: day(T) }]), null); // 29 min after a shutdown
  // as of D, a boot on a later device day doesn't exclude (review PHASE4-RULES F2)
  const late = { t: `${day(T)}T04:50:00.000Z`, day: day(T - 1), code: "1" }; // 23:50 local on T-1
  const nextDayBoot = [{ t: `${day(T)}T05:10:00.000Z`, day: day(T), clean: true }]; // 00:10 local on T, 20 min later
  const k2 = (today) => k.evaluate(build_context(sys({ n: T + 1, safe: [late, s(T - 3, "1"), s(T - 6, "1")], boots: nextDayBoot }), day(today)), dnum(day(today)));
  assert.ok(k2(T - 1), "boot after the as-of day must not exclude");
  assert.strictEqual(k2(T), null); // as of T the boot is in, and excludes it
});

test("evidence carries no raw message text (review PHASE4-RULES F1)", () => {
  for (const r of all.filter((x) => x.finding_key === "safe_state_recurrent")) {
    for (const c of [...r.evidence.first.codes, ...r.evidence.last.codes, ...r.evidence.last.other_codes]) assert.deepStrictEqual(Object.keys(c).sort(), ["code", "n"]);
  }
  assert.ok(all.some((x) => x.finding_key === "safe_state_recurrent"));
});

test("powered_off_without_shutdown: >= 3 unclean boots in 7 days, service mode in the 12 h before excludes", () => {
  const T = 20, k = rule("powered_off_without_shutdown");
  const b = (i, clean = false) => ({ t: `${day(i)}T12:00:00.000Z`, day: day(i), clean });
  const at = (boots, service_enter = []) => k.evaluate(build_context(sys({ n: T + 1, boots, service_enter }), day(T)), dnum(day(T)));
  assert.ok(at([b(T), b(T - 3), b(T - 6)]));
  assert.strictEqual(at([b(T), b(T - 3), b(T - 6, true)]), null);
  assert.strictEqual(at([b(T), b(T - 3), b(T - 6)], [`${day(T)}T00:00:00.000Z`]), null); // 12 h before
  assert.ok(at([b(T), b(T - 3), b(T - 6)], [`${day(T - 1)}T23:59:00.000Z`])); // 12 h 1 min before
});

test("prep_noncompliance: > 50% of >= 5 scan days without Fast Cal (14 days)", () => {
  const T = 30, k = rule("prep_noncompliance");
  const scan = (i) => [day(i), "exam.start", "", 3];
  const fc = (i, step = "Fast Calibration") => [day(i), "prep.tube_temp", step, 1];
  const at = (cells) => k.evaluate(build_context(sys({ n: T + 1, cells }), day(T)), dnum(day(T)));
  // 6 scan days, 3 without -> 50% -> no trip; 4 without -> trips
  assert.strictEqual(at([0, 1, 2, 3, 4, 5].map((i) => scan(T - i)).concat([fc(T), fc(T - 1), fc(T - 2, "Cold Tube Warmup (Fast Calibration)")])), null);
  assert.ok(at([0, 1, 2, 3, 4, 5].map((i) => scan(T - i)).concat([fc(T), fc(T - 1)])));
  // 'Cold Tube Warmup' alone is not Fast Cal; 4 scan days are too few
  assert.ok(at([0, 1, 2, 3, 4].map((i) => scan(T - i)).concat([0, 1, 2, 3, 4].map((i) => fc(T - i, "Cold Tube Warmup")))));
  assert.strictEqual(at([0, 1, 2, 3].map((i) => scan(T - i))), null);
});

test("warmup_bypass_habit: >= 50% of scan days in 28 days", () => {
  const T = 40, k = rule("warmup_bypass_habit");
  const at = (cells) => k.evaluate(build_context(sys({ n: T + 1, cells }), day(T)), dnum(day(T)));
  const scans = [0, 1, 2, 3].map((i) => [day(T - i), "exam.start", "", 1]);
  assert.ok(at([...scans, [day(T), "op.warmup_skipped", "", 1], [day(T - 1), "op.scan_in_warmup_zone", "", 2]]));
  assert.strictEqual(at([...scans, [day(T), "op.warmup_skipped", "", 1]]), null);
  assert.strictEqual(at(scans), null); // never logged it
});

test("env: >= 3 of the last 7 days per family; PSU joins temperature and voltage", () => {
  const T = 20;
  const at = (k, cells) => rule(k).evaluate(build_context(sys({ n: T + 1, cells }), day(T)), dnum(day(T)));
  assert.ok(at("env_psu", [[day(T), "env.psu_temp_out_of_spec", "", 1], [day(T - 1), "env.psu_voltage_out_of_spec", "", 1], [day(T - 6), "env.psu_temp_out_of_spec", "", 4]]));
  assert.strictEqual(at("env_plenum", [[day(T), "env.plenum_temp", "", 9], [day(T - 7), "env.plenum_temp", "", 1], [day(T - 1), "env.plenum_recovered", "", 1]]), null);
});

test("tube_replaced: resolves on the first data day >= install + 30, or at the next install", () => {
  const rep = (i, conf = "confirmed") => ({ t: `${day(i + 2)}T10:00:00.000Z`, day: day(i + 2), install_date: day(i), confidence: conf, old_mas: 5, tube_source: null, calibrations: 3 });
  const skip = [day(40), day(41)];
  const r = rows(sys({ n: 120, skip, replacements: [rep(10), rep(70, "counter_only"), rep(80)] }), day(119), "tube_replaced");
  assert.deepStrictEqual(r.map((x) => [x.evidence.opened_day, x.severity, x.evidence.resolved_day, x.evidence.resolved_by]), [
    [day(10), "info", day(42), "open_days"], // day 40 has no data
    [day(70), "low", day(80), "next_replacement"],
    [day(80), "info", day(110), "open_days"],
  ]);
  // a replacement not yet detected as of today is not there
  assert.strictEqual(rows(sys({ n: 120, replacements: [rep(10)] }), day(11), "tube_replaced").length, 0);
});

test("tube_replaced opens on a data day: the first one on or after the install date (review PHASE4-RULES F3)", () => {
  const rep = (inst, reset) => ({ t: `${day(reset)}T10:00:00.000Z`, day: day(reset), install_date: day(inst), confidence: "confirmed", old_mas: 5, tube_source: null, calibrations: 1 });
  const r = rows(sys({ n: 120, skip: [day(10), day(11)], replacements: [rep(10, 13)] }), day(119), "tube_replaced");
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].evidence.opened_day, day(12));
  assert.strictEqual(r[0].evidence.install_date, day(10));
  assert.strictEqual(r[0].opened_at, `${day(12)}T05:00:00.000Z`);
  assert.strictEqual(r[0].evidence.resolved_day, day(40)); // install + 30
  // install day after today (clock ahead): not shown until a data day reaches it
  assert.strictEqual(rows(sys({ n: 20, replacements: [rep(15, 14)] }), day(14), "tube_replaced").length, 0);
  // two replacements opening on the same data day: the later install wins
  const two = rows(sys({ n: 120, skip: [day(10), day(11)], replacements: [rep(10, 13), rep(11, 14)] }), day(119), "tube_replaced");
  assert.deepStrictEqual(two.map((x) => x.evidence.install_date), [day(11)]);
});

test("as of today: device days after today (clock ahead) are ignored", () => {
  const cells = [0, 1, 2].map((i) => [day(50 + i), "calibration.air_overdue", "", 1]);
  assert.strictEqual(rows(sys({ n: 60, cells }), day(51), "air_calibration_overdue").length, 0);
  assert.strictEqual(rows(sys({ n: 60, cells }), day(52), "air_calibration_overdue").length, 1);
});

test("registry: 13 findings, valid, catalog rows fit migration 005's checks", () => {
  assert.deepStrictEqual(validate_finding_rules(), []);
  const cat = catalog_rows();
  assert.strictEqual(cat.length, 13);
  for (const c of cat) {
    assert.match(c.finding_key, /^[a-z][a-z0-9_]*$/);
    assert.ok(["info", "low", "medium", "high"].includes(c.default_severity));
    assert.ok(c.label && c.description);
  }
  assert.deepStrictEqual(cat.map((c) => c.finding_key), ["tube_rotor_instability", "process_restart_loop", "abort_rate_high",
    "safe_state_recurrent", "prep_noncompliance", "tube_replaced", "env_plenum", "env_detector_temp", "env_humidity", "env_psu",
    "warmup_bypass_habit", "powered_off_without_shutdown", "air_calibration_overdue"]);
});

test("verify comparator catches a changed resolved_at, severity, observed and a dropped row", () => {
  const exp = expected.findings;
  const mut = (f) => { const a = JSON.parse(JSON.stringify(all)); f(a); return compare_findings(exp, a); };
  const res = all.findIndex((r) => r.status === "resolved");
  assert.strictEqual(mut((a) => { a[res].resolved_at = null; }).differ.length, 1);
  assert.strictEqual(mut((a) => { a[0].severity = "info"; }).differ.length, 1);
  assert.strictEqual(mut((a) => { a[1].observed += 0.01; }).differ.length, 1);
  assert.strictEqual(mut((a) => { a.pop(); }).missing.length, 1);
});
