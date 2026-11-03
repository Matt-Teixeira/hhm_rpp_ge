"use strict";
// GE gesys file header (PLAN-CT-INSIGHTS.md §11.4 step 2).
//
// Every gesys_<host>.log starts with "A <epoch>\n" plus padding (130 bytes).
// The epoch changes when GE rotates the file and at no other time (checked
// on 6,816 snapshots of 71 CT files, 2026-11-01..03). The parser stores it
// in Redis next to the byte watermark. If it changed but the file still
// grew (the rotated file outgrew the old watermark between runs), the size
// check alone would read only the tail and skip the start of the new file,
// so the parser reads the whole file instead and
// persist/drop_already_ingested.js removes the overlap.

const fsp = require("node:fs").promises;

// Returns the header epoch as a string, or null if unreadable/absent. Never throws.
async function read_gesys_head(file_path) {
  let fh;
  try {
    fh = await fsp.open(file_path, "r");
    const buf = Buffer.alloc(64);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    const m = /^A (\d+)\n/.exec(buf.subarray(0, bytesRead).toString("latin1"));
    return m ? m[1] : null;
  } catch {
    return null;
  } finally {
    if (fh) await fh.close().catch(() => {});
  }
}

// True only when the size check would tail-read a file that was rotated
// since the last successful run. Unknown header on either side -> false
// (behave exactly as before this check existed).
function rotation_missed({ prev_head, file_head, prev_file_size, delta }) {
  return (
    typeof prev_head === "string" &&
    prev_head !== "" &&
    typeof file_head === "string" &&
    file_head !== "" &&
    prev_head !== file_head &&
    prev_file_size > 0 &&
    delta > 0
  );
}

const head_key = (file_name) => `${file_name}.head`;

module.exports = { read_gesys_head, rotation_missed, head_key };
