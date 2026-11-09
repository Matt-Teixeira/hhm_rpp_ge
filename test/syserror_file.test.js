"use strict";
// node --test test/   (no DB / Redis needed)
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { open_syserror, plan_read, plan_prev_tail, complete_lines, partial_tail, store_head_early, first_data_line, head_key, PREV_FILE_NAME } = require("../read/syserror_file");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "syserror-file-"));
const write = (name, content) => {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, content);
  return p;
};

const HEADER = "sequencenumber,date,time,subsystem,errorcode,errortext,exam,exceptioncategory,application,majorfunction,minorfunction,fru,viewinglevel,rootcause,repeatcount,debugtext,sourcefile,sourceline\n";
// Real lines from SME08640's file of 2026-11-04 (encoded fields as stored).
const L1 = '1,2026-11-04,17:53:12:995,"RTA",1050003,U0BbTTlUFn==,2222,DO,DEFAULT,U0R2Zgx0by4LamQI,U014KDVpYgYcbRd=,U0FCTDxfSSMaZWNXOV5fPCxGWUk6SlNv,1,0,0, (null),XRImChainPos,203';
const L2 = '2,2026-11-04,17:54:14:712,"POS",1050297,U1NYW1hDQCo9VzdEN0EW,2222,DO,DEFAULT,UzMX,UzMX,U0B4ZQhpeAoddz97UVlGAABqY2EXaHMdLEZhbRZySQMcZHBhFmEW,1,0,0,  - Emergency backout has been pressed.,Z:/heroic/poslayer.c,1440';

test("first_data_line skips the CSV header and needs a complete line", () => {
  assert.strictEqual(first_data_line(Buffer.from(HEADER + L1 + "\n" + L2 + "\n")), L1);
  assert.strictEqual(first_data_line(Buffer.from(HEADER + L1.slice(0, 40))), null); // first record still being written
  assert.strictEqual(first_data_line(Buffer.from(HEADER)), null);
  assert.strictEqual(first_data_line(Buffer.from("")), null);
  assert.strictEqual(first_data_line(Buffer.from(L1 + "\n")), L1); // no header: first line is data
  assert.strictEqual(first_data_line(Buffer.from(HEADER.replace("\n", "\r\n") + L1 + "\r\n")), L1);
});

test("complete_lines stops at the last newline", () => {
  const whole = Buffer.from(L1 + "\n" + L2 + "\n");
  assert.deepStrictEqual(complete_lines(whole), { text: L1 + "\n" + L2 + "\n", consumed: whole.length });
  const cut = Buffer.from(L1 + "\n" + L2.slice(0, 2)); // "2," of the next record
  assert.deepStrictEqual(complete_lines(cut), { text: L1 + "\n", consumed: L1.length + 1 });
  assert.deepStrictEqual(complete_lines(Buffer.from(L2.slice(0, 30))), { text: "", consumed: 0 });
  assert.deepStrictEqual(complete_lines(Buffer.from(L1 + "\n\u0000\u0000")), { text: L1 + "\n", consumed: L1.length + 1 }); // NUL tail
  assert.deepStrictEqual(complete_lines(Buffer.alloc(0)), { text: "", consumed: 0 });
});

test("complete_lines never splits a multi-byte character", () => {
  const b = Buffer.from("é,x\n" + "ü");
  const { text, consumed } = complete_lines(b.subarray(0, b.length - 1)); // cut inside "ü"
  assert.strictEqual(text, "é,x\n");
  assert.strictEqual(consumed, Buffer.byteLength("é,x\n"));
});

test("plan_read: incremental, unchanged, shrunk, new file, unknown watermark", () => {
  const base = { prev_offset: 905366, prev_head: L1, file_size: 906000, file_head: L1 };
  assert.deepStrictEqual(plan_read(base), { start: 905366, reason: "append" });
  assert.deepStrictEqual(plan_read({ ...base, file_size: 905366 }), { start: null, reason: "no_new_data" });
  assert.deepStrictEqual(plan_read({ ...base, file_size: 781 }), { start: 0, reason: "shrunk" });
  // GE started a new file that already outgrew the watermark (2026-07-10)
  assert.deepStrictEqual(plan_read({ ...base, file_size: 1356176, file_head: L2 }), { start: 0, reason: "new_file" });
  // ... or is exactly as long as the old one
  assert.deepStrictEqual(plan_read({ ...base, file_size: 905366, file_head: L2 }), { start: 0, reason: "new_file" });
  for (const v of [null, undefined, NaN, -1, 1.5, "905366"]) assert.deepStrictEqual(plan_read({ ...base, prev_offset: v }), { start: 0, reason: "no_watermark" });
  assert.deepStrictEqual(plan_read({ ...base, prev_offset: 0 }), { start: 0, reason: "no_watermark" });
});

test("plan_read: unknown first line on either side -> size check only (first run after deploy)", () => {
  const base = { prev_offset: 905366, prev_head: L1, file_size: 906000, file_head: L1 };
  for (const v of [null, undefined, ""]) {
    assert.deepStrictEqual(plan_read({ ...base, prev_head: v, file_head: L2 }), { start: 905366, reason: "append" });
    assert.deepStrictEqual(plan_read({ ...base, file_head: v }), { start: 905366, reason: "append" });
  }
});

test("open_syserror reads size, first line and bytes from one descriptor", async () => {
  const p = write("sysError.log", HEADER + L1 + "\n" + L2 + "\n");
  const f = await open_syserror(p);
  try {
    assert.strictEqual(f.size, fs.statSync(p).size);
    assert.strictEqual(f.head, L1);
    const from = Buffer.byteLength(HEADER + L1 + "\n");
    assert.strictEqual((await f.read_from(from)).toString(), L2 + "\n");
    assert.strictEqual((await f.read_from(f.size)).length, 0);
    assert.strictEqual((await f.read_from(0)).length, f.size);
  } finally {
    await f.close();
  }
});

test("open_syserror keeps reading the file it opened if the path is replaced", async () => {
  const p = write("replaced.log", HEADER + L1 + "\n");
  const f = await open_syserror(p);
  try {
    // the collector writes a new file under the same name (new inode)
    fs.unlinkSync(p);
    fs.writeFileSync(p, HEADER + L2 + "\n" + L2 + "\n");
    assert.strictEqual(f.head, L1);
    assert.strictEqual((await f.read_from(0)).toString(), HEADER + L1 + "\n");
  } finally {
    await f.close();
  }
});

test("open_syserror: missing file -> null; empty file -> size 0", async () => {
  assert.strictEqual(await open_syserror(path.join(tmp, "missing.log")), null);
  const f = await open_syserror(write("empty.log", ""));
  assert.strictEqual(f.size, 0);
  assert.strictEqual(f.head, null);
  await f.close();
});

test("partial_tail: warn only when new complete lines came with the partial line (Codex P3)", () => {
  // read ended on a newline
  assert.strictEqual(partial_tail({ start: 1000, consumed: 500, size: 1500 }), null);
  assert.strictEqual(partial_tail({ start: 1000, consumed: 0, size: 1000 }), null);
  // new lines + a cut record: the G5 shape -> warning
  assert.deepStrictEqual(
    { ...partial_tail({ start: 1000, consumed: 500, size: 1540 }), message: undefined },
    { bytes: 40, warn: true, message: undefined }
  );
  // only the same partial line again (unchanged file) -> info, every run
  for (let run = 0; run < 3; run++) {
    const t = partial_tail({ start: 1500, consumed: 0, size: 1540 });
    assert.strictEqual(t.bytes, 40);
    assert.strictEqual(t.warn, false);
  }
});

test("store_head_early: only when the watermark already refers to this file", () => {
  // idle system right after the deploy: no key yet, file unchanged (prod 2026-11-06)
  assert.strictEqual(store_head_early({ reason: "no_new_data", consumed: 0, prev_head: null, file_head: L1 }), true);
  assert.strictEqual(store_head_early({ reason: "no_new_data", consumed: 0, prev_head: undefined, file_head: L1 }), true); // Redis read failed
  // only a partial line after the watermark
  assert.strictEqual(store_head_early({ reason: "append", consumed: 0, prev_head: null, file_head: L1 }), true);
  // already stored -> no write
  assert.strictEqual(store_head_early({ reason: "no_new_data", consumed: 0, prev_head: L1, file_head: L1 }), false);
  assert.strictEqual(store_head_early({ reason: "append", consumed: 0, prev_head: L1, file_head: L1 }), false);
  // new lines read: stored after the insert as before, not early
  assert.strictEqual(store_head_early({ reason: "append", consumed: 500, prev_head: null, file_head: L1 }), false);
  // full reads never store early (a failed insert would leave old watermark + new head)
  for (const reason of ["new_file", "shrunk", "no_watermark"]) {
    assert.strictEqual(store_head_early({ reason, consumed: 0, prev_head: L1, file_head: L2 }), false);
    assert.strictEqual(store_head_early({ reason, consumed: 0, prev_head: null, file_head: L2 }), false);
  }
  // no complete first line in the file
  for (const v of [null, undefined, ""]) assert.strictEqual(store_head_early({ reason: "no_new_data", consumed: 0, prev_head: null, file_head: v }), false);
});

test("plan_prev_tail: read the old file's tail from sysErrorPrev.log only when it is the old file", () => {
  // SME08640 rotation of 2026-11-04: watermark 905,366, Prev 908,423 (seq 3986-4000 unread)
  const rot = { reason: "shrunk", prev_offset: 905366, prev_head: L1, file_head: L2, prev_file: { size: 908423, head: L1 } };
  assert.deepStrictEqual(plan_prev_tail(rot), { action: "read", reason: "rotation", start: 905366 });
  // new file already larger than the watermark (2026-07-10 shape)
  assert.deepStrictEqual(plan_prev_tail({ ...rot, reason: "new_file" }), { action: "read", reason: "rotation", start: 905366 });
  // new file without a complete first record yet: still the old file in Prev
  assert.strictEqual(plan_prev_tail({ ...rot, file_head: null }).action, "read");
  // old file had been read to its end
  assert.deepStrictEqual(plan_prev_tail({ ...rot, prev_file: { size: 905366, head: L1 } }), { action: "none", reason: "prev_has_no_tail" });
  // not a rotation
  for (const reason of ["append", "no_new_data", "no_watermark"]) assert.strictEqual(plan_prev_tail({ ...rot, reason }).action, "none");
  assert.deepStrictEqual(plan_prev_tail({ ...rot, file_head: L1 }), { action: "none", reason: "same_file_shorter" }); // shorter copy of the same file
  for (const v of [null, 0, NaN]) assert.strictEqual(plan_prev_tail({ ...rot, prev_offset: v }).action, "none");
  // rotation, but Prev can't supply the tail
  assert.deepStrictEqual(plan_prev_tail({ ...rot, prev_file: null }), { action: "skip", reason: "prev_missing" });
  assert.deepStrictEqual(plan_prev_tail({ ...rot, prev_file: { size: 908423, head: L2 } }), { action: "skip", reason: "prev_is_another_file" }); // two rotations, or Prev not refreshed
  assert.deepStrictEqual(plan_prev_tail({ ...rot, prev_file: { size: 900000, head: L1 } }), { action: "skip", reason: "prev_shorter_than_watermark" });
  for (const v of [null, undefined, ""]) assert.deepStrictEqual(plan_prev_tail({ ...rot, prev_head: v }), { action: "skip", reason: "old_head_unknown" });
});

test("prev file name is GE's", () => {
  assert.strictEqual(PREV_FILE_NAME, "sysErrorPrev.log");
});

test("head key sits next to the watermark key", () => {
  assert.strictEqual(head_key("sysError.log"), "sysError.log.head");
});
