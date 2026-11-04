"use strict";
// Derive stage (PLAN-CT-INSIGHTS.md §13.4 step 3). Turns facts into the
// derived tables. Writes only insight.* and runs as insight_writer; the
// caller owns transactions (cli.js derive: rehearse = one rolled-back
// transaction, apply = one transaction per system), and the Phase 5 stage
// calls it after extract with the touched scope extract recorded
// (run.js derive_step, pending.js).
//
// Per system, in order (each later stage sees the earlier ones' output):
//   1. derived facts (system.boot, tube.replacement): whole history
//   2. daily rollup: full, or the touched days + days whose derived facts changed
//   3. exams: full, or from the last exam before the earliest touched day
//   4. tube segments: whole history
//   5. capabilities: whole history (one aggregate)
// Then once per run: 6. clock (fleet-wide, trailing window).
//
// Scope: Map system_id -> { full: true } | { days: Set<'YYYY-MM-DD'> }
// (common.scope_full / scope_touched, or touched_from_source_range).
const { DERIVED_KEYS } = require("../rules/ge_ct_derived");
const { derive_facts_for_system, sync_catalog } = require("./derived_facts");
const { rebuild_daily, OFFSET_BREAKS_SQL } = require("./daily");
const { rebuild_exams } = require("./exams");
const { rebuild_tube_segments } = require("./tube_segments");
const { rebuild_capabilities } = require("./capabilities");
const { rebuild_clock, compute_clock } = require("./clock");
const { scope_full, scope_touched, add_days } = require("./common");

const MIN_SCHEMA_VERSION = 4; // ge_ct_daily.dim, system_clock, tube_source

async function preflight(t, { writer = true } = {}) {
  const who = await t.one("SELECT current_user AS u, (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS su");
  if (writer && (who.u !== process.env.INSIGHT_PG_USER || who.su)) {
    throw new Error(`refusing: connected as ${who.u}, expected the limited ${process.env.INSIGHT_PG_USER}`);
  }
  const v = await t.one("SELECT coalesce(max(version), 0) AS v FROM insight.schema_migrations");
  if (v.v < MIN_SCHEMA_VERSION) throw new Error(`insight schema version ${v.v} < ${MIN_SCHEMA_VERSION}: apply migration 004 first`);
  return { user: who.u, schema_version: v.v };
}

async function all_systems(t) {
  return (await t.any("SELECT DISTINCT system_id FROM insight.ge_ct_facts ORDER BY 1")).map((r) => r.system_id);
}

// Systems and device-clock days that got facts from gesys ids (from_id, to_id]
// (the derive rehearsal's pass 3). The Phase 5 stage doesn't use it: a
// late-committed row's facts have a source id below the watermark, so the
// stage takes the days from the keys extract inserted (pending.js).
// A system with a new fact whose host_datetime is not within a zone offset
// of its host_local gets a full rebuild instead: the touched daily scan's
// time bounds rely on that invariant (daily.js, review F1).
async function touched_from_source_range(t, from_id, to_id) {
  const rows = await t.any(
    `SELECT f.system_id, to_char(f.host_local, 'YYYY-MM-DD') AS day, bool_or(${OFFSET_BREAKS_SQL}) AS offset_breaks
     FROM insight.ge_ct_facts f
     WHERE f.source_id > $1 AND f.source_id <= $2 AND f.metric_key <> ALL($3)
     GROUP BY 1, 2 ORDER BY 1, 2`, [from_id, to_id, DERIVED_KEYS]);
  return scope_from_touched_rows(rows);
}

// Pure: rows {system_id, day, offset_breaks} -> scope.
function scope_from_touched_rows(rows) {
  const scope = scope_touched(rows);
  for (const r of rows) if (r.offset_breaks) scope.set(r.system_id, { full: true });
  return scope;
}

// Stages 1-5 for one system. `scope` is the run's scope map (stage 1 may add
// days to this system's entry).
async function derive_system(t, system_id, scope) {
  const out = { system_id, mode: scope.get(system_id).full ? "full" : "touched" };
  const f = await derive_facts_for_system(t, system_id);
  out.derived_facts = f.stats;
  add_days(scope, system_id, f.changed_days);
  const s = scope.get(system_id);
  out.daily = await rebuild_daily(t, system_id, s);
  out.exams = await rebuild_exams(t, system_id, s);
  out.tube_segments = await rebuild_tube_segments(t, system_id);
  out.capabilities = await rebuild_capabilities(t, system_id);
  return out;
}

module.exports = {
  preflight, all_systems, touched_from_source_range, scope_from_touched_rows, derive_system, sync_catalog,
  rebuild_clock, compute_clock, scope_full, scope_touched, MIN_SCHEMA_VERSION,
};
