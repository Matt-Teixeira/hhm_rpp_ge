"use strict";
// Running the derive stage (PLAN-CT-INSIGHTS.md §13.4 step 4, §10).
//
// Runs ONLY as insight_writer, under the advisory lock shared with extract
// (load.js LOCK_KEY), so a derive never overlaps a backfill or the Phase 5
// stage.
//
//   rehearse: ONE transaction, rolled back. Full rebuild of the selected
//             systems, then a second identical pass (idempotency: derived
//             facts must not change, table contents must be identical),
//             then a touched-days pass over the last TOUCHED_CHECK_IDS
//             gesys ids (must equal the full rebuild), then verify-derive
//             on the uncommitted data, then ROLLBACK.
//   apply   : catalog sync, then one transaction per system, then clock,
//             then insight.job_state 'ge_ct_derive' (watermark = the
//             extract watermark the run covered, for the Phase 5 stage).
//
// Lock-free cores (the CLI and the Phase 5 stage hold the lock):
//   derive_apply_core: the apply loop. Each system's transaction also clears
//             its pending touched days and marks it pending for findings
//             (pending.js), so a failed run is redone by the next one.
//   derive_step: the stage's step: the touched scope recorded by extract
//             (pending.js), not a source-id range, then the clock; advances
//             'ge_ct_derive' to the extract watermark.
const { LOCK_KEY } = require("../load");
const { read_derive_pending, scope_from_pending, clear_derive_pending, mark_findings_pending } = require("../pending");
const { preflight, all_systems, derive_system, sync_catalog, rebuild_clock, scope_full, touched_from_source_range } = require("./index");

// Rehearsal pass 3 rebuilds only the days touched by the last N gesys ids
// (the Phase 5 path) and must reproduce the full rebuild byte for byte.
const TOUCHED_CHECK_IDS = 150000;
const { run_verify } = require("./verify");

const JOB = "ge_ct_derive";

// Content fingerprint of the derived tables (updated_at / computed_at excluded).
const FINGERPRINT_SQL = `SELECT
  (SELECT md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) FROM (SELECT system_id, local_day, metric_key, dim, n, value_sum, value_min, value_max, value_last, last_at FROM insight.ge_ct_daily) x) AS daily,
  (SELECT md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) FROM (SELECT system_id, exam_no, started_at, last_activity_at, local_day, protocol, series, scans, images, aborts_operator, aborts_system, attrs FROM insight.ge_ct_exams) x) AS exams,
  (SELECT md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) FROM (SELECT system_id, segment_start, segment_end, install_date, install_confidence, tube_source, start_mas, latest_mas, latest_at, mas_per_day, readings, ended_reason, evidence FROM insight.ge_ct_tube_segments) x) AS segments,
  (SELECT md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) FROM (SELECT system_id, metric_key, first_seen, last_seen, n FROM insight.system_capabilities) x) AS capabilities,
  (SELECT md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) FROM (SELECT system_id, epoch, record_number_concurrent, metric_key, host_datetime, value_num, value_text, attrs FROM insight.ge_ct_facts WHERE metric_key IN ('system.boot', 'tube.replacement')) x) AS derived_facts`;

const COUNTS_SQL = `SELECT
  (SELECT count(*) FROM insight.ge_ct_facts WHERE metric_key IN ('system.boot', 'tube.replacement'))::int AS derived_facts,
  (SELECT count(*) FROM insight.ge_ct_daily)::int AS daily,
  (SELECT count(*) FROM insight.ge_ct_exams)::int AS exams,
  (SELECT count(*) FROM insight.ge_ct_tube_segments)::int AS tube_segments,
  (SELECT count(*) FROM insight.system_capabilities)::int AS capabilities,
  (SELECT count(*) FROM insight.system_clock)::int AS system_clock`;

function totals(results) {
  const t = { systems: results.length, derived_inserted: 0, derived_updated: 0, derived_deleted: 0, boots: 0, replacements: 0,
    daily_inserted: 0, exams_inserted: 0, tube_segments: 0, capabilities: 0 };
  for (const r of results) {
    t.derived_inserted += r.derived_facts.inserted; t.derived_updated += r.derived_facts.updated; t.derived_deleted += r.derived_facts.deleted;
    t.boots += r.derived_facts.by_metric["system.boot"] || 0; t.replacements += r.derived_facts.by_metric["tube.replacement"] || 0;
    t.daily_inserted += r.daily.inserted; t.exams_inserted += r.exams.inserted;
    t.tube_segments += r.tube_segments.inserted; t.capabilities += r.capabilities.inserted;
  }
  return t;
}

// The pending touched days (pending.js) are kept: only extract adds to them
// and only a system's own derive transaction removes its entry.
const WRITE_JOB_SQL = `INSERT INTO insight.job_state (job_name, watermark_id, last_run_id, last_run_started_at, last_run_finished_at, last_run_status, last_run_stats, updated_at)
     VALUES ($1, $2, $3, $4, now(), $5, $6::jsonb, now())
     ON CONFLICT (job_name) DO UPDATE SET watermark_id = EXCLUDED.watermark_id, last_run_id = EXCLUDED.last_run_id,
       last_run_started_at = EXCLUDED.last_run_started_at, last_run_finished_at = now(), last_run_status = EXCLUDED.last_run_status,
       last_run_stats = jsonb_build_object('pending', coalesce(job_state.last_run_stats -> 'pending', '{}'::jsonb)) || (EXCLUDED.last_run_stats - 'pending'),
       updated_at = now()`;
async function write_job(t, { watermark_id, run_id, started_at, status, stats }) {
  await t.none(WRITE_JOB_SQL, [JOB, watermark_id, run_id, started_at, status, JSON.stringify(stats)]);
}

// Lock-free apply core. One transaction per system (derive, clear its
// pending days, mark it for findings), then clock, then job_state if
// write_watermark. On error: job_state 'error' with prev_watermark, rethrow.
async function derive_apply_core(conn, { list, scope, now, run_id, started_at, watermark, prev_watermark, write_watermark, extra_stats = {}, log = () => {} }) {
  await conn.tx((t) => sync_catalog(t));
  const results = [];
  try {
    for (const s of list) {
      const s0 = Date.now();
      const r = await conn.tx(async (t) => {
        const out = await derive_system(t, s, scope);
        await clear_derive_pending(t, s);
        await mark_findings_pending(t, s);
        return out;
      });
      r.ms = Date.now() - s0;
      results.push(r);
      log(`  ${s}: derived +${r.derived_facts.inserted} ~${r.derived_facts.updated} -${r.derived_facts.deleted}; daily ${r.daily.inserted}; exams ${r.exams.inserted}; segments ${r.tube_segments.inserted}; capabilities ${r.capabilities.inserted}; ${r.ms} ms (committed)`);
    }
    const clock = await conn.tx((t) => rebuild_clock(t, now));
    log(`  clock: ${clock.upserted} systems ${JSON.stringify(clock.flags)} (committed)`);
    const stats = { ...totals(results), clock: clock.flags, ...extra_stats };
    if (write_watermark) await conn.tx((t) => write_job(t, { watermark_id: watermark, run_id, started_at, status: "ok", stats }));
    return { stats, results, clock };
  } catch (e) {
    const stats = { ...totals(results), error: e.message, failed_after: results.map((r) => r.system_id) };
    // keep the last good watermark; record the error
    await conn.tx((t) => write_job(t, { watermark_id: prev_watermark, run_id, started_at, status: "error", stats })).catch(() => {});
    throw e;
  }
}

// The stage's derive step (lock-free; the caller holds LOCK_KEY).
async function derive_step(conn, { now = new Date(), run_id, started_at = new Date(), log = () => {} }) {
  const extract = await conn.oneOrNone("SELECT watermark_id FROM insight.job_state WHERE job_name = 'ge_ct_extract'");
  const prev = await conn.oneOrNone("SELECT watermark_id FROM insight.job_state WHERE job_name = $1", [JOB]);
  const watermark = extract ? Number(extract.watermark_id) : 0;
  const prev_watermark = prev ? Number(prev.watermark_id) : 0;
  const scope = scope_from_pending(await read_derive_pending(conn));
  const list = [...scope.keys()];
  const days = [...scope.values()].reduce((n, v) => n + (v.days ? v.days.size : 0), 0);
  const full = list.filter((s) => scope.get(s).full);
  const r = await derive_apply_core(conn, { list, scope, now, run_id, started_at, watermark, prev_watermark, write_watermark: true,
    extra_stats: { mode: "touched", systems_selected: list.length, days, full_rebuilds: full }, log });
  return { from: prev_watermark, watermark, systems: list.length, days, full_rebuilds: full,
    per_system_ms: Object.fromEntries(r.results.map((x) => [x.system_id, x.ms])), stats: r.stats };
}

async function run_derive(db, { mode, systems = null, now = new Date(), run_id, log = () => {} }) {
  if (!["rehearse", "apply"].includes(mode)) throw new Error(`bad mode ${mode}`);
  const started_at = new Date();
  return db.task(async (conn) => {
    const { got } = await conn.one("SELECT pg_try_advisory_lock(hashtext($1)) AS got", [LOCK_KEY]);
    if (!got) return { skipped: "another insight run holds the lock" };
    try {
      const pre = await preflight(conn);
      const extract = await conn.oneOrNone("SELECT watermark_id FROM insight.job_state WHERE job_name = 'ge_ct_extract'");
      const prevJob = await conn.oneOrNone("SELECT watermark_id FROM insight.job_state WHERE job_name = $1", [JOB]);
      const watermark = extract ? Number(extract.watermark_id) : 0;
      const list = systems || (await all_systems(conn));
      log(`preflight: user=${pre.user} schema_version=${pre.schema_version}; extract watermark ${watermark}; ${list.length} systems; clock window ends ${now.toISOString()}`);

      const pass = async (t, label, scopeIn = null) => {
        const scope = scopeIn || scope_full(list);
        const which = scopeIn ? list.filter((s) => scope.has(s)) : list;
        const results = [];
        const t0 = Date.now();
        for (const s of which) {
          const s0 = Date.now();
          const r = await derive_system(t, s, scope);
          r.ms = Date.now() - s0;
          results.push(r);
          log(`  ${label} ${s}: derived +${r.derived_facts.inserted} ~${r.derived_facts.updated} -${r.derived_facts.deleted} (boots ${r.derived_facts.by_metric["system.boot"] || 0}, replacements ${r.derived_facts.by_metric["tube.replacement"] || 0}); daily ${r.daily.inserted}; exams ${r.exams.inserted}; segments ${r.tube_segments.inserted}; capabilities ${r.capabilities.inserted}; ${r.ms} ms`);
        }
        const clock = await rebuild_clock(t, now);
        log(`  ${label} clock: ${clock.upserted} systems ${JSON.stringify(clock.flags)}${clock.skipped.length ? `; skipped (< 5 captures) ${clock.skipped.join(", ")}` : ""}`);
        return { results, totals: totals(results), clock, ms: Date.now() - t0 };
      };

      if (mode === "rehearse") {
        return await conn.tx(async (t) => {
          const before = await t.one(COUNTS_SQL);
          log(`before (inside the transaction): ${JSON.stringify(before)}`);
          await sync_catalog(t);
          const p1 = await pass(t, "pass 1");
          const after1 = await t.one(COUNTS_SQL);
          const fp1 = await t.one(FINGERPRINT_SQL);
          log(`pass 1 (${(p1.ms / 1000).toFixed(1)}s): ${JSON.stringify(p1.totals)}`);
          log(`after pass 1: ${JSON.stringify(after1)}`);
          const p2 = await pass(t, "pass 2");
          const fp2 = await t.one(FINGERPRINT_SQL);
          const changed = Object.keys(fp1).filter((k) => fp1[k] !== fp2[k]);
          const idem = { derived_changes: p2.totals.derived_inserted + p2.totals.derived_updated + p2.totals.derived_deleted, tables_changed: changed };
          log(`pass 2 (idempotency, ${(p2.ms / 1000).toFixed(1)}s): derived facts inserted/updated/deleted ${p2.totals.derived_inserted}/${p2.totals.derived_updated}/${p2.totals.derived_deleted}; table contents changed: ${changed.length ? changed.join(", ") : "none"}`);
          const tscope = await touched_from_source_range(t, Math.max(0, watermark - TOUCHED_CHECK_IDS), watermark);
          const tdays = [...tscope.values()].reduce((n, v) => n + (v.days ? v.days.size : 0), 0);
          const p3 = await pass(t, "pass 3", tscope);
          const fp3 = await t.one(FINGERPRINT_SQL);
          const changed3 = Object.keys(fp1).filter((k) => fp1[k] !== fp3[k]);
          idem.touched = { systems: tscope.size, days: tdays, full_promoted: [...tscope.values()].filter((v) => v.full).length,
            daily_rebuilt: p3.totals.daily_inserted, exams_rebuilt: p3.totals.exams_inserted, tables_changed: changed3 };
          log(`pass 3 (touched days of gesys ids ${Math.max(0, watermark - TOUCHED_CHECK_IDS)}..${watermark}: ${tscope.size} systems, ${tdays} days, ${(p3.ms / 1000).toFixed(1)}s): daily rows rebuilt ${p3.totals.daily_inserted}, exams rebuilt ${p3.totals.exams_inserted}; differs from the full rebuild: ${changed3.length ? changed3.join(", ") : "nothing"}`);
          log("verify-derive on the rehearsed (uncommitted) data:");
          const v = await run_verify(t, (m) => log(`  ${m}`));
          throw Object.assign(new Error("ROLLBACK (rehearsal)"), { rehearsal: { before, after1, pass1: p1.totals, idem, verify_ok: v.ok, clock: p1.clock.flags } });
        }).catch((e) => {
          if (e.rehearsal) return { rolled_back: true, ...e.rehearsal };
          throw e;
        });
      }

      // apply: catalog, one transaction per system, clock, job_state
      // the watermark only means "derive covered facts up to here" after a fleet-wide run
      const r = await derive_apply_core(conn, { list, scope: scope_full(list), now, run_id, started_at, watermark,
        prev_watermark: prevJob ? Number(prevJob.watermark_id) : 0, write_watermark: !systems,
        extra_stats: { systems_selected: systems ? systems.length : "all" }, log });
      return { stats: r.stats, watermark: systems ? null : watermark, after: await conn.one(COUNTS_SQL) };
    } finally {
      await conn.one("SELECT pg_advisory_unlock(hashtext($1)) AS ok", [LOCK_KEY]);
    }
  });
}

module.exports = { run_derive, derive_apply_core, derive_step, JOB, COUNTS_SQL, FINGERPRINT_SQL, WRITE_JOB_SQL, totals };
