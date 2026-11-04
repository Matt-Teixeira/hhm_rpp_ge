"use strict";
// Stage 5: insight.system_capabilities, one row per (system, metric) the
// system has ever emitted, derived facts included. Rebuilt per system.
const CAP_SQL = `
  INSERT INTO insight.system_capabilities (system_id, metric_key, first_seen, last_seen, n)
  SELECT system_id, metric_key, min(host_datetime), max(host_datetime), count(*)
  FROM insight.ge_ct_facts WHERE system_id = $1
  GROUP BY system_id, metric_key`;

async function rebuild_capabilities(t, system_id) {
  const del = await t.result("DELETE FROM insight.system_capabilities WHERE system_id = $1", [system_id]);
  const ins = await t.result(CAP_SQL, [system_id]);
  return { deleted: del.rowCount, inserted: ins.rowCount };
}

module.exports = { rebuild_capabilities };
