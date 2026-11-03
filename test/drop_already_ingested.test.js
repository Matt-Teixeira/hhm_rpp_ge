"use strict";
// node --test test/   (no DB needed; a fake db is injected)
const test = require("node:test");
const assert = require("node:assert");
const { drop_already_ingested, split_rows, record_key, host_range } = require("../persist/drop_already_ingested");

// Parsed rows look like mapDataToSchema output: strings, '' -> null.
const parsed = (o) => ({
  system_id: "SME1", epoch: "1793497918", record_number_concurrent: "0", sr: "553",
  type: "orp\torp_subsys", message: "\nPlenum ... Left: 2400\n", host_datetime: "2026-11-01T01:51:58.000-05:00", ...o,
});
// DB rows: ints for numeric columns.
const stored = (o) => ({ epoch: 1793497918, record_number_concurrent: 0, sr: 553, type: "orp\torp_subsys", message: "\nPlenum ... Left: 2400\n", ...o });

test("parsed strings match stored ints", () => {
  assert.strictEqual(record_key(parsed()), record_key(stored()));
});

test("null and undefined match; null does not match the string 'null' or ''", () => {
  assert.strictEqual(record_key(parsed({ message: null })), record_key(stored({ message: null })));
  assert.strictEqual(record_key(parsed({ message: undefined })), record_key(stored({ message: null })));
  assert.notStrictEqual(record_key(parsed({ message: "null" })), record_key(stored({ message: null })));
  assert.notStrictEqual(record_key(parsed({ message: "" })), record_key(stored({ message: null })));
});

test("DST fall-back: same epoch/rnc/sr but different content is kept", () => {
  const keys = new Set([record_key(stored())]);
  const second = parsed({ message: "\nPlenum ... Left: 2450\n" });
  const { fresh, dropped } = split_rows([parsed(), second], keys);
  assert.strictEqual(dropped, 1);
  assert.deepStrictEqual(fresh, [second]);
});

test("rows without host_datetime are never dropped", () => {
  const keys = new Set([record_key(stored())]);
  const { fresh, dropped } = split_rows([parsed({ host_datetime: null })], keys);
  assert.strictEqual(dropped, 0);
  assert.strictEqual(fresh.length, 1);
});

test("in-batch repeats are not collapsed (unchanged behaviour)", () => {
  const { fresh } = split_rows([parsed(), parsed()], new Set());
  assert.strictEqual(fresh.length, 2);
});

test("host_range spans min..max and ignores bad dates", () => {
  const r = host_range([parsed({ host_datetime: "2026-11-02T10:00:00Z" }), parsed({ host_datetime: "bad" }),
    parsed({ host_datetime: null }), parsed({ host_datetime: "2026-10-29T10:00:00Z" })]);
  assert.strictEqual(r.from.toISOString(), "2026-10-29T10:00:00.000Z");
  assert.strictEqual(r.to.toISOString(), "2026-11-02T10:00:00.000Z");
  assert.strictEqual(host_range([parsed({ host_datetime: null })]), null);
});

test("queries the system and batch span; drops what exists", async () => {
  const calls = [];
  const db = { any: async (sql, params) => { calls.push(params); return [stored()]; } };
  const rows = [parsed(), parsed({ record_number_concurrent: "1" })];
  const r = await drop_already_ingested(db, "SME1", rows);
  assert.strictEqual(r.dropped, 1);
  assert.strictEqual(r.fresh.length, 1);
  assert.strictEqual(r.fresh[0].record_number_concurrent, "1");
  assert.strictEqual(calls[0][0], "SME1");
});

test("fails open: on DB error every row is returned with the error", async () => {
  const db = { any: async () => { throw new Error("boom"); } };
  const rows = [parsed(), parsed()];
  const r = await drop_already_ingested(db, "SME1", rows);
  assert.strictEqual(r.fresh, rows);
  assert.strictEqual(r.dropped, 0);
  assert.match(r.error.message, /boom/);
});

test("empty input: no query, nothing dropped", async () => {
  const db = { any: async () => { throw new Error("should not query"); } };
  const r = await drop_already_ingested(db, "SME1", []);
  assert.deepStrictEqual(r.fresh, []);
  assert.strictEqual(r.error, null);
});
