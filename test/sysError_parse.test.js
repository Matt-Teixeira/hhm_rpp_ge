"use strict";
// node --test test/   (no DB / Redis needed)
const test = require("node:test");
const assert = require("node:assert");
const { parse_syserror_lines } = require("../jobs/CV/sysError_parse");

const HEADER = "sequencenumber,date,time,subsystem,errorcode,errortext,exam,exceptioncategory,application,majorfunction,minorfunction,fru,viewinglevel,rootcause,repeatcount,debugtext,sourcefile,sourceline";
const L82 = '82,2026-11-05,18:20:53:103,"POS",1050302,U0ZaVzlIQjAwSllNNUdCJjBcUloqSUQwJ0FbVzRHQm8=,2222,DO,DEFAULT,U0R2Zgx0by4LamQI,U1BnbR1iNisWZGVpHGNybw==,U0JZXCdUWS08V0hNKlRZPXM=,1,0,0," - ANTICOLLISION CINEMATIC ERROR (0x4B10 HW:0x0009 & US:0x8000), speed error on table lat",Z:/heroic/anticol_task.c,7532';
const LDL = '1,2026-08-18,13:21:31:854,"DL ",2800176,U0FlZw91cx1TTkdYKyZQDhpvcmx4,2222,DO,DEFAULT,U1tFWw1kRRYATnB6PEoW,U0FlZw91cx1z,U0B4ZQhpeAoddz97UVlSAABmSE0AdnkdBwM=,1,0,0,"Dose Export logger - Debug text:Association rejected",Z:/x.cpp,10';
const ctx = { job_id: "j", system_id: "SME08640", parser: "sys_error", time_zone_id: "America/Los_Angeles", capture_datetime: "2026-11-06T02:18:03.871Z" };

test("builds the same row the parser stored (SME08640 seq 82, as in log.ge_cv_syserror)", async () => {
  const { rows, unmatched } = await parse_syserror_lines(HEADER + "\n" + L82 + "\n", ctx);
  assert.strictEqual(unmatched.length, 0);
  assert.strictEqual(rows.length, 1);
  const r = rows[0];
  assert.strictEqual(r.sequencenumber, "82");
  assert.strictEqual(r.host_date, "2026-11-05");
  assert.strictEqual(r.host_time, "18:20:53.103");
  assert.strictEqual(r.subsystem, "POS");
  assert.strictEqual(r.debugtext, '" - ANTICOLLISION CINEMATIC ERROR (0x4B10 HW:0x0009 & US:0x8000), speed error on table lat"');
  assert.strictEqual(r.sourcefile, "Z:/heroic/anticol_task.c");
  assert.strictEqual(r.sourceline, "7532");
  assert.strictEqual(r.system_id, "SME08640");
  assert.strictEqual(r.capture_datetime, ctx.capture_datetime);
  assert.strictEqual(new Date(r.host_datetime).toISOString(), "2026-11-06T02:20:53.103Z");
});

test("keeps the DL subsystem's trailing space, as stored today", async () => {
  const { rows } = await parse_syserror_lines(LDL + "\n", ctx);
  assert.strictEqual(rows[0].subsystem, "DL ");
});

test("header and blank lines are skipped without a NO MATCH report; a fragment is reported", async () => {
  const frag = L82.slice(120); // the end of a line cut in the middle
  const { rows, unmatched } = await parse_syserror_lines(HEADER + "\n\n" + L82 + "\n" + frag + "\n", ctx);
  assert.strictEqual(rows.length, 1);
  assert.deepStrictEqual(unmatched.map((u) => u.line), [frag]);
});

test("why a cut record must never be parsed: a line missing its first digits still matches", async () => {
  // The CV-1b failure: record 1052 read from 2 bytes in became sequence 52.
  const cut = "1052" + L82.slice(2);
  const { rows } = await parse_syserror_lines(cut.slice(2) + "\n", ctx);
  assert.strictEqual(rows[0].sequencenumber, "52");
});
