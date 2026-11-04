"use strict";
// Reads one system's findings inputs (findings/context.js) from the derived
// tables. Read-only; works on any connection or transaction.
const { SERIES_METRICS } = require("./context");

// Data days: every device day with a fact. start_at = the instant of local
// midnight, from the clock offset (host_datetime - host_local) of the day's
// first fact; offsets are whole hours on every system (checked 2026-11-04).
const DAYS_SQL = `
  SELECT to_char(a.d, 'YYYY-MM-DD') AS day, a.start_at, b.last_at
  FROM (SELECT DISTINCT ON (host_local::date) host_local::date AS d,
               host_datetime - (host_local - host_local::date::timestamp) AS start_at
        FROM insight.ge_ct_facts WHERE system_id = $1
        ORDER BY host_local::date, host_local, host_datetime) a
  JOIN (SELECT host_local::date AS d, max(host_datetime) AS last_at
        FROM insight.ge_ct_facts WHERE system_id = $1 GROUP BY 1) b USING (d)
  ORDER BY a.d`;

const DAILY_SQL = `
  SELECT to_char(local_day, 'YYYY-MM-DD') AS day, metric_key AS m, dim, n::int AS n
  FROM insight.ge_ct_daily WHERE system_id = $1 AND metric_key = ANY($2)`;

const EVENTS_SQL = `
  SELECT metric_key AS m, host_datetime AS t, to_char(host_local, 'YYYY-MM-DD') AS day,
         CASE WHEN metric_key = 'scan.safe_state' THEN attrs ->> 'ermes' END AS code,
         CASE WHEN metric_key = 'service.mode' THEN value_text END AS x,
         CASE WHEN metric_key = 'system.boot' THEN (attrs ->> 'clean')::boolean END AS clean,
         CASE WHEN metric_key = 'tube.replacement' THEN attrs END AS attrs,
         value_num, value_text
  FROM insight.ge_ct_facts
  WHERE system_id = $1 AND metric_key IN ('scan.safe_state', 'system.boot', 'system.shutdown', 'service.mode', 'tube.replacement')
  ORDER BY host_datetime, epoch, record_number_concurrent`;

const ABORT_CODES_SQL = `
  SELECT to_char(host_local, 'YYYY-MM-DD') AS day, coalesce(attrs ->> 'ermes', '') AS code, count(*)::int AS n
  FROM insight.ge_ct_facts WHERE system_id = $1 AND metric_key = 'scan.abort.system' GROUP BY 1, 2`;

async function load_inputs(t, system_id) {
  const [days, daily, events, abort_codes] = await Promise.all([
    t.any(DAYS_SQL, [system_id]), t.any(DAILY_SQL, [system_id, SERIES_METRICS]), t.any(EVENTS_SQL, [system_id]), t.any(ABORT_CODES_SQL, [system_id]),
  ]);
  const inp = { system_id, days, daily, abort_codes, safe: [], boots: [], shutdowns: [], service_enter: [], replacements: [] };
  for (const e of events) {
    // code only: raw message text stays internal (§7; review PHASE4-RULES F1)
    if (e.m === "scan.safe_state") inp.safe.push({ t: e.t, day: e.day, code: e.code });
    else if (e.m === "system.boot") inp.boots.push({ t: e.t, day: e.day, clean: e.clean === true });
    else if (e.m === "system.shutdown") inp.shutdowns.push({ t: e.t, day: e.day });
    else if (e.m === "service.mode" && e.x === "enter") inp.service_enter.push({ t: e.t, day: e.day });
    else if (e.m === "tube.replacement") {
      const a = e.attrs || {};
      inp.replacements.push({ t: e.t, day: e.day, install_date: a.install_date || e.day, confidence: a.confidence || e.value_text,
        old_mas: a.old_mas ?? e.value_num, tube_source: a.tube_source ?? null, calibrations: a.calibrations_in_window ?? null });
    }
  }
  return inp;
}

module.exports = { load_inputs, DAYS_SQL };
