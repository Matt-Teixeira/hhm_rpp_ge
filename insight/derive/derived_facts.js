"use strict";
// Stage 1: derived facts (system.boot, tube.replacement) for one system.
//
// Always recomputed over the system's whole history (cheap: inits, restarts,
// shutdowns and tube facts only), then written as a replacement set:
//   - upsert: insert new facts, update a fact only when something differs
//     (so a re-run changes nothing)
//   - delete: derived facts of the system that are no longer derived
//     (e.g. a reading that turned out to be a glitch)
// Returns the device-clock days that changed, so the daily rollup can
// include them in an incremental run.
const { pgp } = require("../db");
const { FACT_CS } = require("../load");
const { derive_system_facts, derived_rules, DERIVED_KEYS, INPUT_KEYS } = require("../rules/ge_ct_derived");
const { catalog_statement } = require("../load");
const { load_facts } = require("./common");

const CHUNK = 2000;

const UPSERT_SUFFIX = `
  ON CONFLICT ON CONSTRAINT ge_ct_facts_natural_key DO UPDATE SET
    host_local = EXCLUDED.host_local, value_num = EXCLUDED.value_num, value_text = EXCLUDED.value_text,
    exam_no = EXCLUDED.exam_no, attrs = EXCLUDED.attrs, source_id = EXCLUDED.source_id,
    source_capture_datetime = EXCLUDED.source_capture_datetime, rule_version = EXCLUDED.rule_version,
    extracted_at = now()
  WHERE (ge_ct_facts.host_local, ge_ct_facts.value_num, ge_ct_facts.value_text, ge_ct_facts.exam_no, ge_ct_facts.attrs,
         ge_ct_facts.source_id, ge_ct_facts.source_capture_datetime, ge_ct_facts.rule_version)
        IS DISTINCT FROM
        (EXCLUDED.host_local, EXCLUDED.value_num, EXCLUDED.value_text, EXCLUDED.exam_no, EXCLUDED.attrs,
         EXCLUDED.source_id, EXCLUDED.source_capture_datetime, EXCLUDED.rule_version)
  RETURNING (xmax = 0) AS inserted, epoch, record_number_concurrent, metric_key, host_datetime,
            to_char(host_local, 'YYYY-MM-DD') AS day`;

// Existing derived facts of the system, with their device day, so an update
// that moves a fact to another day reports the old day too (review F2).
const EXISTING_SQL = `
  SELECT epoch, record_number_concurrent, metric_key, host_datetime, to_char(host_local, 'YYYY-MM-DD') AS day
  FROM insight.ge_ct_facts WHERE system_id = $1 AND metric_key = ANY($2)`;

const fkey = (r) => `${r.epoch}|${r.record_number_concurrent}|${r.metric_key}|${new Date(r.host_datetime).toISOString()}`;

// Pure: days whose daily rows must be rebuilt = new day of every inserted or
// updated fact, old day of every updated fact, day of every deleted fact.
function changed_days(existing, upserted, deleted) {
  const before = new Map(existing.map((r) => [fkey(r), r.day]));
  const days = new Set();
  for (const r of upserted) {
    days.add(r.day);
    if (!r.inserted && before.has(fkey(r))) days.add(before.get(fkey(r)));
  }
  for (const r of deleted) days.add(r.day);
  return days;
}

const DELETE_STALE_SQL = `
  DELETE FROM insight.ge_ct_facts
  WHERE system_id = $1 AND metric_key = ANY($2)
    AND (epoch, record_number_concurrent, metric_key, host_datetime) NOT IN
        (SELECT * FROM unnest($3::integer[], $4::integer[], $5::text[], $6::timestamptz[]))
  RETURNING to_char(host_local, 'YYYY-MM-DD') AS day`;

function sync_catalog(t) {
  return t.none(catalog_statement(derived_rules));
}

async function derive_facts_for_system(t, system_id) {
  const input = await load_facts(t, system_id, INPUT_KEYS);
  const facts = derive_system_facts(input);
  const stats = { derived: facts.length, inserted: 0, updated: 0, deleted: 0 };
  const existing = await t.any(EXISTING_SQL, [system_id, DERIVED_KEYS]);
  const upserted = [];
  for (let i = 0; i < facts.length; i += CHUNK) {
    const rows = await t.any(pgp.helpers.insert(facts.slice(i, i + CHUNK), FACT_CS) + UPSERT_SUFFIX);
    for (const r of rows) { r.inserted ? stats.inserted++ : stats.updated++; upserted.push(r); }
  }
  const del = await t.any(DELETE_STALE_SQL, [
    system_id, DERIVED_KEYS,
    facts.map((f) => f.epoch), facts.map((f) => f.record_number_concurrent),
    facts.map((f) => f.metric_key), facts.map((f) => new Date(f.host_datetime).toISOString()),
  ]);
  stats.deleted = del.length;
  const days = changed_days(existing, upserted, del);
  stats.by_metric = {};
  for (const f of facts) stats.by_metric[f.metric_key] = (stats.by_metric[f.metric_key] || 0) + 1;
  return { stats, changed_days: days };
}

module.exports = { derive_facts_for_system, sync_catalog, changed_days, UPSERT_SUFFIX, DELETE_STALE_SQL };
