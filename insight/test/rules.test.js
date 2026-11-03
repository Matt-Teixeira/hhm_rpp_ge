"use strict";
// node insight/test/rules.test.js   (no DB needed)
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { rules } = require("../rules/ge_ct");
const { facts_for_row, validate_rules, catalog_rows, process_of } = require("../rules/engine");

const FIX = path.join(__dirname, "..", "rules", "__fixtures__", "ge_ct");
const row = (process, message, extra = {}) => ({ type: `HOST\t${process}`, message, exception_class: null, severity: null, ermes_number: null, ...extra });
const run = (r) => facts_for_row(r, rules);
const only = (r, key) => {
  const { facts, errors } = run(r);
  assert.deepStrictEqual(errors, []);
  const f = facts.filter((x) => x.metric_key === key);
  assert.strictEqual(f.length, 1, `expected one ${key} fact, got ${facts.map((x) => x.metric_key).join(",") || "none"}`);
  return f[0];
};

test("registry is valid and generates a catalog row per rule", () => {
  assert.deepStrictEqual(validate_rules(rules), []);
  const cat = catalog_rows(rules);
  assert.strictEqual(cat.length, rules.length);
  assert.ok(cat.every((c) => c.customer_visible === true));
  assert.ok(cat.find((c) => c.metric_key === "compliance.dose_display_disabled").model_specific);
});

test("process_of takes the half after the tab", () => {
  assert.strictEqual(process_of("gectpet\tscanRx"), "scanRx");
  assert.strictEqual(process_of("orp\torp_subsys "), "orp_subsys");
  assert.strictEqual(process_of(null), "");
});

// Fixtures are labelled by an independent SQL classifier (tools/build_fixtures.js).
test("every real fixture produces exactly its labelled metric (plus error.ermes when it has a code)", () => {
  const files = fs.readdirSync(FIX).filter((f) => f.endsWith(".json"));
  assert.ok(files.length >= rules.length, "fixtures missing for some rules: run insight/tools/build_fixtures.js");
  const labelled = new Set(files.map((f) => f.replace(/\.json$/, "")));
  for (const r of rules) assert.ok(labelled.has(r.key), `no fixture file for ${r.key}`);
  let n = 0;
  for (const f of files) {
    const label = f.replace(/\.json$/, "");
    for (const s of JSON.parse(fs.readFileSync(path.join(FIX, f), "utf8"))) {
      n++;
      const { facts, errors } = run(s);
      assert.deepStrictEqual(errors, [], `${label}: rule error`);
      const keys = facts.map((x) => x.metric_key).sort();
      // Class-based metrics stack on any message-based one: error.ermes (has a
      // code), scan.abort.system (exception_class Abort), scan.safe_state
      // (exception_class Safe State). Nothing else may co-occur.
      const byClass = [
        ...(s.ermes_number !== null ? ["error.ermes"] : []),
        ...(s.exception_class === "Abort" ? ["scan.abort.system"] : []),
        ...(s.exception_class === "Safe State" ? ["scan.safe_state"] : []),
      ];
      const expected = label === "none" ? [] : [...new Set([label, ...byClass])].sort();
      assert.deepStrictEqual(keys, expected, `${label}: ${JSON.stringify(s.message).slice(0, 140)}`);
    }
  }
  assert.ok(n > 100, `only ${n} fixture samples`);
});

test("tube counter and identity", () => {
  assert.strictEqual(only(row("scanmgr", "The current tube usage data reports a total of 71243584.0 ma*S.\n"), "tube.mas_total").value_num, 71243584);
  assert.strictEqual(only(row("scanmgr", "The current tube usage data reports a total of 512 ma*S.\n"), "tube.mas_total").value_num, 512);
  assert.strictEqual(only(row("fwmgr", "GE tube has been verified.\n"), "tube.identity").value_text, "verified");
  assert.strictEqual(only(row("scanRx", "Tube identity advisory: An unrecognized X-Ray tube has been installed on the system."), "tube.identity").value_text, "unrecognized");
  const t = only(row("orp_subsys", " Current tube type is Liquid Bearing tube.\n"), "tube.identity");
  assert.deepStrictEqual([t.value_text, t.attrs], ["type", { tube_type: "Liquid Bearing" }]);
});

test("rotor messages: fault vs habit are different metrics", () => {
  const fault = run(row("tgp_subsys", " Liquid Bearing tube rotor is decelerating to stop unexpectedly. Stopped gantry rotation to prevent the tube from fatal damage.")).facts.map((f) => f.metric_key);
  const habit = run(row("tgp_subsys", " Liquid Bearing tube rotor is decelerating to stop without moving to random gantry position by request. A lot of this operation will cause short life of tube.")).facts.map((f) => f.metric_key);
  assert.deepStrictEqual(fault, ["tube.rotor_unexpected_stop"]);
  assert.deepStrictEqual(habit, ["tube.rotor_stop_no_random_position"]);
  assert.deepStrictEqual(only(row("orp_subsys", "\n(40-0114)Rotor not at speed. \x03\nZ6,Z7= 4h,1h\n"), "tube.rotor_not_at_speed").attrs, { z6_h: 4, z7_h: 1 });
  assert.strictEqual(only(row("orp_subsys", " Liquid Bearing tube rotor health log. SGB Slope: -12.5 rpm/sec "), "tube.rotor_sgb_slope").value_num, -12.5);
});

test("exam start and series summary", () => {
  const s = only(row("scanRx", "Start: Prospective Exam: 10001 : Protocol: 5.1 \n"), "exam.start");
  assert.deepStrictEqual([s.exam_no, s.value_text], ["10001", "5.1"]);
  const msg = "Series: 1 : Scans: 2 : Images: 2  (Scout)\nSeries: 2 : Scans: 1 : Images: 299 : PMRSeries(2)\nSeries: 12 : Scan Series: 901 : Images: 299: (Static PET -  MAC)\n\n";
  const f = only(row("scanRx", msg), "exam.series");
  assert.strictEqual(f.value_num, 301);
  assert.strictEqual(f.attrs.ct_series, 2);
  assert.strictEqual(f.attrs.ct_scans, 3);
  assert.deepStrictEqual(f.attrs.series[0], { series: 1, scans: 2, images: 2, scout: true });
  assert.deepStrictEqual(f.attrs.pet, [{ series: 12, scan_series: 901, images: 299, label: "Static PET - MAC" }]);
  const sp = only(row("scanRx", "Series: 15 : Scans: 1 : Images: 208 : PMRSeries(2) : SPScans: 5\n"), "exam.series");
  assert.deepStrictEqual(sp.attrs.series[0], { series: 15, scans: 1, images: 208, scout: false, pmr: 2, sp_scans: 5 });
});

test("aborts, safe state and ermes", () => {
  const op = only(row("scanmgr", " Function: System Control : Scan Control\n Scan Type: Scout Scan: 2/1/1\n Scan Seq Id: 7\nOperator Aborted Scanning (via Gantry or Hard Key)\n"), "scan.abort.operator");
  assert.deepStrictEqual(op.attrs, { scan_type: "Scout" });
  const sys = run(row("orp_subsys", " The DCB has notified the system of an error condition which prevents scanning.\x03 Error message code: 7", { exception_class: "Abort", severity: "Primary", ermes_number: "260116316" })).facts;
  assert.deepStrictEqual(sys.map((f) => f.metric_key).sort(), ["error.ermes", "scan.abort.system"]);
  const e = sys.find((f) => f.metric_key === "error.ermes");
  assert.deepStrictEqual([e.value_num, e.value_text, e.attrs], [260116316, "Abort", { severity: "Primary", process: "orp_subsys" }]);
  // 'Operator Abort' exception records are ermes rows, not a second operator abort
  const oa = run(row("scanmgr", " something", { exception_class: "Operator Abort", ermes_number: "100" })).facts.map((f) => f.metric_key);
  assert.deepStrictEqual(oa, ["error.ermes"]);
});

test("service mode (incl. prefixed variant), restarts, shutdown, init", () => {
  assert.strictEqual(only(row("environmentMgr", "Running Version Management Tool System exit service mode \n"), "service.mode").value_text, "exit");
  assert.strictEqual(only(row("environmentMgr", "System enter service mode \n"), "service.mode").value_text, "enter");
  assert.strictEqual(only(row("cupMonitor", "An unexpected termination of device_eventlog caused it to be restarted.\n"), "process.restart").value_text, "device_eventlog");
  only(row("environmentMgr", "Running Version Management Tool System shutdown started from desktop button \n"), "system.shutdown");
  only(row("cupMonitor", "Software Initialization Complete\n"), "system.sw_init_complete");
  assert.deepStrictEqual(run(row("petRetro", "SS Initialization completed successfully.\n")).facts, []);
});

test("prep vs service calibration are split by process", () => {
  const p = only(row("dailyPrepRx", "Tube temperature before Fast Calibration is 85 degrees Celsius.\n"), "prep.tube_temp");
  assert.deepStrictEqual([p.value_num, p.value_text, p.attrs], [85, "Fast Calibration", { phase: "before" }]);
  const c = only(row("scanUtilsRx", "Tube temperature before Air Ratio Create MSD is 549.72 degrees Celsius.\n"), "service.calibration");
  assert.deepStrictEqual([c.value_num, c.value_text], [549.72, "Air Ratio Create MSD"]);
});

test("operator compliance and the two new metrics", () => {
  assert.strictEqual(only(row("scanRx", "Scanning was confirmed for exam 10001 while the X-ray tube state was in the yellow warm up zone.\n"), "op.scan_in_warmup_zone").exam_no, "10001");
  const w1 = only(row("scanRx", "Tube warm up was skipped. Limited mA will be used for exam 10001. Max small spot mA = 200, max large spot mA = 350\n"), "op.warmup_skipped");
  assert.deepStrictEqual(w1.attrs, { max_small_spot_ma: 200, max_large_spot_ma: 350 });
  const w2 = only(row("scanRx", "Tube warm up was skipped. Limited mA will be used for exam 10001. Max mA for 120kV = 440, Max mA for 140kV= 380\n"), "op.warmup_skipped");
  assert.deepStrictEqual(w2.attrs, { max_ma_120kv: 440, max_ma_140kv: 380 });
  const d = only(row("scanRx", " Dose information database (Ctdi.cfg) read error. Disabled dose information display feature. Failed token path: PERENNA_1, BODY, CENTER, XLARGE_SPOT, slice_factor_1_0x1_0\n"), "compliance.dose_display_disabled");
  assert.strictEqual(d.value_text, "PERENNA_1, BODY, CENTER, XLARGE_SPOT, slice_factor_1_0x1_0");
  const a = only(row("scanRx", "Only large spot is allowed for patient scanning because no air ratio calibration was done more than 35 days. Current tube temperature is 120 degrees Celsius, Air Ratio calibration"), "calibration.air_overdue");
  assert.deepStrictEqual([a.value_num, a.attrs], [35, { tube_temp_c: 120 }]);
});

test("environment: plenum units normalized to °C, recovery separate, PSU and humidity scaled", () => {
  const A = only(row("orp_subsys", "\nPlenum Plenum Center Sensor Temperature Out of Tolerance\nSensor Temperatures: Left: 2550, Center: 2550, Right: 2800\nFiltered Average Temperature: 2624\nLimits: 2600, 3400\n(All temperatures in 1/100th degree C)\n"), "env.plenum_temp");
  assert.deepStrictEqual([A.value_num, A.value_text, A.attrs.right, A.attrs.limit_high], [26.24, "Center Sensor", 28, 34]);
  const B = only(row("orp_subsys", "\nPlenum 2 Temperature Out of Tolerance.\n Sensor Temperatures:\n Left [1]:  34.25  Center [2] 34.25 , Right [3]: 33.62\n Filtered Average Temperature:  34.04\n Limits:        26.00,        34.00\n"), "env.plenum_temp");
  assert.deepStrictEqual([B.value_num, B.value_text, B.attrs.left, B.attrs.limit_low], [34.04, "2", 34.25, 26]);
  const C = run(row("orp_subsys", "\nThe CFHC has recovered from following error.\n Plenum 1 Temperature Out of Tolerance\n Sensor Temperatures:\n Left [1]:  26.00  Center [2] 26.75 , Right [3]: 27.75\n Filtered Average Temperature:  26.83\n Limits:        26.00,        34.00\n")).facts;
  assert.deepStrictEqual(C.map((f) => [f.metric_key, f.value_num]), [["env.plenum_recovered", 26.83]]);
  assert.strictEqual(only(row("orp_subsys", " Detector Temperature Is Low. Image quality may be affected. Current Reading:31 Deg C A/D Counts:1234 "), "env.detector_temp_low").value_num, 31);
  const t = only(row("event_logger", " Function: Health Readiness Service\nThe prop 48V power supply read a temperature which is out of specification. Sensor ID = 3, Actual reading = 71500 millidegC, Hi limit = 70000 millidegC"), "env.psu_temp_out_of_spec");
  assert.deepStrictEqual([t.value_num, t.value_text, t.attrs], [71.5, "prop 48V", { hi_limit_c: 70 }]);
  const v = only(row("event_logger", " Function: Health Readiness Service\nThe gantry 24V Prop power supply read a voltage which is out of specification. Actual reading = 25300mV, Hi limit = 25200mV, Low limit = 22800mV "), "env.psu_voltage_out_of_spec");
  assert.deepStrictEqual([v.value_num, v.value_text, v.attrs], [25300, "gantry 24V Prop", { hi_limit_mv: 25200, low_limit_mv: 22800 }]);
  assert.strictEqual(only(row("event_logger", " Function: TempHumidityService::htmThresholdCheck\nAmbient Gantry humidity out of range. Check the scan room humidity is within the range. Actual Value: 72500 milliRH detected"), "env.humidity_out_of_range").value_num, 72.5);
});

test("DICOM transfer: all three seen formats", () => {
  const a = only(row("dcserver", "Sent:  2229/11 (DEST)\n"), "xfer.dicom_sent");
  assert.deepStrictEqual([a.value_text, a.attrs], ["DEST", { a: 2229, b: 11 }]);
  const b = only(row("dcserver", "Start Sending:  15411/997/... (DEST)\n"), "xfer.dicom_send_start");
  assert.deepStrictEqual(b.attrs, { a: 15411, b: 997, truncated: true });
  const c = only(row("dcserver", "Start Sending:  2175 (DEST)\n"), "xfer.dicom_send_start");
  assert.deepStrictEqual(c.attrs, { a: 2175 });
});

test("product configuration keeps sw/hw strings and drops host_id", () => {
  const p = only(row("Svc_Notepad", "This message was added by the OPERATOR to report on a problem:\nPRODUCT CONFIGURATION|Product: BrightSpeed|sw_version: 13BW29.5|sw_hw_string: 13BW29.5.HP_P_P16_G_GMV|machine_type: Intel|host_id: 1944414294|tube_type: 15|gantry_type: GANTRY_HP|No. of processors: 8|Processor speed: 1998|memory: 8192\n"), "inventory.product");
  assert.strictEqual(p.value_text, "BrightSpeed");
  assert.deepStrictEqual(p.attrs, { sw_version: "13BW29.5", sw_hw_string: "13BW29.5.HP_P_P16_G_GMV", machine_type: "Intel", tube_type: "15", gantry_type: "GANTRY_HP" });
  assert.ok(!JSON.stringify(p).includes("1944414294"));
  // other Svc_Notepad free text produces nothing
  assert.deepStrictEqual(run(row("Svc_Notepad", "This message was added by the OPERATOR to report on a problem: InSite Logged In")).facts, []);
});

test("a throwing rule is reported, not fatal", () => {
  const bad = [{ key: "x.y", version: 1, process: null, extract: () => { throw new Error("boom"); } }, ...rules];
  const out = facts_for_row(row("scanmgr", "The current tube usage data reports a total of 5 ma*S."), bad);
  assert.deepStrictEqual(out.errors.map((e) => e.key), ["x.y"]);
  assert.deepStrictEqual(out.facts.map((f) => f.metric_key), ["tube.mas_total"]);
});
