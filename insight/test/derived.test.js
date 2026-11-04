"use strict";
// node insight/test/derived.test.js   (no DB needed)
// Derived-fact rules (system.boot, tube.replacement), PLAN-CT-INSIGHTS.md
// §13.1-§13.3. Real cases come from insight/rules/__fixtures__/ge_ct_derived
// (built by tools/build_derived_fixtures.js; boot labels from the
// independent SQL). Tube expectations are the §13.1 table.
const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const fs = require("fs");
const d = require("../rules/ge_ct_derived");
const { rules } = require("../rules/ge_ct");
const { catalog_rows } = require("../rules/engine");

const FIX = path.join(__dirname, "..", "rules", "__fixtures__", "ge_ct_derived");
const load = (f) => JSON.parse(fs.readFileSync(path.join(FIX, f), "utf8"));

let seq = 0;
// fixture row {m,t,l,v,x,e,r} -> fact as derive receives it from the DB
const fromFixture = (system_id) => (f) => ({
  system_id, metric_key: f.m, host_datetime: new Date(f.t), host_local: f.l,
  value_num: f.v === undefined ? null : f.v, value_text: f.x === undefined ? null : f.x,
  epoch: f.e, record_number_concurrent: f.r, source_id: ++seq, source_capture_datetime: new Date(f.t),
});

// synthetic fact; local time = UTC - 5 h
const at = (iso) => new Date(iso);
const fact = (metric_key, iso, o = {}) => {
  const ms = Date.parse(iso);
  const local = new Date(ms - 5 * 3600000).toISOString().slice(0, 19);
  return { system_id: "SME1", metric_key, host_datetime: at(iso), host_local: local, value_num: null, value_text: null,
    epoch: Math.floor(ms / 1000), record_number_concurrent: 0, source_id: ++seq, source_capture_datetime: at(iso), ...o };
};
const reading = (iso, v) => fact("tube.mas_total", iso, { value_num: v });
const cal = (iso) => fact("service.calibration", iso, { value_num: 30, value_text: "Air" });
const ident = (iso, v, o = {}) => fact("tube.identity", iso, { value_text: v, ...o });
const init = (iso) => fact("system.sw_init_complete", iso);
const restart = (iso) => fact("process.restart", iso, { value_text: "device_eventlog" });
const shutdown = (iso) => fact("system.shutdown", iso);
const of = (facts, key) => d.derive_system_facts(facts).filter((f) => f.metric_key === key);

// ------------------------------------------------------------- registry

test("derived rules validate, don't collide with per-row rules, and generate catalog rows", () => {
  assert.deepStrictEqual(d.validate_derived_rules(d.derived_rules, rules), []);
  assert.deepStrictEqual(d.DERIVED_KEYS, ["system.boot", "tube.replacement"]);
  const cat = catalog_rows(d.derived_rules);
  assert.deepStrictEqual(cat.map((c) => [c.metric_key, c.category, c.value_kind]),
    [["system.boot", "reliability", "event"], ["tube.replacement", "tube", "event"]]);
  assert.ok(cat.every((c) => c.label && c.description && c.rule_version === 1));
  // a derived key colliding with a per-row key is refused
  assert.match(d.validate_derived_rules([{ ...d.derived_rules[0], key: "tube.mas_total" }], rules).join(), /collides/);
});

// --------------------------------------------- tube.replacement: §13.1

const EXPECTED_TUBE = {
  // [UTC date of reset (§13.1), confidence, calibrations, old mA·s, install_date (device clock), tube_source]
  SME15218: [["2026-05-28", "confirmed", 14, 15248870, "2026-05-28", "unrecognized"],
             ["2026-09-24", "confirmed", 81, 7860064, "2026-09-23", "unrecognized"]],
  SME16618: [["2026-06-04", "confirmed", 26, 52811357.5, "2026-06-03", "unrecognized"]],
  SME21864: [["2026-07-15", "confirmed", 9, 57335666.1, "2026-07-15", "unrecognized"]],
  SME21873: [["2025-08-14", "confirmed", 17, 34074680, "2025-08-14", "verified"],
             ["2025-09-02", "counter_only", 0, 710163, "2025-09-02", "verified"], // 4/4 tie: verified seen first
             ["2025-12-08", "confirmed", 24, 3054486, "2025-12-08", "unrecognized"],
             ["2026-01-28", "confirmed", 78, 2223276, "2026-01-28", "unrecognized"]],
  SME21859: [],
};

test("tube.replacement reproduces the §13.1 table exactly (7 confirmed, 1 counter_only, none elsewhere)", () => {
  const tube = load("tube.json");
  let confirmed = 0, counterOnly = 0;
  for (const [sys, rows] of Object.entries(tube)) {
    const facts = rows.map(fromFixture(sys));
    const got = of(facts, "tube.replacement");
    const want = EXPECTED_TUBE[sys];
    assert.strictEqual(got.length, want.length, `${sys}: ${got.length} replacements`);
    got.forEach((f, i) => {
      const [day, conf, cals, old, install, src] = want[i];
      assert.strictEqual(new Date(f.host_datetime).toISOString().slice(0, 10), day, `${sys} #${i} reset day`);
      assert.strictEqual(f.value_text, conf, `${sys} ${day} confidence`);
      assert.strictEqual(f.attrs.confidence, conf);
      assert.strictEqual(f.attrs.calibrations_in_window, cals, `${sys} ${day} calibrations`);
      assert.strictEqual(f.value_num, old, `${sys} ${day} old mA·s`);
      assert.strictEqual(f.attrs.old_mas, old);
      assert.strictEqual(f.attrs.install_date, install, `${sys} ${day} install_date`);
      assert.strictEqual(f.attrs.tube_source, src, `${sys} ${day} tube_source`);
      assert.strictEqual(f.attrs.new_mas, 0);
      // keyed on the reset reading itself
      const src_reading = facts.find((x) => x.metric_key === "tube.mas_total" && x.epoch === f.epoch && x.record_number_concurrent === f.record_number_concurrent);
      assert.ok(src_reading && src_reading.value_num === 0, `${sys} ${day} keyed on the reset reading`);
      assert.strictEqual(f.source_id, src_reading.source_id);
      if (conf === "confirmed") confirmed++; else counterOnly++;
    });
  }
  assert.strictEqual(confirmed, 7);
  assert.strictEqual(counterOnly, 1);
});

test("tube.replacement: glitch, pending, prior threshold", () => {
  const base = [reading("2026-01-01T12:00:00Z", 5e6), reading("2026-01-03T12:00:00Z", 5.1e6)];
  // single 0 that returns to the prior level: glitch
  assert.strictEqual(of([...base, reading("2026-01-05T12:00:00Z", 0), reading("2026-01-07T12:00:00Z", 5.2e6), reading("2026-01-09T12:00:00Z", 5.3e6)], "tube.replacement").length, 0);
  // low, then back up within the next 3 readings: glitch
  assert.strictEqual(of([...base, reading("2026-01-05T12:00:00Z", 0), reading("2026-01-07T12:00:00Z", 1000), reading("2026-01-09T12:00:00Z", 5.2e6)], "tube.replacement").length, 0);
  // reset with only one later reading: pending, not emitted yet
  assert.strictEqual(of([...base, reading("2026-01-05T12:00:00Z", 0), reading("2026-01-07T12:00:00Z", 3000)], "tube.replacement").length, 0);
  // two later readings, both low: emitted
  assert.strictEqual(of([...base, reading("2026-01-05T12:00:00Z", 0), reading("2026-01-07T12:00:00Z", 3000), reading("2026-01-09T12:00:00Z", 9000)], "tube.replacement").length, 1);
  // a 4th later reading that is high doesn't matter (only the next 3 are checked)
  assert.strictEqual(of([...base, reading("2026-01-05T12:00:00Z", 0), reading("2026-01-07T12:00:00Z", 3000), reading("2026-01-09T12:00:00Z", 9000),
    reading("2026-01-11T12:00:00Z", 12000), reading("2026-01-13T12:00:00Z", 6e6)], "tube.replacement").length, 1);
  // prior reading not above 100k: not a reset
  assert.strictEqual(of([reading("2026-01-01T12:00:00Z", 100000), reading("2026-01-03T12:00:00Z", 0), reading("2026-01-05T12:00:00Z", 10), reading("2026-01-07T12:00:00Z", 20)], "tube.replacement").length, 0);
  // drop to exactly 50%: not below the ratio
  assert.strictEqual(of([reading("2026-01-01T12:00:00Z", 4e6), reading("2026-01-03T12:00:00Z", 2e6), reading("2026-01-05T12:00:00Z", 1e6), reading("2026-01-07T12:00:00Z", 1e6)], "tube.replacement").length, 0);
  // null and non-finite readings are ignored (verify_sql.js drops them too: review PHASE3-DERIVED F2)
  for (const bad of [null, NaN, Infinity, -Infinity]) {
    assert.strictEqual(of([...base, reading("2026-01-04T12:00:00Z", bad), reading("2026-01-05T12:00:00Z", 0), reading("2026-01-06T12:00:00Z", bad),
      reading("2026-01-07T12:00:00Z", 3000), reading("2026-01-09T12:00:00Z", 9000)], "tube.replacement").length, 1, String(bad));
  }
  // the SQL verifier applies the same finite-only policy
  assert.match(require("../derive/verify_sql").RESETS_SQL, /value_num NOT IN \('NaN'::float8, 'Infinity'::float8, '-Infinity'::float8\)/);
});

test("tube.replacement: calibration window, confidence threshold, install_date", () => {
  const counter = [reading("2026-03-01T12:00:00Z", 9e6), reading("2026-03-10T12:00:00Z", 0), reading("2026-03-12T12:00:00Z", 2e5), reading("2026-03-14T12:00:00Z", 4e5)];
  const run = (cals) => of([...counter, ...cals], "tube.replacement")[0];
  // exactly 3 in window: confirmed; install_date = first calibration's device-clock date
  // (first calibration 03-04 03:00 UTC = 03-03 22:00 on the device clock: the device day wins)
  let f = run([cal("2026-03-04T03:00:00Z"), cal("2026-03-08T04:00:00Z"), cal("2026-03-11T12:00:00Z")]);
  assert.strictEqual(f.value_text, "confirmed");
  assert.strictEqual(f.attrs.calibrations_in_window, 3);
  assert.strictEqual(f.attrs.install_date, "2026-03-03");
  assert.strictEqual(f.attrs.first_calibration_at, "2026-03-04T03:00:00.000Z");
  // 2 in window: counter_only, but the first calibration still gives install_date
  f = run([cal("2026-03-08T12:00:00Z"), cal("2026-03-09T12:00:00Z")]);
  assert.strictEqual(f.value_text, "counter_only");
  assert.strictEqual(f.attrs.install_date, "2026-03-08");
  // window bounds are inclusive: reset - 7 d and reset + 1 d count; just outside doesn't
  f = run([cal("2026-03-03T12:00:00Z"), cal("2026-03-11T12:00:00Z"), cal("2026-03-05T00:00:00Z"),
           cal("2026-03-03T11:59:59Z"), cal("2026-03-11T12:00:01Z")]);
  assert.strictEqual(f.attrs.calibrations_in_window, 3);
  // no calibrations: counter_only, install_date = reset reading's device-clock date
  f = run([]);
  assert.strictEqual(f.value_text, "counter_only");
  assert.strictEqual(f.attrs.install_date, "2026-03-10");
  assert.strictEqual(f.attrs.first_calibration_at, null);
  assert.strictEqual(f.attrs.old_last_reading_at, "2026-03-01T12:00:00.000Z");
});

test("tube.replacement refuses host_local that isn't wall-clock text (e.g. a driver-parsed Date)", () => {
  const counter = [reading("2026-03-01T12:00:00Z", 9e6), reading("2026-03-10T12:00:00Z", 0), reading("2026-03-12T12:00:00Z", 2e5), reading("2026-03-14T12:00:00Z", 4e5)];
  counter[1].host_local = new Date("2026-03-10T07:00:00Z");
  assert.throws(() => d.derive_system_facts(counter), /host_local must be 'YYYY-MM-DDTHH:MI:SS' text/);
});

test("tube_source: verdict precedence, companion no_smart_id, ties, window", () => {
  const S = Date.parse("2026-04-01T00:00:00Z"), E = Date.parse("2026-05-01T00:00:00Z");
  const pairs = [];
  for (let i = 1; i <= 5; i++) pairs.push(ident(`2026-04-0${i}T07:00:00Z`, "no_smart_id"), ident(`2026-04-0${i}T07:01:00Z`, "verified"));
  // verdict + companion line at every boot (SME21870 pattern): verified, not a tie
  assert.strictEqual(d.tube_source(pairs, S, E).tube_source, "verified");
  // only the companion line (SME01434 pattern)
  assert.strictEqual(d.tube_source([ident("2026-04-02T07:00:00Z", "no_smart_id")], S, E).tube_source, "no_smart_id");
  // majority wins
  assert.strictEqual(d.tube_source([ident("2026-04-02T07:00:00Z", "verified"), ident("2026-04-03T07:00:00Z", "unrecognized"), ident("2026-04-04T07:00:00Z", "unrecognized")], S, E).tube_source, "unrecognized");
  // exact tie: first seen wins, in either order
  assert.strictEqual(d.tube_source([ident("2026-04-02T07:00:00Z", "unrecognized"), ident("2026-04-03T07:00:00Z", "verified")], S, E).tube_source, "unrecognized");
  assert.strictEqual(d.tube_source([ident("2026-04-03T07:00:00Z", "unrecognized"), ident("2026-04-02T07:00:00Z", "verified")], S, E).tube_source, "verified");
  // exact tie at the same second: record order (epoch, rnc) decides (review PHASE3-DERIVED F1)
  assert.strictEqual(d.tube_source([ident("2026-04-02T07:00:00Z", "verified", { record_number_concurrent: 1 }),
    ident("2026-04-02T07:00:00Z", "unrecognized", { record_number_concurrent: 0 })], S, E).tube_source, "unrecognized");
  assert.strictEqual(d.tube_source([ident("2026-04-02T07:00:00Z", "verified", { record_number_concurrent: 0 }),
    ident("2026-04-02T07:00:00Z", "unrecognized", { record_number_concurrent: 1 })], S, E).tube_source, "verified");
  // outside [start, end) is ignored; nothing -> null
  const r = d.tube_source([ident("2026-03-31T23:59:59Z", "verified"), ident("2026-05-01T00:00:00Z", "verified")], S, E);
  assert.strictEqual(r.tube_source, null);
  assert.deepStrictEqual(r.counts, { verified: 0, unrecognized: 0, no_smart_id: 0 });
});

test("tube.replacement: tube_source window stops at the next reset", () => {
  const facts = [
    reading("2026-01-01T12:00:00Z", 9e6), reading("2026-01-05T12:00:00Z", 0), reading("2026-01-07T12:00:00Z", 2e5), reading("2026-01-09T12:00:00Z", 4e5),
    ident("2026-01-06T07:00:00Z", "verified"),
    reading("2026-01-11T12:00:00Z", 6e5), reading("2026-01-13T12:00:00Z", 0), reading("2026-01-15T12:00:00Z", 1e5), reading("2026-01-17T12:00:00Z", 2e5),
    ident("2026-01-14T07:00:00Z", "unrecognized"), ident("2026-01-16T07:00:00Z", "unrecognized"),
  ];
  const got = of(facts, "tube.replacement");
  assert.deepStrictEqual(got.map((f) => f.attrs.tube_source), ["verified", "unrecognized"]);
  assert.deepStrictEqual(got[0].attrs.tube_source_counts, { verified: 1, unrecognized: 0, no_smart_id: 0 });
});

// -------------------------------------------------------- system.boot

test("system.boot matches the independent SQL on real windows (restart loop, daily cycling, inits without shutdown)", () => {
  for (const c of load("boots.json")) {
    const facts = c.facts.map(fromFixture(c.system_id));
    const [from, to] = c.window.map((x) => Date.parse(x));
    const got = of(facts, "system.boot")
      .filter((f) => +f.host_datetime >= from && +f.host_datetime < to)
      .map((f) => ({ t: f.host_datetime.toISOString(), e: f.epoch, r: f.record_number_concurrent, clean: f.value_text === "clean" }));
    assert.deepStrictEqual(got, c.expected, `${c.system_id} ${c.window[0]}`);
  }
});

test("system.boot: the SME18531 restart loop contributes no boots", () => {
  const loop = load("boots.json").filter((c) => c.system_id === "SME18531");
  const inits = loop.flatMap((c) => c.facts).filter((f) => f.m === "system.sw_init_complete").length;
  assert.ok(inits > 400, `fixture has ${inits} inits`);
  for (const c of loop) {
    const facts = c.facts.map(fromFixture(c.system_id));
    const boots = of(facts, "system.boot");
    const restarts = facts.filter((f) => f.metric_key === "process.restart").map((f) => +f.host_datetime);
    for (const b of boots) assert.ok(!restarts.some((r) => r <= +b.host_datetime && r >= +b.host_datetime - 5 * 60000), `boot ${b.host_datetime.toISOString()} follows a restart`);
  }
  // loop window 1: 1 boot (before the loop); window 2: 3 (after it)
  assert.deepStrictEqual(loop.map((c) => c.expected.length), [1, 3]);
});

test("system.boot: 5-minute restart window and 10-minute gap boundaries", () => {
  const boots = (facts) => of(facts, "system.boot").map((f) => f.host_datetime.toISOString().slice(11, 19));
  // restart exactly 5 min before: excluded; 5 min 1 s before: a boot
  assert.deepStrictEqual(boots([restart("2026-02-01T07:55:00Z"), init("2026-02-01T08:00:00Z")]), []);
  assert.deepStrictEqual(boots([restart("2026-02-01T07:54:59Z"), init("2026-02-01T08:00:00Z")]), ["08:00:00"]);
  // restart at the same second: excluded
  assert.deepStrictEqual(boots([restart("2026-02-01T08:00:00Z"), init("2026-02-01T08:00:00Z")]), []);
  // gap since the previous init (of any kind): exactly 10 min is a boot, 9:59 is not
  assert.deepStrictEqual(boots([init("2026-02-01T08:00:00Z"), init("2026-02-01T08:10:00Z")]), ["08:00:00", "08:10:00"]);
  assert.deepStrictEqual(boots([init("2026-02-01T08:00:00Z"), init("2026-02-01T08:09:59Z")]), ["08:00:00"]);
  // the gap is measured from the previous INIT, even one that wasn't a boot
  assert.deepStrictEqual(boots([init("2026-02-01T08:00:00Z"), restart("2026-02-01T08:20:00Z"), init("2026-02-01T08:21:00Z"), init("2026-02-01T08:25:00Z")]), ["08:00:00"]);
});

test("system.boot: clean = a shutdown since the previous boot", () => {
  const run = (facts) => of(facts, "system.boot").map((f) => [f.host_datetime.toISOString().slice(5, 16), f.value_text, f.attrs.clean]);
  assert.deepStrictEqual(run([
    init("2026-02-01T08:00:00Z"),                                   // first boot, no shutdown before it: unclean
    shutdown("2026-02-01T20:00:00Z"), init("2026-02-02T08:00:00Z"), // clean
    init("2026-02-03T08:00:00Z"),                                   // no shutdown since 02-02 boot: unclean
    shutdown("2026-02-03T08:30:00Z"),
    restart("2026-02-03T09:00:00Z"), init("2026-02-03T09:01:00Z"),  // not a boot (restart) - shutdown stays pending
    init("2026-02-04T08:00:00Z"),                                   // shutdown 02-03 08:30 is after the 02-03 boot: clean
  ]), [
    ["02-01T08:00", "unclean", false], ["02-02T08:00", "clean", true], ["02-03T08:00", "unclean", false], ["02-04T08:00", "clean", true],
  ]);
  // a shutdown at the very same instant as the init counts
  assert.deepStrictEqual(run([shutdown("2026-02-01T08:00:00Z"), init("2026-02-01T08:00:00Z")]), [["02-01T08:00", "clean", true]]);
  // attrs
  const [, b] = of([init("2026-02-01T08:00:00Z"), init("2026-02-01T09:30:00Z")], "system.boot");
  assert.deepStrictEqual(b.attrs, { clean: false, since_prev_init_min: 90, since_prev_boot_h: 1.5 });
});

test("derived facts carry the source record's key and don't depend on input order", () => {
  const facts = [init("2026-02-01T08:00:00Z"), shutdown("2026-02-01T20:00:00Z"), init("2026-02-02T08:00:00Z"),
    reading("2026-01-01T12:00:00Z", 9e6), reading("2026-01-05T12:00:00Z", 0), reading("2026-01-07T12:00:00Z", 2e5), reading("2026-01-09T12:00:00Z", 4e5)];
  const a = d.derive_system_facts(facts);
  const b = d.derive_system_facts([...facts].reverse());
  assert.deepStrictEqual(a, b);
  const boot = a.find((f) => f.metric_key === "system.boot");
  const src = facts[0];
  for (const k of ["system_id", "epoch", "record_number_concurrent", "host_datetime", "host_local", "source_id", "source_capture_datetime"]) {
    assert.deepStrictEqual(boot[k], src[k], k);
  }
  assert.strictEqual(boot.rule_version, 1);
  assert.strictEqual(boot.exam_no, null);
});
