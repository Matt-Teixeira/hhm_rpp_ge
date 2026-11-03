"use strict";
// Drop parsed gesys records that are already in the log table
// (PLAN-CT-INSIGHTS.md §11.4 step 1).
//
// Why: GE rotates gesys_<host>.log at ~7 MB but carries the tail of the
// old file into the new one, and interrupted transfers can leave a short
// file. Either way the parser re-reads content it already inserted. This
// removes those records before the insert, whatever the cause.
//
// Match: (epoch, record_number_concurrent, sr, type, message). The GE
// epoch is local wall-clock time and repeats in the DST fall-back hour, so
// the content columns keep distinct records that share a key.
//
// Lookup: one index range scan on (system_id, host_datetime) over the
// batch's host_datetime span. Rows without a host_datetime are never
// dropped (same as before this change).
//
// Fails open: on any error the caller gets all rows back, i.e. exactly the
// behaviour before this change, plus the error for logging.

const EXISTING_SQL = `
SELECT epoch, record_number_concurrent, sr, type, message
FROM log.ge_ct_gesys
WHERE system_id = $1
  AND host_datetime >= $2
  AND host_datetime <= $3
`;

// Parsed values are strings (or null); DB values are ints/text (or null).
// Normalise both sides the same way.
const part = (v) => (v === null || v === undefined ? "\u0000" : String(v));
const record_key = (r) =>
  [r.epoch, r.record_number_concurrent, r.sr, r.type, r.message].map(part).join("\u0001");

function host_range(rows) {
  let min = Infinity;
  let max = -Infinity;
  for (const r of rows) {
    if (!r.host_datetime) continue;
    const t = Date.parse(r.host_datetime);
    if (!Number.isFinite(t)) continue;
    if (t < min) min = t;
    if (t > max) max = t;
  }
  return min === Infinity ? null : { from: new Date(min), to: new Date(max) };
}

// Pure part: split rows given the set of keys already stored.
function split_rows(rows, existing_keys) {
  const fresh = [];
  let dropped = 0;
  for (const r of rows) {
    if (r.host_datetime && existing_keys.has(record_key(r))) dropped++;
    else fresh.push(r);
  }
  return { fresh, dropped };
}

async function drop_already_ingested(db, system_id, rows) {
  const range = host_range(rows);
  if (!range) return { fresh: rows, dropped: 0, checked: 0, error: null };
  try {
    const existing = await db.any(EXISTING_SQL, [system_id, range.from, range.to]);
    const keys = new Set(existing.map(record_key));
    const { fresh, dropped } = split_rows(rows, keys);
    return { fresh, dropped, checked: existing.length, error: null, range };
  } catch (error) {
    return { fresh: rows, dropped: 0, checked: 0, error, range };
  }
}

module.exports = { drop_already_ingested, split_rows, record_key, host_range };
