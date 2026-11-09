"use strict";
// node insight/cv/test/derive.test.js   (no DB needed)
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { template, readable, mode, build_codes, DAILY_FULL, DAILY_DAYS, CODES_ROWS_SQL, LABEL_MAX } = require("../derive");
const { TPL, READABLE, A_SRC, B_SRC, D_SRC, diff_cells, diff_codes } = require("../verify_derive");
const { args } = require("../cli");

test("template masks numbers and hex, trims GE's quote / dash framing, keeps words", () => {
  assert.strictEqual(template("  - LIFT COLLISION (T:0x4A12 H:0x4 U:0x0000)."), "LIFT COLLISION (T:0x# H:0x# U:0x#).");
  assert.strictEqual(template("\" - ANTICOLLISION CINEMATIC ERROR (0x4B10 HW:0x0009 & US:0x8000), speed error on table lat\""),
    "ANTICOLLISION CINEMATIC ERROR (0x# HW:0x# & US:0x#), speed error on table lat");
  assert.strictEqual(template(" [FPGA_Driver::update] Detector com error: CDetectorImpl::scanModeDm Ack error - Expected: 4080 - FEC28000 - Received: FFFF - 0"),
    "[FPGA_Driver::update] Detector com error: CDetectorImpl::scanModeDm Ack error - Expected: # - # - Received: FFFF - #");
  assert.strictEqual(template("  - COLLISION SENSOR ACTIVATED. CLEAR AND TRY AGAIN (4AE6)."), "COLLISION SENSOR ACTIVATED. CLEAR AND TRY AGAIN (#).");
  assert.strictEqual(template("\"Internal Error, 1206 : BROWSER_NETWORK_FAILED\""), "Internal Error, # : BROWSER_NETWORK_FAILED");
  assert.strictEqual(template("mean value for offset [17, 2] = 0.000000, is outside [500-2500] limits"), "mean value for offset [#, #] = #.#, is outside [#-#] limits");
  assert.strictEqual(template("DC power ACE BAD"), "DC power ACE BAD", "hex-looking words without a digit stay");
  assert.strictEqual(template("x".repeat(500)).length, LABEL_MAX);
  assert.strictEqual(template(null), "");
});

test("non-ASCII becomes '?' per code point before templating, so JS and SQL cut and match alike (review CV3-DERIVE P3)", () => {
  const { ascii } = require("../derive");
  assert.strictEqual(ascii("Ünïcode 😀 ok"), "?n?code ? ok");
  assert.strictEqual(template("  - Ünïcode 😀 error 12"), "?n?code ? error #");
  const edge = template("a".repeat(LABEL_MAX - 1) + "😀tail");
  assert.strictEqual(edge.length, LABEL_MAX);
  assert.ok(edge.endsWith("a?"), "an astral character at the cut is one '?', never half a surrogate pair");
  assert.strictEqual(template("x\u00a0y"), "x?y", "a non-breaking space is not a JS-only space");
});

test("readable: GE's '(null)' relay text and number-only text are not labels", () => {
  assert.ok(!readable(" (null)"));
  assert.ok(!readable("\" - (null) \""));
  assert.ok(!readable("0x12 34"));
  assert.ok(!readable(null));
  assert.ok(readable("  - PIB : COM Reset"));
});

test("mode: most frequent, ties to the smallest (as SQL COLLATE \"C\")", () => {
  assert.deepStrictEqual(mode(new Map([["b", 2], ["a", 2], ["c", 1]])), ["a", 2]);
  assert.deepStrictEqual(mode(new Map([["B", 1], ["a", 1]])), ["B", 1], "code-unit order: uppercase first");
  assert.strictEqual(mode(new Map()), null);
});

test("build_codes: counts, systems, first / last, modes, label share; unreadable codes get no label", () => {
  const r = (o) => ({ errorcode: 1050297, system_id: "A", host_datetime: new Date("2026-11-01T00:00:00Z"), subsystem: "POS", sourcefile: "pos.c", debugtext: "  - Emergency backout has been pressed.", ...o });
  const codes = build_codes([
    r({}), r({ system_id: "B", host_datetime: new Date("2026-11-03T00:00:00Z") }), r({ debugtext: "  - Emergency backout has been released." }),
    r({ debugtext: " (null)", host_datetime: new Date("2026-10-30T00:00:00Z") }),
    r({ errorcode: 2800006, debugtext: " (null)", subsystem: "DL", sourcefile: null }),
  ]);
  assert.deepStrictEqual(codes.map((c) => c.errorcode), [1050297, 2800006]);
  const c = codes[0];
  assert.deepStrictEqual([c.n, c.systems, c.subsystem, c.sourcefile, c.label, c.label_share],
    [4, 2, "POS", "pos.c", "Emergency backout has been pressed.", 0.5]);
  assert.deepStrictEqual([c.first_seen.toISOString(), c.last_seen.toISOString()], ["2026-10-30T00:00:00.000Z", "2026-11-03T00:00:00.000Z"]);
  assert.deepStrictEqual([codes[1].label, codes[1].label_share, codes[1].sourcefile], [null, null, null]);
});

test("daily SQL: full = delete + rebuild of one system; days = the same, limited to the given days by a range join", () => {
  assert.match(DAILY_FULL[0], /^DELETE FROM insight\.ge_cv_daily WHERE system_id = \$1$/);
  assert.match(DAILY_FULL[1], /WHERE f\.system_id = \$1 GROUP BY 1, 2, 3, 4$/);
  assert.match(DAILY_DAYS[0], /local_day = ANY\(\$2::date\[\]\)/);
  assert.match(DAILY_DAYS[1], /f\.host_local >= d\.day AND f\.host_local < d\.day \+ 1/);
  for (const q of [...DAILY_FULL, ...DAILY_DAYS]) assert.doesNotMatch(q, /ge_ct_|metric_catalog|findings/);
  assert.match(CODES_ROWS_SQL, /LEFT JOIN log\.ge_cv_syserror s ON s\.id = f\.source_id AND s\.capture_datetime = f\.source_capture_datetime/);
});

test("the SQL template is written separately (regexes, chr(1) placeholder, COLLATE \"C\" ties), and no SQL reads encoded fields", () => {
  assert.match(TPL, /\\m\(\?=\[0-9A-F\]\*\[0-9\]\)\[0-9A-F\]\{2,8\}\\M/);
  assert.match(TPL, /chr\(1\), '0x#'\), 200\)/);
  assert.match(TPL, /regexp_replace\(da,/, "the SQL template runs on the ASCII-normalized text");
  assert.match(D_SRC, /regexp_replace\(d, '\[\^\\x01-\\x7f\]', '\?', 'g'\) AS da/);
  assert.match(READABLE, /\\\(null\\\)/);
  assert.match(D_SRC, /ORDER BY errorcode, c DESC, tpl COLLATE "C"/);
  for (const q of [A_SRC, B_SRC, D_SRC, CODES_ROWS_SQL]) assert.doesNotMatch(q, /\b(errortext|fru|majorfunction|minorfunction)\b/i);
  assert.match(A_SRC, /NOT coalesce\(btrim\(subsystem\) = 'RTA' AND sourcefile = 'XRImChainPos', false\)/);
});

test("diff helpers find missing, extra and changed cells / codes", () => {
  const d = diff_cells([{ system_id: "A", day: "d1", key: "k", n: 2 }], [{ system_id: "A", day: "d1", key: "k", n: 3 }, { system_id: "A", day: "d2", key: "k", n: 1 }]);
  assert.deepStrictEqual([d.cells, d.diffs], [2, 2]);
  const base = { errorcode: 1, subsystem: "POS", label: "x", label_share: 1 / 3, sourcefile: "f", n: 3, systems: 1, first_seen: "2026-11-01T00:00:00Z", last_seen: "2026-11-02T00:00:00Z" };
  assert.strictEqual(diff_codes([base], [{ ...base, label_share: 0.333333333333333 }]).diffs, 0);
  assert.strictEqual(diff_codes([base], [{ ...base, label: "y" }]).diffs, 1);
  assert.strictEqual(diff_codes([], [base]).diffs, 1);
});

test("cli: derive flags", () => {
  assert.strictEqual(args(["derive", "--apply", "--full"]).full, true);
  assert.throws(() => args(["derive"]), /exactly one/);
  assert.throws(() => args(["derive", "--rehearse", "--full"]), /only for derive --apply/);
  assert.throws(() => args(["derive", "--apply", "--batches", "1"]), /only --full/);
  assert.throws(() => args(["verify-derive", "--apply"]), /no flags/);
});
