"use strict";
// node --test test/   (no DB / Redis needed)
const test = require("node:test");
const assert = require("node:assert");
const { drop_already_ingested_cv, split_rows, record_key, host_range, EXISTING_SQL } = require("../persist/drop_already_ingested_cv");

// A parsed + mapped row (strings, '' already mapped to null) and the same
// record as the DB returns it (every column ::text).
const parsed = {
  system_id: "SME08640", sequencenumber: "82", host_date: "2026-11-05", host_time: "18:20:53.103",
  subsystem: "POS", errorcode: "1050302", errortext: "U0ZaVzlIQjAwSllNNUdCJjBcUloqSUQwJ0FbVzRHQm8=",
  exam: "2222", exceptioncategory: "DO", application: "DEFAULT", majorfunction: "U0R2Zgx0by4LamQI",
  minorfunction: "U1BnbR1iNisWZGVpHGNybw==", fru: "U0JZXCdUWS08V0hNKlRZPXM=", viewinglevel: "1",
  rootcause: "0", repeatcount: "0",
  debugtext: '" - ANTICOLLISION CINEMATIC ERROR (0x4B10 HW:0x0009 & US:0x8000), speed error on table lat"',
  sourcefile: "Z:/heroic/anticol_task.c", sourceline: "7532",
  host_datetime: "2026-11-05T18:20:53.103-08:00", capture_datetime: "2026-11-06T02:18:03.871Z"
};
const stored = { ...parsed };
delete stored.system_id;
delete stored.host_datetime;
delete stored.capture_datetime;

test("a parsed row matches the same record read back from the table", () => {
  assert.strictEqual(record_key(parsed), record_key(stored));
});

test("integer columns match the way Postgres stores them; text columns exactly", () => {
  assert.strictEqual(record_key({ ...parsed, sourceline: "07532" }), record_key(stored));
  assert.strictEqual(record_key({ ...parsed, repeatcount: " 0" }), record_key(stored));
  assert.notStrictEqual(record_key({ ...parsed, debugtext: parsed.debugtext + " " }), record_key(stored));
  assert.notStrictEqual(record_key({ ...parsed, subsystem: "POS " }), record_key(stored));
});

test("the sequence number alone is not the key (it restarts in every file)", () => {
  // same sequence number, a different file: different time and code
  const other = { ...parsed, host_date: "2026-08-18", host_time: "13:21:31.854", errorcode: "2800176" };
  assert.notStrictEqual(record_key(other), record_key(stored));
});

test("null and empty are distinct", () => {
  assert.notStrictEqual(record_key({ ...parsed, debugtext: null }), record_key({ ...parsed, debugtext: "" }));
});

test("split_rows drops only stored records, and never rows without host_datetime", () => {
  const keys = new Set([record_key(stored)]);
  const fresh_row = { ...parsed, sequencenumber: "83", host_time: "18:21:03.377" };
  const no_dt = { ...parsed, host_datetime: null };
  const { fresh, dropped } = split_rows([parsed, fresh_row, no_dt], keys);
  assert.strictEqual(dropped, 1);
  assert.deepStrictEqual(fresh, [fresh_row, no_dt]);
});

test("host_range spans the batch even when device times are out of order", () => {
  const r = host_range([
    { host_datetime: "2026-11-05T18:20:53.103-08:00" },
    { host_datetime: "2026-11-05T18:20:40.000-08:00" }, // written later, stamped earlier
    { host_datetime: null },
    { host_datetime: "not a date" }
  ]);
  assert.strictEqual(r.from.toISOString(), "2026-11-06T02:20:40.000Z");
  assert.strictEqual(r.to.toISOString(), "2026-11-06T02:20:53.103Z");
  assert.strictEqual(host_range([{ host_datetime: null }]), null);
});

test("the lookup selects every key column as text from log.ge_cv_syserror", () => {
  assert.match(EXISTING_SQL, /FROM log\.ge_cv_syserror/);
  assert.match(EXISTING_SQL, /sequencenumber::text AS sequencenumber/);
  assert.match(EXISTING_SQL, /host_date::text AS host_date/);
});

test("fails open: a DB error returns every row and the error", async () => {
  const boom = new Error("connection reset");
  const db = { any: async () => { throw boom; } };
  const res = await drop_already_ingested_cv(db, "SME08640", [parsed]);
  assert.deepStrictEqual(res.fresh, [parsed]);
  assert.strictEqual(res.dropped, 0);
  assert.strictEqual(res.error, boom);
});

test("queries one system over the batch's host_datetime span", async () => {
  let args;
  const db = { any: async (sql, a) => { args = a; return [stored]; } };
  const res = await drop_already_ingested_cv(db, "SME08640", [parsed]);
  assert.strictEqual(args[0], "SME08640");
  assert.strictEqual(args[1].toISOString(), "2026-11-06T02:20:53.103Z");
  assert.strictEqual(res.dropped, 1);
  assert.deepStrictEqual(res.fresh, []);
});
