"use strict";
// node insight/mri/test/derive.test.js   (no DB needed)
const test = require("node:test");
const assert = require("node:assert");
const { template, host_regex, ascii, LABEL_MAX } = require("../labels");
const { build_codes, mode, DAILY_FULL, DAILY_DAYS, CODES_ROWS_SQL } = require("../derive");
const { CATEGORY_CODES, CODE_CATEGORY, REVIEWED_CODES } = require("../codes_reviewed");
const { named } = require("../rules");
const { js_sw_sessions, js_service_sessions, js_deaths, js_inventory, same_rows, TPL_SQL, HOSTS_ALT, D_SRC, E_SQL } = require("../verify_derive");
const D = require("../derived_sql");
const { args } = require("../cli");

const re = host_regex(["mrhost1", "MRHOST10", "ab", "pacs-gw.local"]);

test("template: hosts (word boundaries, any case, longest first), MAC, IP, serial, hex, digits", () => {
  assert.strictEqual(template("Can't connect with mrhost1:IMSserver", re), "Can't connect with <host>:IMSserver");
  assert.strictEqual(template("MRHOST10 and mrhost1x and xmrhost1", re), "<host> and mrhost#x and xmrhost#", "not inside words");
  assert.strictEqual(template("from PACS-GW.LOCAL now", re), "from <host> now", "dots in host names are literal, any case");
  assert.strictEqual(template("ab is too short to be a host", re), "ab is too short to be a host");
  assert.strictEqual(template("VRE (00:10:E0:35:C9:58[icn1]) at 10.20.30.40 SERIAL=ABC123 code 0x1F2a pid 4711", re),
    "VRE (<mac>[icn#]) at <ip> SERIAL=<serial> code # pid #");
});

test("template: dates, AE titles, ARS line, host: prefix, JVM prefix", () => {
  assert.strictEqual(template("at Wed Nov 12 08:13:15 EST 2026 done"), "at <date> done");
  assert.strictEqual(template("Nov 12, 2026 8:13:15 AM x"), "<date> x");
  assert.strictEqual(template("Wed 11/12/2026 8:13:15.123 AM EST y"), "<date> y");
  assert.strictEqual(template("DICOM push failed: SITEPACS could not perform store"), "DICOM push failed: <ae> could not perform store");
  assert.strictEqual(template("Message received from WORKLIST1 - ok"), "Message received from <ae> - ok");
  assert.strictEqual(template("Operation timed out [SITE AE 1]"), "Operation timed out [<ae>]");
  assert.strictEqual(template("No Route to Site Archive. Retry"), "No Route to <ae>. Retry");
  assert.strictEqual(template("Network session creation for REMOTEAE failed"), "Network session creation for <ae> failed");
  assert.strictEqual(template("Association was rejected from SITEAE1."), "Association was rejected from <ae>.");
  // double spaces / line breaks around the title (the real shape of 11010, 11011, 600220200)
  assert.strictEqual(template("Association was rejected from  SITEAE1\n"), "Association was rejected from <ae>");
  assert.strictEqual(template("ECHO was received from\n SITEAE2"), "ECHO was received from <ae>");
  assert.strictEqual(template("push failed:  SITEPACS  could not perform the operation."), "push failed: <ae> could not perform the operation.");
  assert.strictEqual(template("call rejected by the remote host SOMEHOST"), "call rejected by the remote host <ae>");
  assert.strictEqual(template("Resetting ARS dev12 - build 4.5 more"), "Resetting ARS <device> - <build>");
  assert.strictEqual(template("Unable: HOST: srv-a1:port"), "Unable: host <host>:port");
  assert.strictEqual(template("Wed Nov 12 08:13:15 EST 2026 com.ge.med.x$Y INFO | started"), "started");
});

test("template: line breaks (real and literal), collapse, trim, ASCII, length", () => {
  assert.strictEqual(template("a\nb\r\nc\\nd\\re | | f |"), "a | b | c | d | e | f");
  assert.strictEqual(template("  | lead\t\ttabs  "), "lead tabs");
  assert.strictEqual(ascii("Ünï 😀"), "?n? ?");
  assert.strictEqual(template("Ünï 😀 7"), "?n? ? #");
  assert.strictEqual(template("x".repeat(500)).length, LABEL_MAX);
  assert.strictEqual(template(null), "");
  assert.strictEqual(template(" | \n "), "");
});

test("mode: most frequent, ties to the smallest (as SQL COLLATE \"C\")", () => {
  assert.deepStrictEqual(mode(new Map([["b", 2], ["a", 2], ["c", 1]])), ["a", 2]);
  assert.deepStrictEqual(mode(new Map([["B", 1], ["a", 1]])), ["B", 1]);
  assert.strictEqual(mode(new Map()), null);
});

test("build_codes: counts, systems, device first / last, process, reviewed category, label and share", () => {
  const r = (o) => ({ message_number: 2218714, system_id: "A", host_local: "2026-11-01T08:00:00", proc: "scn", message: "New Exam Started", ...o });
  const codes = build_codes([
    r({}), r({ system_id: "B", host_local: "2026-11-03T09:00:00" }), r({ message: "New Exam Started 2" }), r({ message: null, host_local: "2026-10-30T01:00:00", proc: null }),
    r({ message_number: 9999991, proc: null, message: "on mrhost1 x" }),
  ], ["mrhost1"]);
  assert.deepStrictEqual(codes.map((c) => c.message_number), [2218714, 9999991]);
  const c = codes[0];
  assert.deepStrictEqual([c.n, c.systems, c.process, c.category, c.label, c.label_share, c.first_seen, c.last_seen, c.rule_version],
    [4, 2, "scn", "utilization", "New Exam Started", 0.5, "2026-10-30T01:00:00", "2026-11-03T09:00:00", 2]);
  assert.deepStrictEqual([codes[1].process, codes[1].category, codes[1].label, codes[1].label_share], ["", null, null, null],
    "no process -> ''; an unreviewed (uncategorized) code -> no category and NO label (review MRI3-DERIVE P2-2)");
  // a long-tail code (reviewed as a group, no category) gets no label either, even with operator-like free text
  const [lt] = build_codes([r({ message_number: 2254012, message: "Dr Smith at Riverside said hi" })], []);
  assert.deepStrictEqual([lt.category, lt.label], [null, null]);
});

test("reviewed categories: 361 codes, the totals of PLAN-MRI-INSIGHTS-CODES.md §6, named codes in their rule's group", () => {
  assert.deepStrictEqual(Object.fromEntries(Object.entries(CATEGORY_CODES).map(([k, v]) => [k, v.length])),
    { utilization: 4, reliability: 117, hardware: 117, service: 31, inventory: 2, noise: 90 });
  assert.strictEqual(CODE_CATEGORY.size, 361, "disjoint lists");
  for (const c of CODE_CATEGORY.keys()) assert.ok(REVIEWED_CODES.has(c), `${c} not reviewed`);
  for (const n of named) for (const c of Object.keys(n.codes)) assert.strictEqual(CODE_CATEGORY.get(Number(c)), n.group, `${n.key} ${c}`);
  assert.strictEqual(CODE_CATEGORY.get(200002364), "reliability");
  assert.strictEqual(CODE_CATEGORY.get(2254012), undefined, "a long-tail code has no category");
});

test("daily SQL: device day and device times, value_last by device time then record number, range join for days", () => {
  for (const q of [DAILY_FULL[1], DAILY_DAYS[1]]) {
    assert.match(q, /f\.host_local::date AS local_day/);
    assert.match(q, /min\(f\.host_local\) AS first_at, max\(f\.host_local\) AS last_at/);
    assert.match(q, /ORDER BY f\.host_local DESC, f\.record_number_concurrent DESC, f\.id DESC/);
  }
  assert.match(DAILY_DAYS[1], /f\.host_local >= d\.day AND f\.host_local < d\.day \+ 1/);
  assert.match(CODES_ROWS_SQL, /LEFT JOIN log\.ge_mri_gesys s ON s\.id = f\.source_id AND s\.capture_datetime = f\.source_capture_datetime/);
  assert.match(CODES_ROWS_SQL, /WHERE f\.metric_key = 'mri\.error'/);
});

const ev = (system_id, t, metric_key, o = {}) => ({ system_id, t, rnc: 0, id: "1", metric_key, dim: "", value_num: null, attrs: null, ...o });

test("software sessions: ended by a stop or its companion, 'no_stop' when the next start comes first, 'open' at the end", () => {
  const s = js_sw_sessions([
    ev("A", "2026-11-01T08:00:00", "mri.sw_start"), ev("A", "2026-11-01T18:00:00", "mri.sw_stop"), ev("A", "2026-11-01T18:00:05", "mri.error", { dim: "200002364" }),
    ev("A", "2026-11-02T08:00:00", "mri.sw_start"), ev("A", "2026-11-02T09:00:00", "mri.sw_start"),
    ev("B", "2026-11-01T07:00:00", "mri.sw_stop"), ev("B", "2026-11-01T08:00:00", "mri.sw_start"), ev("B", "2026-11-01T08:30:00", "mri.error", { dim: "200002364" }),
  ]);
  assert.deepStrictEqual(s.map((x) => `${x.system_id} ${x.started_at.slice(11)} ${x.end_kind} ${x.duration_s}`).sort(), [
    "A 08:00:00 no_stop null", "A 08:00:00 stop 36000", "A 09:00:00 open null", "B 08:00:00 stop 1800"]);
  assert.match(D.SW_SESSIONS_SQL, /metric_key = 'mri\.error' AND dim = '200002364'/);
});

test("service sessions: from an 'on' not preceded by 'on' to the next 'off'", () => {
  const s = js_service_sessions([
    ev("A", "2026-11-01T08:00:00", "mri.service_mode", { dim: "on" }), ev("A", "2026-11-01T08:01:00", "mri.service_mode", { dim: "on" }),
    ev("A", "2026-11-01T08:05:00", "mri.service_mode", { dim: "off" }), ev("A", "2026-11-01T09:00:00", "mri.service_mode", { dim: "off" }),
    ev("A", "2026-11-01T10:00:00", "mri.service_mode", { dim: "on" }),
  ]);
  assert.deepStrictEqual(s.map((x) => [x.started_at.slice(11), x.end_kind, x.duration_s]), [["08:00:00", "off", 300], ["10:00:00", "open", null]]);
});

test("deaths: at_restart within ±10 device minutes (inclusive) of a start, stop, System Up or the stop companion", () => {
  const base = [ev("A", "2026-11-01T18:00:00", "mri.error", { dim: "200002364" }), ev("A", "2026-11-02T08:00:00", "mri.system_up")];
  const d = (t) => ev("A", t, "mri.process_death", { dim: "DHI" });
  const out = js_deaths([...base, d("2026-11-01T18:10:00"), d("2026-11-01T18:10:01"), d("2026-11-02T07:50:00"), d("2026-11-02T12:00:00")]);
  assert.deepStrictEqual(out.map((x) => x.at_restart), [true, false, true, false]);
  assert.strictEqual(D.RESTART_WINDOW_MIN, 10);
  assert.match(D.DEATHS_SQL, /BETWEEN d\.host_local - interval '10 minutes' AND d\.host_local \+ interval '10 minutes'/);
});

test("inventory: the latest System Up, when its version was first seen, versions and field strengths", () => {
  const up = (t, sw, fs, rnc = 0) => ev("A", t, "mri.system_up", { dim: sw, value_num: fs, rnc });
  const [inv] = js_inventory([up("2026-01-01T08:00:00", "V1", 1.5), up("2026-02-01T08:00:00", "V2", 1.5), up("2026-03-01T08:00:00", "V2", 1.5, 1), up("2026-03-01T08:00:00", "V2", 3, 0)]);
  assert.deepStrictEqual([inv.sw, inv.field_strength_t, inv.sw_first_seen, inv.sw_versions, inv.field_strengths_t, inv.system_ups, inv.last_up_at],
    ["V2", 1.5, "2026-02-01T08:00:00", 2, [1.5, 3], 4, "2026-03-01T08:00:00"]);
});

test("same_rows compares multisets over the given fields (review MRI3-DERIVE P2-1)", () => {
  assert.strictEqual(same_rows([{ a: 1, d_s: "5" }], [{ a: 1, d_s: 5 }], ["a", "d_s"]).diffs, 0);
  assert.strictEqual(same_rows([{ a: 1 }], [{ a: 2 }], ["a"]).diffs, 2);
  const twice = same_rows([{ a: 1 }, { a: 1 }], [{ a: 1 }], ["a"]);
  assert.deepStrictEqual([twice.diffs, twice.samples[0].sql, twice.samples[0].js], [1, 2, 1], "a row twice on one side, once on the other");
  assert.strictEqual(same_rows([{ a: 1 }, { a: 1 }], [{ a: 1 }, { a: 1 }], ["a"]).diffs, 0);
  // deaths keep one row per event: the code is part of the comparison
  const d = js_deaths([ev("A", "2026-11-01T10:00:00", "mri.process_death", { dim: "irm", message_number: 200002354 }),
    ev("A", "2026-11-01T10:00:00", "mri.process_death", { dim: "irm", message_number: 200002356 })]);
  assert.deepStrictEqual(d.map((x) => x.message_number), [200002354, 200002356]);
});

test("the SQL label rewrite: host match is case-insensitive, all JS steps present, no template leftovers", () => {
  assert.ok(!TPL_SQL.includes("${") && !HOSTS_ALT.includes("${"));
  assert.match(TPL_SQL, /'<host>', 'gi'/);
  assert.match(TPL_SQL, /'host <host>:', 'gi'/);
  for (const s of ["<mac>", "SERIAL=<serial>", "<ip>", "<date>", "push failed: <ae> could not perform", "Operation timed out [<ae>]", "No Route to <ae>.",
    "Network session creation for <ae>", "\\1 <ae>", "Resetting ARS <device> - <build>"]) assert.ok(TPL_SQL.includes(s), s);
  assert.strictEqual((TPL_SQL.match(/'<date>'/g) || []).length, 3);
  assert.match(TPL_SQL, /^nullif\(left\(/);
  assert.match(D_SRC, /ORDER BY message_number, c DESC, tpl COLLATE "C"/);
  assert.match(E_SQL, /label ~\* /);
  for (const k of ["digit", "serial", "ae", "unreviewed_labelled"]) assert.match(E_SQL, new RegExp(`AS ${k},`), `leak check ${k}`);
  assert.match(D_SRC, /CASE WHEN cat\.category IS NOT NULL THEN lab\.tpl END AS label/);
});

test("cli: derive and verify-derive flags", () => {
  assert.strictEqual(args(["derive", "--rehearse"]).rehearse, true);
  assert.strictEqual(args(["derive", "--apply", "--full"]).full, true);
  assert.throws(() => args(["derive"]), /exactly one/);
  assert.throws(() => args(["derive", "--rehearse", "--full"]), /only for derive --apply/);
  assert.throws(() => args(["derive", "--apply", "--to-id", "3"]), /only --full/);
  assert.throws(() => args(["verify-derive", "--apply"]), /no flags/);
  assert.throws(() => args(["backfill", "--apply", "--full"]), /only for derive --apply/);
});
