"use strict";
// node --test insight/mri/test   (no DB needed)
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { PassThrough } = require("stream");
const {
  rules, named, error_rule, NAMED_KEYS, NAMED_CODES, SHARED_CODES, MAX_FACTS_PER_ROW, PRESCAN_DIMS, COIL_INVALID_DIMS,
  classify, validate, mri_catalog_rows,
} = require("../rules");
const { build_facts, host_local_of, identity, skip_reason, BATCH_SQL, ROW_COLUMNS, PARTITION_FROM, PARTITION_TO } = require("../extract");
const {
  dedupe_facts, upsert_statements, merge_pending, unreviewed, ct_verifiers_not_mri_aware, LATE_SQL, EXISTING_SQL, CHUNK, PENDING_FULL_DAYS, MIN_SCHEMA_VERSION,
  apply_range, is_full_replay, PRUNE_SQL,
} = require("../load");
const { COND, STORABLE, RECONCILE_SQL, COVERAGE_SQL, CONFLICTS_SQL, IDENTITY_SQL } = require("../reconcile_sql");
const { compare, stale_versions } = require("../verify");
const { REVIEWED_CODES } = require("../codes_reviewed");
const { args, confirm } = require("../cli");
const { masker } = require("../tools/build_fixtures");

const FIX = path.join(__dirname, "..", "__fixtures__");
const INSIGHT = path.join(__dirname, "..", "..");
const MRI = path.join(INSIGHT, "mri");
const row = (o = {}) => ({ id: "1", message_number: 9999999, type: "host1\tscn", message: "something", coil: null, psd: null, ...o });
const facts_of = (r) => classify(r).facts.map((f) => `${f.metric_key}:${f.dim}`);
const named_of = (r) => classify(r).facts.filter((f) => f.metric_key !== "mri.error");

const AGREED_KEYS = [
  "mri.scans_ok", "mri.scans_failed", "mri.exam_started", "mri.sw_start", "mri.sw_stop", "mri.tps_reset", "mri.tps_reset_failed",
  "mri.process_death", "mri.prescan_failed", "mri.autoshim_inconclusive", "mri.coil_invalid", "mri.coil_fault", "mri.cooling_fault",
  "mri.rf_amp_fault", "mri.gradient_fault", "mri.receiver_fault", "mri.table_fault", "mri.door_sensor_fault", "mri.service_mode",
  "mri.pm_overdue", "mri.iq_warning", "mri.system_up",
];

test("registry: valid, mri.* only, the 22 agreed metrics + mri.error, 84 codes, every code reviewed", () => {
  assert.deepStrictEqual(validate(), []);
  assert.deepStrictEqual(NAMED_KEYS, AGREED_KEYS, "Q-M1: the agreed named metrics, in order");
  assert.deepStrictEqual(rules.map((r) => r.key), ["mri.error", ...AGREED_KEYS]);
  assert.strictEqual(NAMED_CODES.length, 84, "§5.2: 84 codes behind the named metrics");
  assert.strictEqual(REVIEWED_CODES.size, 823, "Q-M7: the reviewed set is the whole 2026-11-13 inventory");
  for (const c of NAMED_CODES) assert.ok(REVIEWED_CODES.has(c), `named code ${c} not reviewed`);
  assert.deepStrictEqual(SHARED_CODES, { 2218650: ["mri.scans_ok", "mri.scans_failed"] });
  assert.strictEqual(MAX_FACTS_PER_ROW, 3);
  assert.ok(rules.every((r) => r.version === 1 && r.customer_visible === false && r.value_kind === "event"));
  for (const k of ["mri.coil_use", "mri.dart", "mri.exams"]) assert.ok(!NAMED_KEYS.includes(k), `Q-M3/Q-M4/Q-M5: no ${k}`);
});

test("catalog: categories mapped onto the shared catalog's CHECK (plan §6.1)", () => {
  const cat = Object.fromEntries(mri_catalog_rows().map((c) => [c.metric_key, c.category]));
  assert.strictEqual(Object.keys(cat).length, 23);
  assert.deepStrictEqual(
    { cooling: cat["mri.cooling_fault"], pm: cat["mri.pm_overdue"], service: cat["mri.service_mode"], iq: cat["mri.iq_warning"], up: cat["mri.system_up"], err: cat["mri.error"] },
    { cooling: "environment", pm: "compliance", service: "utilization", iq: "reliability", up: "inventory", err: "reliability" }
  );
  for (const n of named.filter((x) => x.group === "hardware" && x.key !== "mri.cooling_fault")) assert.strictEqual(cat[n.key], "reliability", n.key);
  for (const n of named.filter((x) => x.group === "utilization")) assert.strictEqual(cat[n.key], "utilization", n.key);
  assert.strictEqual(error_rule.group, null, "mri.error's group is per code (ge_mri_codes)");
});

// Fixtures are labelled by the independent SQL (tools/build_fixtures.js).
test("every real fixture gives exactly its labelled facts, valid dims, and no message text", () => {
  const files = fs.readdirSync(FIX).filter((f) => f.endsWith(".json"));
  const labelled = new Set(files.flatMap((f) => f.replace(/\.json$/, "").split("+")));
  for (const k of rules.map((r) => r.key)) assert.ok(labelled.has(k), `no fixture for ${k}`);
  let n = 0;
  for (const f of files) {
    const label = f.replace(/\.json$/, "");
    const want = label === "mri.error" ? ["mri.error"] : ["mri.error", ...label.split("+")].sort();
    for (const s of JSON.parse(fs.readFileSync(path.join(FIX, f), "utf8"))) {
      n++;
      const c = classify(s);
      assert.deepStrictEqual(c.errors, [], `${label}: rule error`);
      assert.deepStrictEqual(c.facts.map((x) => x.metric_key).sort(), want, `${label}: ${s.message_number} ${JSON.stringify(s.message).slice(0, 120)}`);
      assert.strictEqual(c.facts[0].dim, String(s.message_number));
      for (const x of c.facts) {
        assert.strictEqual(x.value_text, null, "no fact stores message text");
        if (x.metric_key === "mri.prescan_failed") assert.ok(PRESCAN_DIMS.includes(x.dim), x.dim);
        if (x.metric_key === "mri.coil_invalid") assert.ok(COIL_INVALID_DIMS.includes(x.dim), x.dim);
        if (x.metric_key === "mri.process_death") assert.match(x.dim, /^(vre:)?[A-Za-z][\w.-]*$/);
        if (x.metric_key === "mri.system_up") assert.ok(x.value_num === 1.5 || x.value_num === 3, `field strength ${x.value_num}`);
        if (/^mri\.scans_/.test(x.metric_key)) assert.ok(Number.isInteger(x.value_num) && x.value_num >= 0);
      }
    }
  }
  assert.ok(n >= 200, `only ${n} fixture samples`);
});

test("fixtures carry no host names, system ids, MAC / IP addresses or device UDIs", () => {
  for (const f of fs.readdirSync(FIX).filter((x) => x.endsWith(".json"))) {
    const s = fs.readFileSync(path.join(FIX, f), "utf8");
    assert.doesNotMatch(s, /\bSME[1-9]\d*\b/, f);
    assert.doesNotMatch(s, /\b([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}\b/.test(s) ? /\b(?!00:00:00:00:00:00)([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}\b/ : /$^/, f);
    assert.doesNotMatch(s, /(?<![\d.])(?!0\.0\.0\.0)(\d{1,3}\.){3}\d{1,3}(?![\d.])/, f);
    assert.doesNotMatch(s, /udi=[1-9]|udi=0\d/, f);
    for (const r of JSON.parse(s)) assert.match(r.type, /^HOST\t/, f);
  }
});

test("process deaths: dsserver and shutdown lines are not counted (Q-M2); dims are process names", () => {
  assert.deepStrictEqual(named_of(row({ message_number: 200002356, message: "dsserver died unexpectedly, no action being taken." })), []);
  assert.deepStrictEqual(facts_of(row({ message_number: 200002356, message: "irm died unexpectedly, no action being taken." })), ["mri.error:200002356", "mri.process_death:irm"]);
  assert.deepStrictEqual(facts_of(row({ message_number: 200002379, message: "Process scn, pid 1 terminated by unexpected signal 9" })), ["mri.error:200002379"]);
  assert.deepStrictEqual(named_of(row({ message_number: 200002352, message: "A HOST_SHUTDOWN was initiated by the death of NSP." })).map((f) => f.dim), ["NSP"]);
  assert.deepStrictEqual(named_of(row({ message_number: 200002354, message: "An unexpected death of irm caused it to be restarted." })).map((f) => f.dim), ["irm"]);
  assert.deepStrictEqual(named_of(row({ message_number: 200002381, message: "Process app, pid 12049 terminated by unexpected signal 11" })).map((f) => f.dim), ["app"]);
  assert.deepStrictEqual(named_of(row({ message_number: 2223878, message: "A process has crashed on the VRE (x[icn1]). Process: dpserver, signal causing \n the crash: 6" })).map((f) => f.dim), ["vre:dpserver"]);
  assert.deepStrictEqual(named_of(row({ message_number: 200002354, message: "something else" })), [], "a code's other text stays mri.error only");
});

test("prescan reasons, coil validation reasons, fixed hardware dims", () => {
  const pre = (m, code = 2224666) => named_of(row({ message_number: code, message: m })).map((f) => f.dim);
  assert.deepStrictEqual(pre("Auto Prescan failed, Gradient amplifiers are not ready."), ["gradient_not_ready"]);
  assert.deepStrictEqual(pre("Auto Prescan failed, Gradients are not ready."), ["gradient_not_ready"]);
  assert.deepStrictEqual(pre("Auto Prescan failed, Master Gradient is not ready."), ["gradient_not_ready"]);
  assert.deepStrictEqual(pre(" \n Manual Prescan failed, by Operator Request.", 2224667), ["operator_request"]);
  assert.deepStrictEqual(pre("Auto Prescan failed, The table is not at scan plane.", 2255008), ["table_not_at_scan_plane"]);
  assert.deepStrictEqual(pre("Manual Prescan failed, 999", 2224667), ["other"]);
  assert.deepStrictEqual(pre("Prescan was fine"), []);
  const coil = (m) => named_of(row({ message_number: 2277604, message: m })).map((f) => f.dim);
  assert.deepStrictEqual(coil("Invalid coil connected. Scanning is not allowed. Not all connectors of the coil are connected."), ["not_all_connected"]);
  assert.deepStrictEqual(coil("Invalid coil connected. Scanning is not allowed. Coil information for port Port A is incorrect."), ["info_incorrect"]);
  assert.deepStrictEqual(coil("Invalid coil connected. Scanning is not allowed. Coil is valid, but not on this port."), ["wrong_port"]);
  assert.deepStrictEqual(coil("Invalid coil connected. Something new."), ["other"]);
  assert.deepStrictEqual(named_of(row({ message_number: 2266425, message: "anything" })).map((f) => `${f.metric_key}:${f.dim}`), ["mri.cooling_fault:brm_water_flow"]);
  assert.deepStrictEqual(named_of(row({ message_number: 2244851, message: "" })).map((f) => f.dim), ["current_distortion"]);
});

test("values: scan counts, field strength in tesla, System Up attrs; service mode and PM dims", () => {
  const scans = classify(row({ message_number: 2218650, message: "Scn: No of Successful Scan = 12 , No of Failed Scan = 3 | " })).facts;
  assert.deepStrictEqual(scans.map((f) => [f.metric_key, f.value_num]), [["mri.error", null], ["mri.scans_ok", 12], ["mri.scans_failed", 3]]);
  assert.deepStrictEqual(named_of(row({ message_number: 2218650, message: "Scn: something else" })), []);
  const up = named_of(row({ message_number: 2227566, message: "System Up. sw=DV26.0_R06_2132.a GAP=yes GradCoil=11 PowerMonType=4 .\\n. RFampType=32 fieldStrength=30000 .\\n. gradientAmp=8921 GCoilType=11 udi=1" }))[0];
  assert.deepStrictEqual([up.dim, up.value_num], ["DV26.0_R06_2132.a", 3]);
  assert.deepStrictEqual(up.attrs, { fieldStrength: "30000", gradientAmp: "8921", RFampType: "32", GradCoil: "11", GCoilType: "11", PowerMonType: "4" });
  assert.deepStrictEqual(named_of(row({ message_number: 2227566, message: "Config: asset probep" })), [], "2227566 Config lines are mri.error only");
  assert.strictEqual(named_of(row({ message_number: 2227566, message: "System Up. sw=X" }))[0].value_num, null, "no field strength: value null");
  assert.deepStrictEqual(named_of(row({ message_number: 2218663, message: "System is being used in GE-Service Mode i.e Patient ID is GESERVICE." })).map((f) => f.dim), ["on"]);
  assert.deepStrictEqual(named_of(row({ message_number: 2218664, message: "System is being used in Normal Mode i.e Patient ID is other than GESERVICE." })).map((f) => f.dim), ["off"]);
  assert.deepStrictEqual(named_of(row({ message_number: 2218673, message: "This system is overdue for Planned Maintenance. Planned Maintenance has been scheduled for 05/30/2026." })).map((f) => f.dim), ["scheduled"]);
});

test("mri.error: every record, dim = code, attrs proc / coil / psd (empty values left out)", () => {
  const c = classify(row({ message_number: 2218189, type: "h\tscn", coil: "HNS Head", psd: " " }));
  assert.deepStrictEqual(c.facts, [{ metric_key: "mri.error", rule_version: 1, dim: "2218189", value_num: null, value_text: null, attrs: { proc: "scn", coil: "HNS Head" } }]);
  assert.strictEqual(classify(row({ type: null })).facts[0].attrs, null);
  // a throwing rule is reported, mri.error still emitted
  const bad = row({ message_number: 2218714, message: { toString() { throw new Error("boom"); } } });
  const out = classify(bad);
  assert.deepStrictEqual(out.facts.map((f) => f.metric_key), ["mri.error"]);
  assert.strictEqual(out.errors.length, 1);
});

test("host_local = 1970-01-01 + epoch seconds (the facts CHECK); partitions 2025-05 .. 2028-12", () => {
  assert.strictEqual(host_local_of(0), "1970-01-01T00:00:00");
  assert.strictEqual(host_local_of(1794565394), "2026-11-13T10:23:14");
  assert.strictEqual(host_local_of(-1), "1969-12-31T23:59:59");
  assert.strictEqual(host_local_of(null), null);
  assert.strictEqual(host_local_of(1.5), null);
  assert.deepStrictEqual([PARTITION_FROM, PARTITION_TO], ["2025-05-01T00:00:00", "2029-01-01T00:00:00"]);
  const ok = { system_id: "SME1", epoch: 1794565394, record_number_concurrent: 0, message_number: 1, host_datetime: new Date("2026-11-13T15:23:14Z") };
  const at = (iso) => ({ ...ok, epoch: Date.parse(`${iso}Z`) / 1000 });
  assert.strictEqual(skip_reason(ok), null);
  assert.strictEqual(skip_reason(at("2025-04-30T23:59:59")), "outside_partitions");
  assert.strictEqual(skip_reason(at("2025-05-01T00:00:00")), null);
  assert.strictEqual(skip_reason(at("2028-12-31T23:59:59")), null);
  assert.strictEqual(skip_reason(at("2029-01-01T00:00:00")), "outside_partitions");
  assert.strictEqual(skip_reason({ ...ok, system_id: "" }), "no_system");
  assert.strictEqual(skip_reason({ ...ok, record_number_concurrent: null }), "missing_key");
  assert.strictEqual(skip_reason({ ...ok, message_number: null }), "no_message_number");
  assert.strictEqual(skip_reason({ ...ok, host_datetime: null }), "no_host_datetime");
  // the SQL side applies the same filter
  assert.match(STORABLE, /timestamp '2025-05-01 00:00:00'/);
  assert.match(STORABLE, /< timestamp '2029-01-01 00:00:00'/);
});

test("build_facts: dedupe on the natural key, re-sent copies counted, a different record on one key is a conflict", () => {
  const base = { system_id: "SME1", epoch: 1794565394, record_number_concurrent: 0, type: "h\tscn", host_datetime: new Date("2026-11-13T15:23:14Z"), capture_datetime: new Date("2026-11-13T15:18:00Z") };
  const rows = [
    row({ ...base, id: "10", message_number: 2218714, message: "New Exam Started" }),
    row({ ...base, id: "11", message_number: 2218714, message: "New Exam Started" }), // re-sent copy
    row({ ...base, id: "12", record_number_concurrent: 1, message_number: 2218650, message: "Scn: No of Successful Scan = 4 , No of Failed Scan = 1" }),
    row({ ...base, id: "13", epoch: 1, message_number: 1 }), // outside the partitions
  ];
  const b = build_facts(rows);
  assert.deepStrictEqual(b.facts.map((f) => `${f.source_id}:${f.metric_key}`), ["10:mri.error", "10:mri.exam_started", "12:mri.error", "12:mri.scans_ok", "12:mri.scans_failed"]);
  assert.strictEqual(b.duplicates, 1);
  assert.deepStrictEqual(b.conflicts, []);
  assert.strictEqual(b.skipped.outside_partitions, 1);
  assert.strictEqual(b.records.length, 2);
  const f = b.facts[0];
  assert.deepStrictEqual([f.system_id, f.epoch, f.record_number_concurrent, f.host_local, f.message_number], ["SME1", 1794565394, 0, "2026-11-13T10:23:14", 2218714]);
  assert.deepStrictEqual([...b.codes].sort(), [2218650, 2218714]);
  // a different record on the same key (a DST fold)
  const c = build_facts([rows[0], row({ ...base, id: "14", message_number: 2218714, message: "New Exam Started (other)" })]);
  assert.deepStrictEqual(c.conflicts, [{ key: "SME1|1794565394|0", ids: ["10", "14"] }]);
  // the dedupe map carries across batches when given (the dry run)
  const seen = new Map();
  build_facts([rows[0]], seen);
  const again = build_facts([rows[1]], seen);
  assert.deepStrictEqual([again.facts.length, again.duplicates], [0, 1]);
});

test("record identity: the JS and SQL definitions are the same string", () => {
  const crypto = require("crypto");
  const r = { message_number: 2218714, type: "h\tscn", message: "New Exam Started" };
  assert.strictEqual(identity(r), crypto.createHash("md5").update(`2218714\u001fh\tscn\u001fNew Exam Started`).digest("hex"));
  assert.strictEqual(identity({ message_number: 1, type: null, message: null }), crypto.createHash("md5").update("1\u001f\u001f").digest("hex"));
  assert.match(IDENTITY_SQL, /^md5\(coalesce\(message_number::text, ''\) \|\| chr\(31\) \|\| coalesce\(type, ''\) \|\| chr\(31\) \|\| coalesce\(message, ''\)\)$/);
  assert.notStrictEqual(identity(r), identity({ ...r, message: "New Exam Started (other)" }));
});

test("load SQL: natural-key upsert gated on rule version, source kept, SQL NULL attrs, casts, chunking", () => {
  const fact = (o = {}) => ({ system_id: "SME1", epoch: 1794565394, record_number_concurrent: 0, metric_key: "mri.error", host_local: "2026-11-13T10:23:14",
    host_datetime: "2026-11-13T15:23:14Z", message_number: 2218714, dim: "2218714", value_num: null, value_text: null, attrs: { proc: "scn" },
    source_id: "10", source_capture_datetime: "2026-11-13T15:18:00Z", rule_version: 1, ...o });
  const [q] = upsert_statements([fact(), fact({ metric_key: "mri.exam_started", dim: "", attrs: null })]);
  assert.match(q, /^\s*WITH up AS \(insert into "insight"\."ge_mri_facts"/i);
  assert.match(q, /ON CONFLICT ON CONSTRAINT ge_mri_facts_natural_key DO UPDATE SET/);
  assert.match(q, /WHERE EXCLUDED\.rule_version > ge_mri_facts\.rule_version\s*RETURNING system_id, host_local\)/);
  const set = q.slice(q.indexOf("DO UPDATE SET"), q.indexOf("WHERE EXCLUDED"));
  assert.doesNotMatch(set, /source_id|source_capture_datetime|system_id =|epoch =|host_local =/, "the key and the first source row are kept");
  assert.match(q, /null::jsonb/);
  assert.ok(!/'null'::jsonb/.test(q), "absent attrs must be SQL NULL");
  assert.match(q, /'2026-11-13T10:23:14'::timestamp/);
  assert.strictEqual(upsert_statements(Array.from({ length: CHUNK + 1 }, (_, i) => fact({ record_number_concurrent: i }))).length, 2);
  const d = dedupe_facts([fact(), fact({ source_id: "11" }), fact({ metric_key: "mri.exam_started" })]);
  assert.deepStrictEqual([d.unique.length, d.collisions], [2, 1]);
  // the conflict lookup and the late re-read use the facts' unique index columns and the source primary key
  assert.match(EXISTING_SQL, /f\.host_local = k\.host_local AND f\.metric_key = 'mri\.error'/);
  assert.match(EXISTING_SQL, /g\.id = f\.source_id AND g\.capture_datetime = f\.source_capture_datetime/);
  // the late re-read takes rows that are no fact's source row, so copies of stored records reach the conflict check (review MRI2-EXTRACT P2-1)
  assert.match(LATE_SQL, /f\.source_id = g\.id AND f\.source_capture_datetime = g\.capture_datetime AND f\.metric_key = 'mri\.error'/);
  assert.doesNotMatch(LATE_SQL, /f\.record_number_concurrent = g\.record_number_concurrent/);
  assert.strictEqual(MIN_SCHEMA_VERSION, 9);
});

test("pending days merge, and switch to a full rebuild past the limit", () => {
  let p = merge_pending({}, [{ system_id: "A", day: "2026-11-02" }, { system_id: "A", day: "2026-11-01" }, { system_id: "B", day: "2026-11-01" }]);
  assert.deepStrictEqual(p, { A: ["2026-11-01", "2026-11-02"], B: ["2026-11-01"] });
  const many = Array.from({ length: PENDING_FULL_DAYS + 1 }, (_, i) => ({ system_id: "C", day: `2026-10-${String(i + 1).padStart(2, "0")}` }));
  p = merge_pending(p, many);
  assert.strictEqual(p.C, "full");
  assert.strictEqual(merge_pending(p, [{ system_id: "C", day: "2026-11-05" }]).C, "full");
});

test("an invalid registry is refused before any connection or catalog write", async () => {
  const { run_extract } = require("../load");
  const calls = [];
  const db = new Proxy({}, { get: (_, k) => (...a) => { calls.push(k); throw new Error("db touched"); } });
  for (const mode of ["rehearse", "apply"]) {
    await assert.rejects(run_extract(db, { mode, check: () => ["x.bad: MRI keys must start with mri."] }), /invalid MRI rule registry, nothing written: x\.bad/);
  }
  assert.deepStrictEqual(calls, []);
  const bad_key = { ...named[2], key: "cv.exam_started" };
  assert.ok(validate([error_rule, bad_key], [bad_key]).some((e) => /must start with mri\./.test(e)));
  const overlap = { ...named[2], key: "mri.other", codes: { 2227566: () => "" } };
  assert.ok(validate([...rules, overlap], [...named, overlap]).some((e) => /code 2227566 also in mri\.system_up/.test(e)));
  const bad_group = { ...named[2], key: "mri.x", group: "noise" };
  assert.ok(validate([...rules, bad_group], [...named, bad_group]).some((e) => /bad group noise/.test(e)));
});

test("C1-MRI interlock: --apply needs every CT verifier to declare MRI_AWARE", () => {
  assert.deepStrictEqual(ct_verifiers_not_mri_aware(() => ({ MRI_AWARE: true })), []);
  assert.strictEqual(ct_verifiers_not_mri_aware(() => ({ CV_AWARE: true })).length, 3, "CV_AWARE alone is not enough");
  assert.strictEqual(ct_verifiers_not_mri_aware(() => ({ MRI_AWARE: "yes" })).length, 3, "only the boolean true counts");
  // Today (before the C1-MRI CT change) the real CT verifiers are not MRI-aware, so --apply is refused.
  // The C1-MRI change updates this assertion.
  assert.deepStrictEqual(ct_verifiers_not_mri_aware(), ["../verify_facts", "../derive/verify", "../findings/verify"]);
});

test("independent SQL covers exactly the registry and pins every named code", () => {
  assert.deepStrictEqual(Object.keys(COND).sort(), rules.map((r) => r.key).sort());
  for (const n of named) for (const c of Object.keys(n.codes)) assert.ok(COND[n.key].includes(c), `${n.key}: code ${c} not in the SQL`);
  assert.match(RECONCILE_SQL, /DISTINCT ON \(system_id, epoch, record_number_concurrent\)/);
  assert.match(RECONCILE_SQL, /ORDER BY system_id, epoch, record_number_concurrent, id/);
  assert.match(COVERAGE_SQL, /unstorable/);
  assert.match(CONFLICTS_SQL, /HAVING count\(DISTINCT md5/);
  assert.match(COND["mri.process_death"], /<> 'dsserver'/);
  assert.match(ROW_COLUMNS, /\bmessage_number\b.*\btype\b.*\bmessage\b.*\bcoil\b.*\bpsd\b/);
  assert.match(BATCH_SQL, /FROM log\.ge_mri_gesys/);
  assert.deepStrictEqual(compare([{ system_id: "A", key: "k", n: 2 }], [{ system_id: "A", key: "k", n: "2" }, { system_id: "B", key: "k", n: 1 }]),
    { cells: 2, diffs: [{ k: "B|k", facts: 0, sql: 1 }] });
  assert.deepStrictEqual(unreviewed([2218650, 1]), [1]);
});

test("cli flags", () => {
  assert.deepStrictEqual(args(["dry-run"]).cmd, "dry-run");
  assert.strictEqual(args(["dry-run", "--to-id", "5"]).to_id, 5);
  assert.strictEqual(args(["backfill", "--rehearse", "--batches", "2"]).batches, 2);
  assert.strictEqual(args(["backfill", "--apply", "--from-id", "3"]).from_id, 3);
  assert.throws(() => args(["backfill"]), /exactly one/);
  assert.throws(() => args(["backfill", "--rehearse", "--apply"]), /exactly one/);
  assert.throws(() => args(["backfill", "--rehearse", "--to-id", "1"]), /only --batches/);
  assert.throws(() => args(["backfill", "--apply", "--batches", "1"]), /only for --rehearse/);
  assert.throws(() => args(["verify", "--to-id", "1"]), /no flags/);
  assert.throws(() => args(["dry-run", "--apply"]), /only --to-id/);
  assert.throws(() => args(["no-such-command"]), /usage/); // `findings` exists since MRI-4 (findings.test.js has its flags)
  assert.throws(() => args(["dry-run", "--to-id", "x"]), /non-negative integer/);
});

test("confirm: the database name before a rehearsal; the name and APPLY before an apply", async () => {
  const db = { one: async () => ({ db: "hhm_x", usr: "insight_writer" }) };
  const run = async (mode, lines) => {
    const input = new PassThrough();
    const p = confirm(db, { mode, input, out: () => {} });
    for (const l of lines) input.write(`${l}\n`);
    input.end();
    return p;
  };
  await run("rehearse", ["hhm_x"]);
  await assert.rejects(run("rehearse", ["prod"]), /mismatch/);
  await run("apply", ["hhm_x", "APPLY"]);
  await assert.rejects(run("apply", ["hhm_x", "yes"]), /not confirmed/);
  await assert.rejects(run("apply", ["hhm_x"]), /no input/);
});

test("fixture masker: hosts on word boundaries only, system ids, MAC, IP, UDI, AE titles", () => {
  const { mask, leaks } = masker(["mrhost1", "abc"]);
  assert.strictEqual(mask("push failed: PACSAE could not perform on MRHOST1 and abcd"), "push failed: AE could not perform on HOST and abcd");
  assert.strictEqual(mask("VRE (00:10:E0:35:C9:58[icn1]) at 10.1.2.3 SME02582 udi=00840682122436"), "VRE (00:00:00:00:00:00[icn1]) at 0.0.0.0 SME0 udi=0");
  assert.strictEqual(mask("Association was rejected from SITEAE."), "Association was rejected from AE.");
  assert.deepStrictEqual(leaks("x mrhost1 y"), ["mrhost1"]);
  assert.strictEqual(mask(null), null);
});

// A require of insight/mri in any form: "./mri", "../mri/x", "./insight/mri".
const MRI_REQUIRE = /require\(\s*["'`][^"'`]*\bmri(\/[^"'`]*)?["'`]\s*\)/g;

test("isolation: nothing outside insight/mri loads it (the GE CT and CV runs are unchanged)", () => {
  const files = [path.join(INSIGHT, "..", "index.js")];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) { if (p !== MRI && e.name !== "node_modules") walk(p); } else if (e.name.endsWith(".js")) files.push(p);
  } };
  walk(INSIGHT);
  assert.ok(files.some((f) => f.includes(`${path.sep}cv${path.sep}`)) && files.length > 40, "walked CT's and CV's insight/ files and index.js");
  for (const f of files) assert.deepStrictEqual(fs.readFileSync(f, "utf8").match(MRI_REQUIRE), null, path.relative(INSIGHT, f));
  for (const ok of ['require("./mri")', "require('../mri/load')", 'require("./insight/mri")', 'require( "./insight/mri/cli" )']) assert.ok(ok.match(MRI_REQUIRE), ok);
  for (const no of ['require("./mrix")', 'require("./derive/mris")', 'require("./smri")']) assert.strictEqual(no.match(MRI_REQUIRE), null, no);
});

test("isolation: insight/mri reads shared modules but never CV's", () => {
  const files = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p); else if (e.name.endsWith(".js")) files.push(p);
  } };
  walk(MRI);
  for (const f of files) assert.doesNotMatch(fs.readFileSync(f, "utf8"), /require\(\s*["'`][^"'`]*\bcv(\/[^"'`]*)?["'`]\s*\)/, path.relative(MRI, f));
});

test("review MRI2-EXTRACT P2-1: a late copy with different content refuses the run and records status error", async () => {
  const base = { system_id: "SME1", epoch: 1794565394, record_number_concurrent: 0, type: "h\tscn", host_datetime: new Date("2026-11-13T15:23:14Z"), capture_datetime: new Date("2026-11-13T16:00:00Z") };
  const stored = { ...base, id: "10", message_number: 2218714, message: "New Exam Started" };
  const late = { ...base, id: "9", message_number: 2218714, message: "New Exam Started (other)" };
  const crypto = require("crypto");
  const md5 = (r) => crypto.createHash("md5").update([r.message_number, r.type, r.message].join("\u001f")).digest("hex");
  const jobs = [];
  const calls = [];
  const conn = {
    tx: async (f) => f(conn),
    none: async (sql, p) => { if (/insight\.job_state/.test(sql)) jobs.push(p); else calls.push("none"); },
    one: async () => ({}),
    any: async (sql) => {
      if (sql === LATE_SQL) return [late];
      if (sql === EXISTING_SQL) return [{ system_id: "SME1", epoch: base.epoch, record_number_concurrent: 0, source_id: "10", ident: md5(stored) }];
      calls.push(sql.slice(0, 40));
      return [];
    },
  };
  const job = { watermark_id: "20", watermark_capture_datetime: new Date("2026-11-13T16:30:00Z") };
  const stats = { batches: 0 };
  await assert.rejects(apply_range(conn, { job, start: 20, end: 20, run_id: "r", started_at: new Date(), stats }),
    /natural-key conflict in late re-read .*"ids":\["10","9"\]/);
  assert.strictEqual(jobs.length, 1, "the error was recorded");
  assert.strictEqual(jobs[0][5], "error");
  assert.strictEqual(jobs[0][1], 20, "the watermark is unchanged");
  assert.ok(!calls.some((c) => /insert into "insight"\."ge_mri_facts"/i.test(c)), "no facts written");
  // an identical late copy is a known duplicate: nothing to refuse
  const same = { ...late, message: stored.message };
  conn.any = async (sql) => (sql === LATE_SQL ? [same] : sql === EXISTING_SQL ? [{ system_id: "SME1", epoch: base.epoch, record_number_concurrent: 0, source_id: "10", ident: md5(stored) }] : []);
  const ok_stats = { batches: 0 };
  await apply_range(conn, { job, start: 20, end: 20, run_id: "r", started_at: new Date(), stats: ok_stats });
  assert.deepStrictEqual([ok_stats.late.records, ok_stats.late.duplicates, ok_stats.late.inserted], [0, 1, 0]);
});

test("review MRI2-EXTRACT P2-2: verify fails on facts not at the registry version; a complete replay prunes them", () => {
  const v = (metric_key, rule_version, n = 5) => ({ metric_key, rule_version, n });
  assert.deepStrictEqual(stale_versions([v("mri.error", 1), v("mri.system_up", 1)]), []);
  const bumped = rules.map((r) => (r.key === "mri.system_up" ? { ...r, version: 2 } : r));
  assert.deepStrictEqual(stale_versions([v("mri.error", 1), v("mri.system_up", 1, 3), v("mri.system_up", 2, 7)], bumped),
    [{ metric_key: "mri.system_up", rule_version: 1, registry: 2, n: 3 }]);
  assert.deepStrictEqual(stale_versions([v("mri.gone", 1)]), [{ metric_key: "mri.gone", rule_version: 1, registry: null, n: 5 }]);
  // only a complete replay (from id 0, every batch, to the current end) prunes
  assert.strictEqual(is_full_replay({ from_id: 0, to_id: null, max_batches: null }), true);
  for (const o of [{ from_id: null, to_id: null }, { from_id: 0, to_id: 100 }, { from_id: 0, to_id: null, max_batches: 2 }, { from_id: 5, to_id: null }]) {
    assert.strictEqual(is_full_replay({ max_batches: null, ...o }), false, JSON.stringify(o));
  }
  assert.match(PRUNE_SQL, /DELETE FROM insight\.ge_mri_facts f USING v\s+WHERE f\.metric_key = v\.metric_key AND f\.rule_version < v\.version/);
});

