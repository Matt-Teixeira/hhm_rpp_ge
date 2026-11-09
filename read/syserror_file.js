"use strict";
// GE CV sysError.log reader (PLAN-CV-INSIGHTS.md §5, CV-1b).
//
// Replaces, for the CV parser only, the size-delta + `tail -c delta` read in
// acquisition/GE_CT_CV_MRI.js (unchanged; CT and MRI still use it). Three
// record-loss paths found on prod (plan §5.2) are closed here:
//
// 1. Rotation missed by the size check. GE starts a new sysError.log at
//    sequence 1 (after record 4000, and sometimes earlier). If the new file
//    outgrows the old byte watermark before the next run, `tail -c delta`
//    reads only its end and skips its start (2026-07-10: 3,011 records;
//    2026-09-18: 667). The file has no epoch header like CT gesys, but its
//    first data line (sequence 1 + timestamp) identifies the file: a
//    changed first line means a new file, so the whole file is read.
// 2. Watermark past a line boundary. The old watermark was the file size,
//    re-measured after the insert, so bytes after the last newline counted
//    as read. The next read then started inside a record: the record was
//    dropped (35 times) or kept with a cut sequence number (1052 -> 52,
//    3 times). Here the watermark only ever advances to the end of the last
//    complete line; a trailing partial line is read again next run.
// 3. Size, header and data from different moments. Size, first line and
//    data now come from one open file descriptor, so they describe the same
//    file even if the collector replaces it meanwhile.
//
// Pure parts (plan_read, complete_lines, first_data_line) are exported for
// tests and the snapshot simulation.

const fsp = require("node:fs").promises;

const HEADER_RE = /^sequencenumber,date/;
const HEAD_PROBE_BYTES = 8192;
const NL = 0x0a;

// First complete data line of the file (the header line is skipped).
// Returns the line without its newline, or null if there is none yet.
function first_data_line(buf) {
  let start = 0;
  for (let guard = 0; guard < 2; guard++) {
    const end = buf.indexOf(NL, start);
    if (end === -1) return null;
    const line = buf.subarray(start, end).toString("utf8").replace(/\r$/, "");
    if (!(guard === 0 && HEADER_RE.test(line))) return line === "" ? null : line;
    start = end + 1;
  }
  return null;
}

// The complete lines of buf: everything up to and including the last "\n".
// consumed = number of bytes the watermark may advance by.
function complete_lines(buf) {
  const last = buf.lastIndexOf(NL);
  if (last === -1) return { text: "", consumed: 0 };
  return { text: buf.subarray(0, last + 1).toString("utf8"), consumed: last + 1 };
}

// How to report bytes after the last newline (they stay unread and are read
// again next run). Warn only when complete new lines came with them: that is
// the G5 shape (a copy taken mid-write). A tail with nothing new before it is
// either that same tail again (the file did not change since the last run) or
// a first record still being written; report it as info so an unchanged file
// does not warn on every run (REVIEW-CV1B-PARSER-CODEX P3).
// Returns null when the read ended on a newline.
function partial_tail({ start, consumed, size }) {
  const bytes = size - start - consumed;
  if (bytes <= 0) return null;
  return consumed > 0
    ? { bytes, warn: true, message: "File ends inside a line after new complete lines; that line is read next run" }
    : { bytes, warn: false, message: "Only a partial line after the watermark; waiting for its newline" };
}

const valid_offset =(v) => Number.isInteger(v) && v >= 0;

// Decide where to start reading.
//   prev_offset: the stored watermark (int) or null / NaN when unknown
//   prev_head:   the stored first data line, or null when unknown
//   file_size:   size of the open file
//   file_head:   first data line of the open file, or null
// Returns { start, reason }; start === null means "nothing to read".
function plan_read({ prev_offset, prev_head, file_size, file_head }) {
  if (!valid_offset(prev_offset) || prev_offset === 0) return { start: 0, reason: "no_watermark" };
  if (file_size < prev_offset) return { start: 0, reason: "shrunk" };
  const heads_known = typeof prev_head === "string" && prev_head !== "" && typeof file_head === "string" && file_head !== "";
  if (heads_known && prev_head !== file_head) return { start: 0, reason: "new_file" };
  if (file_size === prev_offset) return { start: null, reason: "no_new_data" };
  return { start: prev_offset, reason: "append" };
}

// Should the file's first line be stored on a run that inserts nothing?
// The .head key is normally written after a successful insert. A run that
// reads no complete line (nothing new, or only a partial line after the
// watermark) never gets there, so on an idle system the key would never be
// set and the new-file check would stay size-only. Storing it early is safe
// only when the watermark already refers to this file: reason no_new_data,
// or append. Never on a full read (new_file / shrunk / no_watermark): if that
// read's insert failed, a stored new head next to the old watermark would
// make the next run append from the wrong offset.
function store_head_early({ reason, consumed, prev_head, file_head }) {
  if (typeof file_head !== "string" || file_head === "" || prev_head === file_head) return false;
  return reason === "no_new_data" || (reason === "append" && consumed === 0);
}

// GE keeps exactly one previous generation of the log: on rotation it
// renames sysError.log to sysErrorPrev.log and starts a new sysError.log at
// sequence 1 (PLAN-CV-INSIGHTS.md §5.5 D3b, D5). Records written after our
// last collection of the old file are therefore still in sysErrorPrev.log,
// starting exactly at the old watermark (verified byte for byte on
// SME02412 and SME08640, 2026-11-09). The collector fetches it next to
// sysError.log.
const PREV_FILE_NAME = "sysErrorPrev.log";

// On a run that reads sysError.log from 0, decide whether to read the old
// file's unread tail from sysErrorPrev.log.
//   reason, prev_offset, prev_head, file_head: as for plan_read
//   prev_file: { size, head } of the local sysErrorPrev.log, or null
// Returns { action, reason, start? }:
//   none  not a rotation (no read from 0, no watermark, or a shorter copy
//         of the same file)
//   skip  a rotation, but the tail can't be taken from sysErrorPrev.log
//         (reason says why); the caller logs it
//   read  read sysErrorPrev.log from `start` (= the old watermark)
// Proof that sysErrorPrev.log is the old file: its first data line equals
// the stored .head. The duplicate guard still runs on what is read.
function plan_prev_tail({ reason, prev_offset, prev_head, file_head, prev_file }) {
  if (reason !== "new_file" && reason !== "shrunk") return { action: "none", reason: "not_a_full_reread" };
  if (!valid_offset(prev_offset) || prev_offset === 0) return { action: "none", reason: "no_watermark" };
  const head_known = typeof prev_head === "string" && prev_head !== "";
  if (head_known && reason === "shrunk" && file_head === prev_head) return { action: "none", reason: "same_file_shorter" };
  if (!head_known) return { action: "skip", reason: "old_head_unknown" };
  if (!prev_file) return { action: "skip", reason: "prev_missing" };
  if (prev_file.head !== prev_head) return { action: "skip", reason: "prev_is_another_file" };
  if (prev_file.size < prev_offset) return { action: "skip", reason: "prev_shorter_than_watermark" };
  if (prev_file.size === prev_offset) return { action: "none", reason: "prev_has_no_tail" };
  return { action: "read", reason: "rotation", start: prev_offset };
}

// Read the file once through one descriptor: size, first data line and the
// bytes from `start`. Returns null if the file can't be opened.
async function open_syserror(file_path) {
  let fh;
  try {
    fh = await fsp.open(file_path, "r");
  } catch {
    return null;
  }
  try {
    const { size } = await fh.stat();
    const probe = Buffer.alloc(Math.min(size, HEAD_PROBE_BYTES));
    const { bytesRead } = await fh.read(probe, 0, probe.length, 0);
    const head = first_data_line(probe.subarray(0, bytesRead));
    const read_from = async (start) => {
      const len = Math.max(0, size - start);
      const buf = Buffer.alloc(len);
      let off = 0;
      while (off < len) {
        const { bytesRead: n } = await fh.read(buf, off, len - off, start + off);
        if (n === 0) break;
        off += n;
      }
      return buf.subarray(0, off);
    };
    return { size, head, read_from, close: () => fh.close().catch(() => {}) };
  } catch (error) {
    await fh.close().catch(() => {});
    throw error;
  }
}

const head_key = (file_name) => `${file_name}.head`;

module.exports = { open_syserror, plan_read, plan_prev_tail, complete_lines, partial_tail, store_head_early, first_data_line, head_key, HEADER_RE, PREV_FILE_NAME };
