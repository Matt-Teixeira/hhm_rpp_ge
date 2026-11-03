"use strict";
// node --test test/   (no DB / Redis needed)
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { read_gesys_head, rotation_missed, head_key } = require("../read/gesys_head");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gesys-head-"));
const write = (name, content) => {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, content);
  return p;
};
const HEADER = "A 1793629319\n" + " ".repeat(114) + "\n\r\r";

test("reads the header epoch of a real-shaped gesys file", async () => {
  assert.strictEqual(HEADER.length, 130);
  const p = write("gesys_x.log", HEADER + "SR 419\n1793251307\t2\t1\tThu Oct ...");
  assert.strictEqual(await read_gesys_head(p), "1793629319");
});

test("no header, empty file, missing file -> null (never throws)", async () => {
  assert.strictEqual(await read_gesys_head(write("a.log", "SR 419\n...")), null);
  assert.strictEqual(await read_gesys_head(write("b.log", "")), null);
  assert.strictEqual(await read_gesys_head(path.join(tmp, "missing.log")), null);
  assert.strictEqual(await read_gesys_head(tmp), null); // a directory
});

test("rotation_missed: only when headers differ AND the size check would tail-read", () => {
  const base = { prev_head: "1791348494", file_head: "1793629319", prev_file_size: 7003571, delta: 4000 };
  assert.strictEqual(rotation_missed(base), true);
  // same header -> normal incremental read
  assert.strictEqual(rotation_missed({ ...base, file_head: base.prev_head }), false);
  // unknown header on either side -> behave as before
  for (const v of [null, undefined, ""]) {
    assert.strictEqual(rotation_missed({ ...base, prev_head: v }), false);
    assert.strictEqual(rotation_missed({ ...base, file_head: v }), false);
  }
  // full read already happens on these paths: nothing to force
  assert.strictEqual(rotation_missed({ ...base, delta: -5910316 }), false);
  assert.strictEqual(rotation_missed({ ...base, prev_file_size: 0 }), false);
  assert.strictEqual(rotation_missed({ ...base, prev_file_size: null }), false);
  // no change in size -> parser returns early anyway
  assert.strictEqual(rotation_missed({ ...base, delta: 0 }), false);
  assert.strictEqual(rotation_missed({ ...base, delta: NaN }), false);
});

test("head key sits next to the size key", () => {
  assert.strictEqual(head_key("gesys_gectpet.log"), "gesys_gectpet.log.head");
});
