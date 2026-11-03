"use strict";
// Extraction (PLAN-CT-INSIGHTS.md §6 step 1): stream log.ge_ct_gesys by id
// batches, run the rule engine, hand facts to a sink. The dry run and the
// --apply path share this code; only the sink differs.
const { facts_for_row, process_of } = require("./rules/engine");

const BATCH = 50000;
// Facts partitions exist for [PARTITION_FROM, PARTITION_TO); rows outside are skipped and counted.
const PARTITION_FROM = Date.parse("2025-05-01T00:00:00Z");
const PARTITION_TO = Date.parse("2029-01-01T00:00:00Z");

// host_local = device wall clock (host_date 'DD-Mon-YYYY' + host_time), §12 item 2.
const BATCH_SQL = `
  SELECT id, capture_datetime, system_id, epoch, record_number_concurrent, type, message,
         exception_class, severity, ermes_number, host_datetime,
         to_char(to_date(host_date, 'DD-Mon-YYYY') + host_time, 'YYYY-MM-DD"T"HH24:MI:SS') AS host_local
  FROM log.ge_ct_gesys
  WHERE id > $1 AND ($2::bigint IS NULL OR id <= $2) AND ($3::text IS NULL OR system_id = $3)
  ORDER BY id
  LIMIT ${BATCH}`;

// Pure: rows -> { facts (with keys/source), skipped, errors }
function build_facts(rows, rules) {
  const facts = [];
  const errors = [];
  const skipped = { no_host_datetime: 0, no_host_local: 0, outside_partitions: 0, missing_key: 0 };
  for (const r of rows) {
    const out = facts_for_row(r, rules);
    errors.push(...out.errors);
    if (!out.facts.length) continue;
    const t = r.host_datetime ? new Date(r.host_datetime).getTime() : NaN;
    const why = r.epoch === null || r.record_number_concurrent === null ? "missing_key"
      : !Number.isFinite(t) ? "no_host_datetime"
      : !r.host_local ? "no_host_local"
      : t < PARTITION_FROM || t >= PARTITION_TO ? "outside_partitions" : null;
    if (why) { skipped[why] += out.facts.length; continue; }
    for (const f of out.facts) {
      facts.push({
        system_id: r.system_id, epoch: r.epoch, record_number_concurrent: r.record_number_concurrent,
        host_datetime: r.host_datetime, host_local: r.host_local,
        source_id: r.id, source_capture_datetime: r.capture_datetime, process: process_of(r.type), ...f,
      });
    }
  }
  return { facts, skipped, errors };
}

// Stream batches; on_batch({rows, built, last_id}) is awaited per batch.
async function stream(db, { from_id = 0, to_id = null, system = null, rules, on_batch }) {
  let last = from_id;
  for (;;) {
    const rows = await db.any(BATCH_SQL, [last, to_id, system]);
    if (!rows.length) return last;
    last = rows[rows.length - 1].id;
    await on_batch({ rows, built: build_facts(rows, rules), last_id: last });
  }
}

module.exports = { stream, build_facts, BATCH, PARTITION_FROM, PARTITION_TO };
