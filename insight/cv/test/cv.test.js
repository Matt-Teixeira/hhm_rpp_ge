"use strict";
// node insight/cv/test/cv.test.js   (no DB needed)
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { rules, named, ignore, classify, validate, cv_catalog_rows, NAMED_KEYS, MAX_FACTS_PER_ROW, norm } = require("../rules");
const { build_facts, host_local_of, skip_reason, ROW_COLUMNS, BATCH_SQL } = require("../extract");
const { dedupe_facts, upsert_statements, merge_pending, unreviewed, ct_verifiers_not_cv_aware, LATE_SQL, CHUNK, PENDING_FULL_DAYS } = require("../load");
const { COND, RECONCILE_SQL, COVERAGE_SQL, REPEATS_SQL } = require("../reconcile_sql");
const { REVIEWED_CODES } = require("../codes_reviewed");
const { args } = require("../cli");
const { SQL: FIXTURE_SQL } = require("../tools/build_fixtures");

const FIX = path.join(__dirname, "..", "__fixtures__");
const INSIGHT = path.join(__dirname, "..", "..");
const row = (o = {}) => ({ id: "1", errorcode: 1050999, subsystem: "POS", debugtext: "  - something", sourcefile: "x.cpp", repeatcount: 0, sourceline: 10, ...o });
const keys = (r) => { const c = classify(r); return c.ignore ? `ignore.${c.ignore}` : c.facts.map((f) => `${f.metric_key}:${f.dim}`).sort().join(","); };
const named_of = (r) => classify(r).facts.filter((f) => f.metric_key !== "cv.error");

test("registry: valid, cv.* only, disjoint code lists, every named code reviewed, internal catalog", () => {
  assert.deepStrictEqual(validate(), []);
  assert.deepStrictEqual(rules.map((r) => r.key), ["cv.error", ...NAMED_KEYS]);
  assert.strictEqual(NAMED_KEYS.length, 8, "M1: cv.error + 8 named metrics");
  assert.ok(NAMED_KEYS.includes("cv.worklist_query_failed") && !NAMED_KEYS.some((k) => /network/.test(k)), "M2 name");
  for (const k of ["cv.detector_offset_out_of_range", "cv.positioner_reset", "cv.positioner_boot", "cv.collimator_comm_failure", "cv.positioner_link_lost"]) {
    assert.ok(!NAMED_KEYS.includes(k), `M3: candidate ${k} is not in v1`);
  }
  const cat = cv_catalog_rows();
  assert.strictEqual(cat.length, rules.length);
  assert.ok(cat.every((c) => c.metric_key.startsWith("cv.") && c.customer_visible === false && c.value_kind === "event"));
  assert.strictEqual(cat.find((c) => c.metric_key === "cv.dose_export_rejected").category, "compliance");
  for (const n of named) for (const c of n.codes) assert.ok(REVIEWED_CODES.has(c), `${n.key} code ${c} not reviewed`);
  assert.strictEqual(REVIEWED_CODES.size, 204);
  assert.deepStrictEqual(ignore.map((i) => i.key), ["rta_relay"]);
});

// Fixtures are labelled by the independent SQL (tools/build_fixtures.js).
test("every real fixture gives exactly its labelled facts", () => {
  const files = fs.readdirSync(FIX).filter((f) => f.endsWith(".json"));
  for (const k of [...rules.map((r) => r.key), "ignore.rta_relay"]) assert.ok(files.includes(`${k}.json`), `no fixture for ${k}`);
  let n = 0;
  for (const f of files) {
    const label = f.replace(/\.json$/, "");
    for (const s of JSON.parse(fs.readFileSync(path.join(FIX, f), "utf8"))) {
      n++;
      const c = classify(s);
      assert.deepStrictEqual(c.errors, [], `${label}: rule error`);
      if (label === "ignore.rta_relay") { assert.strictEqual(c.ignore, "rta_relay", JSON.stringify(s)); continue; }
      const got = c.facts.map((x) => x.metric_key).sort();
      const want = label === "cv.error" ? ["cv.error"] : ["cv.error", label].sort();
      assert.deepStrictEqual(got, want, `${label}: ${s.errorcode} ${JSON.stringify(s.debugtext).slice(0, 120)}`);
      assert.strictEqual(c.facts.find((x) => x.metric_key === "cv.error").dim, String(s.errorcode));
    }
  }
  assert.ok(n >= 60, `only ${n} fixture samples`);
});

test("relay: subsystem RTA (trimmed) AND source file XRImChainPos; nothing else is ignored", () => {
  assert.strictEqual(keys(row({ subsystem: "RTA ", sourcefile: "XRImChainPos", debugtext: " (null)" })), "ignore.rta_relay");
  assert.strictEqual(keys(row({ subsystem: "RTA", sourcefile: "fpga_driver.cpp" })), "cv.error:1050999");
  assert.strictEqual(keys(row({ subsystem: "POS", sourcefile: "XRImChainPos" })), "cv.error:1050999");
  // a relayed collision is not a second collision
  assert.strictEqual(keys(row({ errorcode: 1050168, subsystem: "RTA", sourcefile: "XRImChainPos", debugtext: "  - LIFT COLLISION (T:0x4A12)." })), "ignore.rta_relay");
});

test("one event logged twice is counted once; look-alikes stay in cv.error only", () => {
  assert.deepStrictEqual(named_of(row({ errorcode: 1050297, debugtext: "  - Emergency backout has been pressed." })).map((f) => f.metric_key), ["cv.emergency_backout"]);
  assert.deepStrictEqual(named_of(row({ errorcode: 1050297, debugtext: "  - Emergency backout has been released." })), []);
  assert.deepStrictEqual(named_of(row({ errorcode: 1050297, debugtext: "  - Rack has been resetted for a PIB loss of communication." })), []);
  assert.deepStrictEqual(named_of(row({ errorcode: 1050024, debugtext: "  - PIB : COM Reset" })).map((f) => f.dim), ["reset"]);
  assert.deepStrictEqual(named_of(row({ errorcode: 1050024, debugtext: "  - PIB : COM Fail" })).map((f) => f.dim), ["fail"]);
  assert.deepStrictEqual(named_of(row({ errorcode: 1050167, debugtext: "  - COLLISION SENSOR ACTIVATED. CLEAR AND TRY AGAIN (4AE6)." })), []);
  assert.deepStrictEqual(named_of(row({ errorcode: 1050305, debugtext: "  - TUBE COLLISION NOT CLEARED. CONTINUE WITH CAUTION" })), []);
  assert.deepStrictEqual(named_of(row({ errorcode: 1050015, debugtext: "  - potentiometerEncoderMismatch" })), []);
  // the right text under the wrong code is not a named fact
  assert.deepStrictEqual(named_of(row({ errorcode: 1050170, debugtext: "  - LIFT COLLISION (T:0x4A12)." })), []);
  assert.deepStrictEqual(named_of(row({ errorcode: 1050999, debugtext: "  - Emergency backout has been pressed." })), []);
});

test("dims: detector operation, collision part, anticollision axis, encoder axis, worklist kind", () => {
  const dim = (r) => named_of(r).map((f) => `${f.metric_key}:${f.dim}`)[0];
  assert.strictEqual(dim(row({ errorcode: 1200014, debugtext: " [FPGA_Driver::update] Detector com error: CDetectorImpl::scanSetupDm Ack error - Expected: 4020" })), "cv.detector_com_error:scanSetupDm");
  assert.strictEqual(dim(row({ errorcode: 1200114, debugtext: "\"[FPGA_Driver::update] Detector com error: CDetectorDipb::waitRxCommandDm RX read timeout\"" })), "cv.detector_com_error:waitRxCommandDm");
  assert.strictEqual(dim(row({ errorcode: 1050170, debugtext: "  - COLLIMATOR COLLISION (T:0x4A13)." })), "cv.positioner_collision:collimator");
  assert.strictEqual(dim(row({ errorcode: 1050302, debugtext: "\" - ANTICOLLISION CINEMATIC ERROR (0x4B10 HW:0x0009 & US:0x8000), speed error on table lat\"" })), "cv.anticollision_error:table_lat");
  assert.strictEqual(dim(row({ errorcode: 1050177, debugtext: "  - Anticollision error on axis Front L-Arm in motion state 3" })), "cv.anticollision_error:front_l_arm");
  assert.strictEqual(dim(row({ errorcode: 1050710 })), "cv.table_encoder_failure:lateral");
  assert.strictEqual(dim(row({ errorcode: 1050187 })), "cv.table_encoder_failure:rotation");
  assert.strictEqual(dim(row({ errorcode: 2800036, debugtext: "\", 1206 : BROWSER_NETWORK_FAILED\"" })), "cv.worklist_query_failed:network_failed");
  assert.strictEqual(dim(row({ errorcode: 2800175, debugtext: "\"Association timeout, 1207 : BROWSER_WL_QUERY_FAILED\"" })), "cv.worklist_query_failed:wl_query_failed");
  assert.strictEqual(norm(" C_Arc "), "c_arc");
});

test("cv.error carries repeatcount as an attribute only (a running index, never summed)", () => {
  const f = classify(row({ repeatcount: 41 })).facts[0];
  assert.deepStrictEqual([f.metric_key, f.value_num, f.attrs], ["cv.error", null, { repeatcount: 41, sourcefile: "x.cpp", sourceline: 10 }]);
});

test("build_facts: keys and source on every fact, ignored and skipped counted, at most 2 facts per row", () => {
  const ok = { system_id: "SME1", sequencenumber: 7, host_date: "2026-11-01", host_time: "01:30:00.250", host_datetime: new Date("2026-11-01T08:30:00.250Z"), capture_datetime: new Date("2026-11-01T09:18:00Z") };
  const rows = [
    row({ ...ok, id: "10", errorcode: 1050297, debugtext: "  - Emergency backout has been pressed." }),
    row({ ...ok, id: "11", subsystem: "RTA", sourcefile: "XRImChainPos" }),
    row({ ...ok, id: "12", host_time: "garbage" }),
    row({ ...ok, id: "13", host_datetime: null }),
    row({ ...ok, id: "14", errorcode: 2800176, debugtext: "Association rejected" }),
  ];
  const b = build_facts(rows);
  assert.deepStrictEqual(b.ignored, { rta_relay: 1 });
  assert.strictEqual(b.skipped.no_host_local, 1);
  assert.strictEqual(b.skipped.no_host_datetime, 1);
  assert.deepStrictEqual(b.facts.map((f) => `${f.source_id}:${f.metric_key}`), ["10:cv.error", "10:cv.emergency_backout", "14:cv.error", "14:cv.dose_export_rejected"]);
  const f = b.facts[0];
  assert.deepStrictEqual([f.system_id, f.sequencenumber, f.host_local, f.subsystem, f.errorcode], ["SME1", 7, "2026-11-01T01:30:00.250", "POS", 1050297]);
  assert.deepStrictEqual([...b.codes].sort(), [1050297, 2800176]);
  assert.ok(b.facts.length <= rows.length * MAX_FACTS_PER_ROW);
  assert.strictEqual(host_local_of({ host_date: "2026-11-01", host_time: " 23:59:59 " }), "2026-11-01T23:59:59");
  assert.strictEqual(skip_reason({ ...ok, errorcode: null }), "no_errorcode");
  assert.strictEqual(skip_reason({ ...ok, errorcode: 1, subsystem: "" }), "no_subsystem");
  assert.strictEqual(skip_reason({ ...ok, errorcode: 1, subsystem: "POS" }), null);
});

test("load SQL: source-key upsert gated on rule version, SQL NULL attrs, casts, chunking, dedupe", () => {
  const fact = (o = {}) => ({ system_id: "SME1", host_datetime: "2026-11-01T08:30:00.250Z", sequencenumber: 7, metric_key: "cv.error", host_local: "2026-11-01T01:30:00.250",
    errorcode: 1050297, subsystem: "POS", exceptioncategory: "DO", dim: "1050297", value_num: null, value_text: null, attrs: { repeatcount: 0 },
    source_id: "10", source_capture_datetime: "2026-11-01T09:18:00Z", rule_version: 1, ...o });
  const [q] = upsert_statements([fact(), fact({ metric_key: "cv.emergency_backout", dim: "", attrs: null })]);
  assert.match(q, /^\s*WITH up AS \(insert into "insight"\."ge_cv_facts"/i);
  assert.match(q, /ON CONFLICT ON CONSTRAINT ge_cv_facts_source_key DO UPDATE SET/);
  assert.match(q, /WHERE EXCLUDED\.rule_version > ge_cv_facts\.rule_version\s*RETURNING system_id, host_local\)/);
  assert.match(q, /null::jsonb/);
  assert.ok(!/'null'::jsonb/.test(q), "absent attrs must be SQL NULL");
  assert.match(q, /'2026-11-01T01:30:00\.250'::timestamp/);
  assert.strictEqual(upsert_statements(Array.from({ length: CHUNK + 1 }, (_, i) => fact({ source_id: String(i) }))).length, 2);
  const d = dedupe_facts([fact(), fact({ value_text: "x" }), fact({ metric_key: "cv.emergency_backout" })]);
  assert.deepStrictEqual([d.unique.length, d.collisions], [2, 1]);
  // two different source rows with the same device time and sequence (the P2 case) are both kept
  assert.strictEqual(dedupe_facts([fact({ source_id: "10" }), fact({ source_id: "11" })]).unique.length, 2);
});

test("pending days merge, and switch to a full rebuild past the limit", () => {
  let p = merge_pending({}, [{ system_id: "A", day: "2026-11-02" }, { system_id: "A", day: "2026-11-01" }, { system_id: "B", day: "2026-11-01" }]);
  assert.deepStrictEqual(p, { A: ["2026-11-01", "2026-11-02"], B: ["2026-11-01"] });
  p = merge_pending(p, [{ system_id: "A", day: "2026-11-01" }]);
  assert.deepStrictEqual(p.A, ["2026-11-01", "2026-11-02"]);
  const many = Array.from({ length: PENDING_FULL_DAYS + 1 }, (_, i) => ({ system_id: "C", day: `2026-10-${String(i + 1).padStart(2, "0")}` }));
  p = merge_pending(p, many);
  assert.strictEqual(p.C, "full");
  assert.strictEqual(merge_pending(p, [{ system_id: "C", day: "2026-11-05" }]).C, "full");
});

test("an invalid registry is refused before any connection or catalog write (review CV2-EXTRACT P2)", async () => {
  const { run_extract } = require("../load");
  const calls = [];
  const db = new Proxy({}, { get: (_, k) => (...a) => { calls.push(k); throw new Error("db touched"); } });
  for (const mode of ["rehearse", "apply"]) {
    await assert.rejects(run_extract(db, { mode, check: () => ["x.bad: CV keys must start with cv."] }), /invalid CV rule registry, nothing written: x\.bad/);
  }
  assert.deepStrictEqual(calls, [], "the database was never touched");
  // validate() catches what the catalog write would otherwise commit
  const bad_key = { ...rules[1], key: "ct.detector_com_error" };
  assert.ok(validate([rules[0], bad_key], [bad_key]).some((e) => /must start with cv\./.test(e)));
  const overlap = { ...named[1], key: "cv.other", codes: [named[0].codes[0]] };
  assert.ok(validate([...rules, overlap], [...named, overlap]).some((e) => /also in cv\.detector_com_error/.test(e)));
  assert.deepStrictEqual(validate(), []);
});

test("C1 interlock: --apply needs every CT verifier to declare CV_AWARE", () => {
  assert.deepStrictEqual(ct_verifiers_not_cv_aware(() => ({ CV_AWARE: true })), []);
  assert.strictEqual(ct_verifiers_not_cv_aware(() => ({})).length, 3);
  // today (before the C1 change) the real CT modules are not CV-aware, so --apply is refused
  assert.strictEqual(ct_verifiers_not_cv_aware().length, 3);
});

test("independent SQL covers exactly the registry, pins every named code, and excludes relays", () => {
  assert.deepStrictEqual(Object.keys(COND).sort(), rules.map((r) => r.key).sort());
  for (const n of named) for (const c of n.codes) assert.match(COND[n.key], new RegExp(`\\b${c}\\b`), `${n.key}: ${c} missing from the SQL`);
  assert.match(RECONCILE_SQL, /NOT coalesce\(btrim\(subsystem\) = 'RTA' AND sourcefile = 'XRImChainPos', false\)/);
  assert.deepStrictEqual(unreviewed([1050297, 9999999, 1]), [1, 9999999]);
});

test("no SQL reads GE's encoded fields", () => {
  for (const [name, sql] of Object.entries({ ROW_COLUMNS, BATCH_SQL, LATE_SQL, RECONCILE_SQL, COVERAGE_SQL, REPEATS_SQL, FIXTURE_SQL })) {
    assert.doesNotMatch(sql, /\b(errortext|fru|majorfunction|minorfunction)\b/i, name);
    assert.doesNotMatch(sql, /\bSELECT\s+\*/i, name);
  }
});

test("cli flags", () => {
  assert.strictEqual(args(["backfill", "--rehearse", "--batches", "1"]).batches, 1);
  assert.throws(() => args(["backfill"]), /exactly one/);
  assert.throws(() => args(["backfill", "--rehearse", "--from-id", "5"]), /only --batches/);
  assert.throws(() => args(["backfill", "--apply", "--batches", "1"]), /only for --rehearse/);
  assert.throws(() => args(["verify", "--to-id", "5"]), /takes/);
  assert.throws(() => args(["dry-run", "--to-id"]), /integer/);
  assert.throws(() => args(["report"]), /usage/);
});

test("isolation: nothing outside insight/cv loads it (the GE CT run is unchanged)", () => {
  const files = [path.join(INSIGHT, "..", "index.js")];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) { if (p !== path.join(INSIGHT, "cv") && e.name !== "node_modules") walk(p); } else if (e.name.endsWith(".js")) files.push(p);
  } };
  walk(INSIGHT);
  for (const f of files) assert.doesNotMatch(fs.readFileSync(f, "utf8"), /require\([^)]*\bcv\//, path.relative(INSIGHT, f));
});
