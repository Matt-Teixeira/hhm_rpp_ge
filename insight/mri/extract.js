"use strict";
// GE MRI extraction (PLAN-MRI-INSIGHTS.md §4 MRI-2): stream log.ge_mri_gesys
// by id batches, classify each record (rules.js), hand facts to a sink. The
// dry run, the rehearsal and --apply share this code; only the sink differs.
//
// Records dedupe on the gesys natural key (system_id, epoch,
// record_number_concurrent), as CT: the first source row (lowest id) of a
// key gives its facts, later copies are counted as duplicates. Two rows
// with one key but different content (a DST fall-back fold, plan §6.6) are
// a CONFLICT: reported here, refused by the write path, failed by verify.
//
// host_local (device wall clock) = 1970-01-01 + epoch seconds, exactly the
// facts table's CHECK. Nothing in the GE CT or CV run loads this file.
const crypto = require("crypto");
const { classify } = require("./rules");

const BATCH = 50000;
// Facts partitions exist for device months [2025-05, 2028-12] (migration
// 009); records outside are skipped and counted.
const PARTITION_FROM = "2025-05-01T00:00:00";
const PARTITION_TO = "2029-01-01T00:00:00";

const ROW_COLUMNS = `id, capture_datetime, system_id, epoch, record_number_concurrent, message_number, type, message, coil, psd, host_datetime`;
const BATCH_SQL = `
  SELECT ${ROW_COLUMNS}
  FROM log.ge_mri_gesys
  WHERE id > $1 AND ($2::bigint IS NULL OR id <= $2) AND ($3::text IS NULL OR system_id = $3)
  ORDER BY id
  LIMIT ${BATCH}`;

// "YYYY-MM-DDTHH:MM:SS" (no zone), the facts table's host_local.
function host_local_of(epoch) {
  if (!Number.isInteger(epoch)) return null;
  const d = new Date(epoch * 1000);
  return Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 19) : null;
}

// The record's content, to tell a re-sent copy from a different record on
// the same key. The SQL side is reconcile_sql.js IDENTITY_SQL: md5 of the
// same string (code, type, message joined by U+001F; NULL as empty).
const IDENT_SEP = "\u001f";
function identity(r) {
  const s = [r.message_number ?? "", r.type ?? "", r.message ?? ""].join(IDENT_SEP);
  return crypto.createHash("md5").update(s, "utf8").digest("hex");
}

const natural_key = (r) => `${r.system_id}|${r.epoch}|${r.record_number_concurrent}`;

// Why a record can't be stored (the facts table's NOT NULL columns and
// partitions). The independent SQL (reconcile_sql.js STORABLE) applies the
// same filter.
function skip_reason(r) {
  if (!r.system_id) return "no_system";
  if (!Number.isInteger(r.epoch) || !Number.isInteger(r.record_number_concurrent)) return "missing_key";
  if (!Number.isInteger(r.message_number)) return "no_message_number";
  const t = r.host_datetime ? new Date(r.host_datetime).getTime() : NaN;
  if (!Number.isFinite(t)) return "no_host_datetime";
  const hl = host_local_of(r.epoch);
  if (!hl || hl < PARTITION_FROM || hl >= PARTITION_TO) return "outside_partitions";
  return null;
}

const new_skipped = () => ({ no_system: 0, missing_key: 0, no_message_number: 0, no_host_datetime: 0, outside_partitions: 0 });

// Pure: rows -> { facts, records, duplicates, conflicts, skipped, errors, codes }.
// `seen` (key -> { id, ident }) carries the dedupe across batches for the
// dry run; the write path passes a fresh map per batch and checks earlier
// batches against the database (load.js check_conflicts).
function build_facts(rows, seen = new Map()) {
  const facts = [];
  const errors = [];
  const conflicts = [];
  const skipped = new_skipped();
  const codes = new Set();
  const records = [];
  let duplicates = 0;
  for (const r of rows) {
    const why = skip_reason(r);
    if (why) { skipped[why]++; continue; }
    const k = natural_key(r);
    const ident = identity(r);
    const first = seen.get(k);
    if (first) {
      duplicates++;
      if (first.ident !== ident) conflicts.push({ key: k, ids: [String(first.id), String(r.id)] });
      continue;
    }
    seen.set(k, { id: r.id, ident });
    const out = classify(r);
    errors.push(...out.errors);
    codes.add(r.message_number);
    const host_local = host_local_of(r.epoch);
    records.push({ system_id: r.system_id, epoch: r.epoch, record_number_concurrent: r.record_number_concurrent, host_local, id: r.id, ident });
    for (const f of out.facts) {
      facts.push({
        system_id: r.system_id, epoch: r.epoch, record_number_concurrent: r.record_number_concurrent, host_local,
        host_datetime: r.host_datetime, message_number: r.message_number,
        source_id: r.id, source_capture_datetime: r.capture_datetime, ...f,
      });
    }
  }
  return { facts, records, duplicates, conflicts, skipped, errors, codes };
}

// Stream batches; on_batch({ rows, built, last_id }) is awaited per batch.
async function stream(db, { from_id = 0, to_id = null, system = null, seen = null, on_batch }) {
  let last = from_id;
  for (;;) {
    const rows = await db.any(BATCH_SQL, [last, to_id, system]);
    if (!rows.length) return last;
    last = Number(rows[rows.length - 1].id);
    await on_batch({ rows, built: build_facts(rows, seen || new Map()), last_id: last });
  }
}

module.exports = {
  stream, build_facts, host_local_of, identity, natural_key, skip_reason, new_skipped,
  BATCH, BATCH_SQL, ROW_COLUMNS, PARTITION_FROM, PARTITION_TO, IDENT_SEP,
};
