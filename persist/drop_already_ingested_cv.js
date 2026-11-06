"use strict";
// Drop parsed GE CV sysError records that are already in log.ge_cv_syserror
// (PLAN-CV-INSIGHTS.md §5, CV-1b). The CV twin of drop_already_ingested.js
// (CT, PLAN-CT-INSIGHTS.md §11.4 step 1).
//
// Why: the CV parser now reads a whole file whenever it can't trust its
// watermark: a new file, a file that shrank (an interrupted in-place
// download leaves a short copy), or a lost Redis key. A whole-file read of a
// file that was partly ingested would insert those records again. This
// removes them before the insert, whatever the cause. No duplicates exist
// today (checked 2026-11-06: 0 of 95,767 rows), so on normal runs this drops
// nothing.
//
// Match: every column the parser fills from the line. sequencenumber alone
// is not a key: it restarts at 1 in every new file.
//
// Lookup: one index range scan on (system_id, host_datetime) over the
// batch's host_datetime span. Rows without a host_datetime are never
// dropped (same as before this change).
//
// Fails open: on any error the caller gets all rows back, i.e. exactly the
// behaviour before this change, plus the error for logging.

const COLS = [
  "sequencenumber", "host_date", "host_time", "subsystem", "errorcode",
  "errortext", "exam", "exceptioncategory", "application", "majorfunction",
  "minorfunction", "fru", "viewinglevel", "rootcause", "repeatcount",
  "debugtext", "sourcefile", "sourceline"
];
const INT_COLS = new Set(["sequencenumber", "errorcode", "exam", "viewinglevel", "rootcause", "repeatcount", "sourceline"]);

const EXISTING_SQL = `
SELECT ${COLS.map((c) => `${c}::text AS ${c}`).join(", ")}
FROM log.ge_cv_syserror
WHERE system_id = $1
  AND host_datetime >= $2
  AND host_datetime <= $3
`;

// Parsed values are strings (or null); DB values come back as text (or
// null). Integer columns are normalised the way Postgres stores them
// ("007" -> "7"), so a parsed "007" still matches a stored 7.
const part = (c, v) => {
  if (v === null || v === undefined) return "\u0000";
  const s = String(v);
  if (INT_COLS.has(c) && /^\s*[+-]?\d+\s*$/.test(s)) return String(BigInt(s.trim()));
  return s;
};
const record_key = (r) => COLS.map((c) => part(c, r[c])).join("\u0001");

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

async function drop_already_ingested_cv(db, system_id, rows) {
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

module.exports = { drop_already_ingested_cv, split_rows, record_key, host_range, COLS, EXISTING_SQL };
