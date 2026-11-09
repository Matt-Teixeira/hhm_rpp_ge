"use strict";
// GE CV extraction (PLAN-CV-INSIGHTS.md §4 CV-2): stream log.ge_cv_syserror
// by id batches, classify each row (rules.js), hand facts to a sink. The dry
// run, the rehearsal and --apply share this code; only the sink differs.
//
// Only non-encoded columns are selected: never errortext, fru,
// majorfunction or minorfunction. Nothing in the GE CT run loads this file.
const { classify } = require("./rules");

const BATCH = 50000;

// host_local (device wall clock) is host_date + host_time, built in JS so a
// malformed host_time skips one row instead of failing the batch query.
const ROW_COLUMNS = `id, capture_datetime, system_id, sequencenumber, host_date::text AS host_date, host_time,
         btrim(subsystem) AS subsystem, errorcode, exceptioncategory, repeatcount, debugtext, sourcefile, sourceline, host_datetime`;
const BATCH_SQL = `
  SELECT ${ROW_COLUMNS}
  FROM log.ge_cv_syserror
  WHERE id > $1 AND ($2::bigint IS NULL OR id <= $2) AND ($3::text IS NULL OR system_id = $3)
  ORDER BY id
  LIMIT ${BATCH}`;

const TIME_RE = /^\d{2}:\d{2}:\d{2}(\.\d{1,6})?$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function host_local_of(r) {
  const t = typeof r.host_time === "string" ? r.host_time.trim() : "";
  return DATE_RE.test(r.host_date || "") && TIME_RE.test(t) ? `${r.host_date}T${t}` : null;
}

// Why a row that would give facts can't be stored (the facts table's NOT
// NULL / CHECK columns). The independent SQL applies the same filter.
function skip_reason(r) {
  if (!r.system_id) return "no_system";
  if (r.sequencenumber === null || r.sequencenumber === undefined) return "no_sequencenumber";
  if (r.errorcode === null || r.errorcode === undefined) return "no_errorcode";
  if (!r.subsystem) return "no_subsystem";
  const t = r.host_datetime ? new Date(r.host_datetime).getTime() : NaN;
  if (!Number.isFinite(t)) return "no_host_datetime";
  if (!host_local_of(r)) return "no_host_local";
  return null;
}

const new_skipped = () => ({ no_system: 0, no_sequencenumber: 0, no_errorcode: 0, no_subsystem: 0, no_host_datetime: 0, no_host_local: 0 });

// Pure: rows -> { facts (with keys and source), ignored: {key: rows}, skipped: {reason: rows}, errors, codes: Set }
function build_facts(rows) {
  const facts = [];
  const errors = [];
  const ignored = {};
  const skipped = new_skipped();
  const codes = new Set();
  for (const r of rows) {
    const out = classify(r);
    errors.push(...out.errors);
    if (out.ignore) { ignored[out.ignore] = (ignored[out.ignore] || 0) + 1; continue; }
    const why = skip_reason(r);
    if (why) { skipped[why]++; continue; }
    codes.add(r.errorcode);
    const host_local = host_local_of(r);
    for (const f of out.facts) {
      facts.push({
        system_id: r.system_id, host_datetime: r.host_datetime, sequencenumber: r.sequencenumber, host_local,
        errorcode: r.errorcode, subsystem: r.subsystem, exceptioncategory: r.exceptioncategory ?? null,
        source_id: r.id, source_capture_datetime: r.capture_datetime, ...f,
      });
    }
  }
  return { facts, ignored, skipped, errors, codes };
}

// Stream batches; on_batch({ rows, built, last_id }) is awaited per batch.
async function stream(db, { from_id = 0, to_id = null, system = null, on_batch }) {
  let last = from_id;
  for (;;) {
    const rows = await db.any(BATCH_SQL, [last, to_id, system]);
    if (!rows.length) return last;
    last = Number(rows[rows.length - 1].id);
    await on_batch({ rows, built: build_facts(rows), last_id: last });
  }
}

module.exports = { stream, build_facts, host_local_of, skip_reason, new_skipped, BATCH, BATCH_SQL, ROW_COLUMNS };
