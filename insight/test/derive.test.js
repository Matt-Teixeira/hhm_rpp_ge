"use strict";
// node insight/test/derive.test.js   (no DB needed)
// Pure parts of insight/derive (PLAN-CT-INSIGHTS.md §13.2, §13.4 step 3).
const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const fs = require("fs");
const { dim_of, dim_sql, day_bounds, unlisted_dim_metrics, DIM_SOURCE, AGG_SELECT } = require("../derive/daily");
const { build_exams, anchor_for } = require("../derive/exams");
const { build_segments } = require("../derive/tube_segments");
const { classify_clock } = require("../derive/clock");
const { scope_full, scope_touched, add_days } = require("../derive/common");
const { UPSERT_SUFFIX, DELETE_STALE_SQL } = require("../derive/derived_facts");

let seq = 0;
const fact = (metric_key, iso, o = {}) => {
  const ms = Date.parse(iso);
  return { system_id: "SME1", metric_key, host_datetime: new Date(iso), host_local: new Date(ms - 5 * 3600000).toISOString().slice(0, 19),
    value_num: null, value_text: null, exam_no: null, attrs: null, epoch: Math.floor(ms / 1000), record_number_concurrent: 0,
    source_id: ++seq, source_capture_datetime: new Date(iso), ...o };
};

// ------------------------------------------------------------------ daily

test("daily dim: per-metric breakdown as agreed (§13.2 item 3)", () => {
  assert.strictEqual(dim_of({ metric_key: "error.ermes", value_num: 260116316 }), "260116316");
  assert.strictEqual(dim_of({ metric_key: "prep.tube_temp", value_text: "Fast Cal" }), "Fast Cal");
  assert.strictEqual(dim_of({ metric_key: "service.calibration", value_text: "Air" }), "Air");
  assert.strictEqual(dim_of({ metric_key: "process.restart", value_text: "device_eventlog" }), "device_eventlog");
  assert.strictEqual(dim_of({ metric_key: "xfer.dicom_sent", value_text: "AIDOC" }), "AIDOC");
  assert.strictEqual(dim_of({ metric_key: "ipc.event_router_send_failed", attrs: { status: "TIMEOUT" } }), "TIMEOUT");
  assert.strictEqual(dim_of({ metric_key: "ipc.sigpipe", value_text: "environmentMgr" }), "");
  assert.strictEqual(dim_of({ metric_key: "tube.mas_total", value_num: 5 }), "");
  assert.strictEqual(dim_of({ metric_key: "prep.tube_temp", value_text: null }), "");
  // every xfer.* / ipc.* per-row metric has an explicit entry
  assert.deepStrictEqual(unlisted_dim_metrics(), []);
  const sql = dim_sql();
  for (const k of Object.keys(DIM_SOURCE)) assert.ok(sql.includes(`WHEN '${k}' THEN`), k);
  assert.match(sql, /ELSE '' END$/);
});

test("daily aggregate: exact numeric sum and a deterministic last", () => {
  const q = AGG_SELECT("true");
  assert.match(q, /sum\(f\.value_num::numeric\)::double precision AS value_sum/);
  assert.match(q, /array_agg\(f\.value_num ORDER BY f\.host_datetime DESC, f\.epoch DESC, f\.record_number_concurrent DESC\)\)\[1\] AS value_last/);
  assert.match(q, /f\.host_local::date AS local_day/);
  assert.deepStrictEqual(day_bounds(new Set(["2026-11-03", "2026-11-01"])),
    { lo: "2026-10-30T00:00:00.000Z", hi: "2026-11-06T00:00:00.000Z", days: ["2026-11-01", "2026-11-03"] });
});

// ------------------------------------------------------------------ exams

const start = (iso, exam, o = {}) => fact("exam.start", iso, { exam_no: exam, value_text: `P-${exam}`, ...o });
const series = (iso, s, sc, im, o = {}) => fact("exam.series", iso, { value_num: im, attrs: { ct_series: s, ct_scans: sc, ct_images: im }, ...o });
const abortOp = (iso) => fact("scan.abort.operator", iso);
const abortSys = (iso) => fact("scan.abort.system", iso);

test("exams: window to the next start, last series wins, aborts per window, reopened", () => {
  const starts = [start("2026-03-01T13:00:00Z", "100"), start("2026-03-01T14:00:00Z", "101"), start("2026-03-01T15:00:00Z", "100")];
  const events = [
    series("2026-03-01T12:50:00Z", 9, 9, 9),                                         // before any start: ignored
    abortOp("2026-03-01T13:05:00Z"), series("2026-03-01T13:10:00Z", 2, 3, 100), series("2026-03-01T13:20:00Z", 3, 4, 150),
    abortSys("2026-03-01T14:30:00Z"), abortSys("2026-03-01T14:31:00Z"),            // exam 101: no series
    series("2026-03-01T15:11:00Z", 1, 1, 40), abortOp("2026-03-01T18:00:00Z"),     // last exam: open window
  ];
  const rows = build_exams(starts, events);
  assert.deepStrictEqual(rows.map((r) => [r.exam_no, r.series, r.scans, r.images, r.aborts_operator, r.aborts_system, r.attrs.reopened, r.attrs.series_summaries]), [
    ["100", 3, 4, 150, 1, 0, false, 2],
    ["101", 0, 0, 0, 0, 2, false, 0],
    ["100", 1, 1, 40, 1, 0, true, 1],
  ]);
  assert.strictEqual(rows[0].last_activity_at.toISOString(), "2026-03-01T13:20:00.000Z");
  assert.strictEqual(rows[1].last_activity_at.toISOString(), "2026-03-01T14:31:00.000Z");
  assert.strictEqual(rows[2].last_activity_at.toISOString(), "2026-03-01T18:00:00.000Z");
  assert.strictEqual(rows[0].local_day, "2026-03-01");
  assert.strictEqual(rows[0].protocol, "P-100");
  assert.ok(rows.every((r) => r.last_activity_at >= r.started_at));
});

test("exams: same-second events split by record order; local_day from the device clock", () => {
  const s1 = start("2026-03-02T04:00:00Z", "200", { record_number_concurrent: 0 });       // device day 03-01 (23:00)
  const s2 = start("2026-03-02T04:30:00Z", "201", { record_number_concurrent: 1 });
  const evBefore = series("2026-03-02T04:30:00Z", 5, 5, 50, { record_number_concurrent: 0 }); // same second as s2, earlier record
  const evAfter = series("2026-03-02T04:30:00Z", 1, 1, 10, { record_number_concurrent: 2 });
  const rows = build_exams([s2, s1], [evAfter, evBefore]);
  assert.deepStrictEqual(rows.map((r) => [r.exam_no, r.images, r.local_day]), [["200", 50, "2026-03-01"], ["201", 10, "2026-03-01"]]);
});

test("exams: an incremental rebuild from the anchor equals the full rebuild for those exams", () => {
  const starts = [], events = [];
  for (let d = 1; d <= 6; d++) {
    for (let h = 0; h < 3; h++) {
      const iso = `2026-04-0${d}T${13 + 2 * h}:00:00Z`;
      starts.push(start(iso, String(1000 + d * 10 + (h === 2 && d === 5 ? 0 : h)))); // one reopened exam on day 5
      events.push(series(`2026-04-0${d}T${13 + 2 * h}:15:00Z`, h + 1, h + 2, 10 * d + h));
      if (h === 1) events.push(abortOp(`2026-04-0${d}T${13 + 2 * h}:20:00Z`));
    }
  }
  const full = build_exams(starts, events);
  const anchor = anchor_for(starts, new Set(["2026-04-05", "2026-04-04"]));
  assert.strictEqual(anchor.exam_no, "1032");                                   // last start on device day 04-03
  const since = events.filter((e) => e.host_datetime >= anchor.host_datetime);
  const inc = build_exams(starts, since, anchor);
  assert.deepStrictEqual(inc, full.filter((r) => r.started_at >= anchor.host_datetime));
  assert.strictEqual(full.filter((r) => r.attrs.reopened).length, 1);
  assert.strictEqual(inc.filter((r) => r.attrs.reopened).length, 1);             // reopened uses ALL starts
  assert.strictEqual(anchor_for(starts, new Set(["2026-04-01"])), null);         // nothing earlier: rebuild all
});

// ---------------------------------------------------------- tube segments

const FIX = path.join(__dirname, "..", "rules", "__fixtures__", "ge_ct_derived");
const tubeFacts = (sys) => JSON.parse(fs.readFileSync(path.join(FIX, "tube.json"), "utf8"))[sys].map((f, i) => ({
  system_id: sys, metric_key: f.m, host_datetime: new Date(f.t), host_local: f.l, value_num: f.v === undefined ? null : f.v,
  value_text: f.x === undefined ? null : f.x, epoch: f.e, record_number_concurrent: f.r, source_id: 1000 + i, source_capture_datetime: new Date(f.t),
}));

test("tube segments from real facts: initial + one per replacement, consistent with tube.replacement", () => {
  const f = tubeFacts("SME21873");
  const segs = build_segments(f);
  assert.deepStrictEqual(segs.map((s) => [s.install_confidence, s.install_date, s.tube_source, s.ended_reason]), [
    ["initial", null, "verified", "replacement"],
    ["confirmed", "2025-08-14", "verified", "replacement"],
    ["counter_only", "2025-09-02", "verified", "replacement"],
    ["confirmed", "2025-12-08", "unrecognized", "replacement"],
    ["confirmed", "2026-01-28", "unrecognized", null],
  ]);
  const readings = f.filter((x) => x.metric_key === "tube.mas_total").length;
  assert.strictEqual(segs.reduce((n, s) => n + s.readings, 0), readings);         // every reading in exactly one segment
  assert.strictEqual(segs.filter((s) => s.segment_end === null).length, 1);
  for (let k = 1; k < segs.length; k++) {
    assert.ok(segs[k - 1].segment_end < segs[k].segment_start, `segment ${k} starts after the previous ends`);
    assert.strictEqual(segs[k].start_mas, 0);
    assert.strictEqual(segs[k].evidence.old_mas, segs[k - 1].latest_mas);         // old tube life = previous segment's last reading
  }
  assert.strictEqual(segs[1].evidence.old_mas, 34074680);
  assert.ok(segs[4].mas_per_day > 0);
  // a system without resets: one initial, current segment
  const one = build_segments(tubeFacts("SME21859"));
  assert.strictEqual(one.length, 1);
  assert.deepStrictEqual([one[0].install_confidence, one[0].segment_end, one[0].ended_reason], ["initial", null, null]);
});

test("tube segments: a trailing pending reset is kept out of the current segment", () => {
  const r = (iso, v) => fact("tube.mas_total", iso, { value_num: v });
  const facts = [r("2026-01-01T12:00:00Z", 4e6), r("2026-01-03T12:00:00Z", 4.1e6), r("2026-01-05T12:00:00Z", 4.2e6), r("2026-01-07T12:00:00Z", 0)];
  const segs = build_segments(facts);
  assert.strictEqual(segs.length, 1);
  assert.strictEqual(segs[0].latest_mas, 4.2e6);
  assert.strictEqual(segs[0].readings, 3);
  assert.deepStrictEqual(segs[0].evidence.pending_reset, { at: "2026-01-07T12:00:00.000Z", value: 0, prior: 4.2e6 });
  assert.strictEqual(segs[0].mas_per_day, (4.2e6 - 4e6) / 4);
  // no readings: no segments
  assert.deepStrictEqual(build_segments([]), []);
});

// ------------------------------------------------------------------ clock

test("clock flags match §13.1 (values from the 2026-11-04 read-only lag query)", () => {
  const c = (p10_lag, min_lag, captures = 100) => classify_clock({ p10_lag, min_lag, captures });
  assert.deepStrictEqual(c(-40.9, -51.2), { flag: "ahead", est_offset_min: 40.9 });  // SME16618
  assert.deepStrictEqual(c(-30.5, -40.2), { flag: "ahead", est_offset_min: 30.5 });  // SME21873
  assert.deepStrictEqual(c(-4.3, -13.8), { flag: "ahead", est_offset_min: 4.3 });    // SME21929
  assert.deepStrictEqual(c(-275.8, -278.4, 14), { flag: "ahead", est_offset_min: 275.8 }); // SME11229, few captures
  assert.deepStrictEqual(c(13.5, -46.0), { flag: "jumps", est_offset_min: 0 });     // SME20594 one-off
  assert.deepStrictEqual(c(39.0, -10.6), { flag: "jumps", est_offset_min: 0 });     // SME18536
  assert.deepStrictEqual(c(53.3, 42.8), { flag: "lagging", est_offset_min: 0 });    // SME21854
  assert.deepStrictEqual(c(17.8, 7.6), { flag: "ok", est_offset_min: 0 });
  assert.deepStrictEqual(c(10, -5), { flag: "ok", est_offset_min: 0 });             // -5 is not below -5
  assert.deepStrictEqual(c(45, 1), { flag: "ok", est_offset_min: 0 });              // 45 is not above 45
  assert.strictEqual(c(-50, -60, 4), null);                                          // too few captures: no row
});

// ------------------------------------------------------- scope + writes

test("scope helpers and derived-fact write statements", () => {
  const full = scope_full(["A", "B"]);
  add_days(full, "A", ["2026-01-01"]);
  assert.deepStrictEqual(full.get("A"), { full: true });
  const tch = scope_touched([{ system_id: "A", day: "2026-01-02" }, { system_id: "A", day: "2026-01-03" }, { system_id: "B", day: "2026-01-02" }]);
  add_days(tch, "A", ["2026-01-01", "2026-01-02"]);
  add_days(tch, "C", ["2026-01-01"]);                                               // not in scope: ignored
  assert.deepStrictEqual([...tch.get("A").days].sort(), ["2026-01-01", "2026-01-02", "2026-01-03"]);
  assert.strictEqual(tch.has("C"), false);
  // idempotent upsert: update only when something differs; report inserted vs updated
  assert.match(UPSERT_SUFFIX, /ON CONFLICT ON CONSTRAINT ge_ct_facts_natural_key DO UPDATE SET/);
  assert.match(UPSERT_SUFFIX, /IS DISTINCT FROM/);
  assert.match(UPSERT_SUFFIX, /RETURNING epoch, record_number_concurrent, metric_key, host_datetime/);
  assert.ok(!/xmax/.test(UPSERT_SUFFIX.split("RETURNING")[1]), "no system columns in RETURNING (partitioned table)");
  // stale delete is limited to the system and the derived metrics
  assert.match(DELETE_STALE_SQL, /WHERE system_id = \$1 AND metric_key = ANY\(\$2\)/);
  assert.match(DELETE_STALE_SQL, /NOT IN\s+\(SELECT \* FROM unnest\(/);
});

// ------------------------------------------- review PHASE3-DERIVE-STAGES fixes

test("F1: touched daily bounds cover any zone offset; a new fact breaking the invariant forces a full rebuild", () => {
  const { MAX_OFFSET_H, OFFSET_BREAKS_SQL } = require("../derive/daily");
  const { scope_from_touched_rows } = require("../derive/index");
  // host_datetime = device wall clock + offset, offset within +/- MAX_OFFSET_H: always inside the scan bounds
  const { lo, hi } = day_bounds(new Set(["2026-05-10", "2026-05-12"]));
  for (const [local, offH] of [["2026-05-10T00:00:00", MAX_OFFSET_H], ["2026-05-10T00:00:00", -MAX_OFFSET_H],
    ["2026-05-12T23:59:59", MAX_OFFSET_H], ["2026-05-12T23:59:59", -MAX_OFFSET_H]]) {
    const hd = Date.parse(`${local}Z`) + offH * 3600000;
    assert.ok(hd >= Date.parse(lo) && hd < Date.parse(hi), `${local} ${offH}h`);
  }
  assert.match(OFFSET_BREAKS_SQL, /abs\(extract\(epoch FROM f\.host_datetime - \(f\.host_local AT TIME ZONE 'UTC'\)\)\) > 14 \* 3600/);
  const scope = scope_from_touched_rows([
    { system_id: "A", day: "2026-05-10", offset_breaks: false },
    { system_id: "B", day: "2026-05-10", offset_breaks: false },
    { system_id: "B", day: "2026-05-11", offset_breaks: true },
  ]);
  assert.deepStrictEqual([...scope.get("A").days], ["2026-05-10"]);
  assert.deepStrictEqual(scope.get("B"), { full: true });
});

test("F2: derived-fact changed days include the OLD day of an updated fact; inserted vs updated from the prior keys", () => {
  const { classify_upserts } = require("../derive/derived_facts");
  const changed_days = (e, u, d) => classify_upserts(e, u, d).days;
  const k = { epoch: 1, record_number_concurrent: 0, metric_key: "system.boot", host_datetime: new Date("2026-05-10T03:00:00Z") };
  const k2 = { ...k, epoch: 2, host_datetime: new Date("2026-05-12T03:00:00Z") };
  const existing = [{ ...k, day: "2026-05-09" }, { ...k2, day: "2026-05-11" }];
  // k updated and moved 05-09 -> 05-10; a new fact inserted on 05-13; one stale fact deleted on 05-01; k2 unchanged (not returned)
  const days = changed_days(existing,
    [{ ...k, inserted: false, day: "2026-05-10" }, { ...k, epoch: 3, inserted: true, day: "2026-05-13" }],
    [{ day: "2026-05-01" }]);
  assert.deepStrictEqual([...days].sort(), ["2026-05-01", "2026-05-09", "2026-05-10", "2026-05-13"]);
  const c = classify_upserts(existing, [{ ...k, day: "2026-05-10" }, { ...k, epoch: 3, day: "2026-05-13" }], []);
  assert.deepStrictEqual([c.inserted, c.updated], [1, 1]);
  // key matching tolerates host_datetime as a Date or an ISO string
  assert.deepStrictEqual([...changed_days([{ ...k, day: "2026-05-09" }], [{ ...k, host_datetime: "2026-05-10T03:00:00.000Z", inserted: false, day: "2026-05-10" }], [])].sort(),
    ["2026-05-09", "2026-05-10"]);
});

test("verify-derive acceptance lists match the derived rules on the §13.1 fixtures", () => {
  const { EXPECTED_REPLACEMENTS, EXPECTED_CLOCK_AHEAD } = require("../derive/verify");
  const d = require("../rules/ge_ct_derived");
  const tube = JSON.parse(fs.readFileSync(path.join(FIX, "tube.json"), "utf8"));
  const got = [];
  for (const sys of Object.keys(tube).sort()) {
    for (const f of d.derive_system_facts(tubeFacts(sys)).filter((x) => x.metric_key === "tube.replacement")) {
      got.push([sys, new Date(f.host_datetime).toISOString().slice(0, 10), f.value_text]);
    }
  }
  assert.deepStrictEqual(got, EXPECTED_REPLACEMENTS);
  // SME20594 added 2026-11-04 after review (DST-end clock step, see verify.js)
  assert.deepStrictEqual(EXPECTED_CLOCK_AHEAD, ["SME11229", "SME16618", "SME20594", "SME21873", "SME21929"]);
});

// ----------------------------------------------- review PHASE3-RUN-VERIFY

test("RUN-VERIFY F1: CLI value flags must have a value; a missing --system never means the whole fleet", () => {
  const { args } = require("../cli");
  const bad = [
    [["derive", "--apply", "--system"], /--system needs a value/],
    [["derive", "--apply", "--system", "--rehearse"], /--system needs a value/],
    [["derive", "--apply", "--system", ""], /--system needs a value/],
    [["derive", "--rehearse", "--systems"], /--systems needs a value/],
    [["derive", "--rehearse", "--systems", ",, ,"], /at least one system id/],
    [["derive", "--rehearse", "--system", "A", "--systems", "B"], /either --system or --systems/],
    [["backfill", "--apply", "--from-id"], /--from-id needs a value/],
    [["backfill", "--apply", "--from-id", "12x"], /non-negative integer/],
    [["backfill", "--rehearse", "--batches", "-1"], /--batches needs a value|non-negative integer/],
  ];
  for (const [argv, re] of bad) assert.throws(() => args(argv), re, argv.join(" "));
  assert.deepStrictEqual(args(["derive", "--apply", "--system", "SME1"]).systems, ["SME1"]);
  assert.deepStrictEqual(args(["derive", "--rehearse", "--systems", "SME1, SME2"]).systems, ["SME1", "SME2"]);
  assert.strictEqual(args(["derive", "--apply"]).systems, undefined); // no flag at all: fleet-wide, as intended
  assert.strictEqual(args(["backfill", "--apply", "--from-id", "0"]).from_id, 0);
});

test("RUN-VERIFY F2: exam verification compares protocol and local_day", () => {
  const { EXAMS_DIFF_SQL } = require("../derive/verify");
  assert.match(EXAMS_DIFF_SQL, /value_text AS protocol, host_local::date AS local_day/);
  assert.strictEqual((EXAMS_DIFF_SQL.match(/y\.protocol IS DISTINCT FROM x\.protocol OR y\.local_day <> x\.local_day/g) || []).length, 2,
    "in both the differ count and the sample filter");
});
