"use strict";
// The ge_ct insight stage's steps (PLAN-CT-INSIGHTS.md §15.2). Lock-free:
// the live stage (insight/index.js) and `cli.js stage --rehearse` hold
// load.js LOCK_KEY around it.
//
//   1. extract : the late-commit re-read, then at most one 50k batch from
//                the 'ge_ct_extract' watermark (§15.3 Q2, Q5)
//   2. derive  : the touched days extract recorded (pending.js), one
//                transaction per system, then the clock; 'ge_ct_derive' =
//                the extract watermark
//   3. findings: default mode for the systems derive touched; all systems on
//                the first run of a new UTC date (§15.3 Q3); 'ge_ct_findings'
//                = the derive watermark
//
// A step runs only if the one before it succeeded. Each catches up from its
// own state, so the next run redoes a failed or skipped step.
const crypto = require("crypto");
const { extract_step, preflight: extract_preflight, LOCK_KEY } = require("./load");
const { derive_step, COUNTS_SQL: DERIVE_COUNTS_SQL, FINGERPRINT_SQL: DERIVE_FINGERPRINT_SQL } = require("./derive/run");
const { all_systems: derive_systems, derive_system, scope_full } = require("./derive/index");
const { run_verify: run_verify_derive } = require("./derive/verify");
const { findings_step, findings_system, all_systems: findings_systems, read_as_of,
  COUNTS_SQL: FINDINGS_COUNTS_SQL, FINGERPRINT_SQL: FINDINGS_FINGERPRINT_SQL } = require("./findings/run");
const { run_verify: run_verify_findings } = require("./findings/verify");
const { verify_facts } = require("./verify_facts");
const { validate_rules } = require("./rules/engine");
const { read_derive_pending, pending_summary } = require("./pending");

const MIN_SCHEMA_VERSION = 5; // findings (migration 005)
const JOBS = ["ge_ct_extract", "ge_ct_derive", "ge_ct_findings"];
const STEPS = { extract: extract_step, derive: derive_step, findings: findings_step };
const utc_day = (d) => new Date(d).toISOString().slice(0, 10);

// Writer role (not superuser), schema >= 5, partition runway (load.js).
async function stage_preflight(conn) {
  const pre = await extract_preflight(conn);
  if (pre.schema_version < MIN_SCHEMA_VERSION) throw new Error(`insight schema version ${pre.schema_version} < ${MIN_SCHEMA_VERSION}: apply migrations first`);
  return pre;
}

async function read_watermarks(conn) {
  const rows = await conn.any("SELECT job_name, watermark_id FROM insight.job_state WHERE job_name = ANY($1)", [JOBS]);
  const w = Object.fromEntries(JOBS.map((j) => [j, null]));
  for (const r of rows) w[r.job_name] = Number(r.watermark_id);
  return w;
}
const watermarks_equal = (w) => w.ge_ct_extract !== null && w.ge_ct_extract === w.ge_ct_derive && w.ge_ct_derive === w.ge_ct_findings;

// One stage run on conn (a task, or a transaction in the rehearsal: each
// step's transactions then become savepoints). Never throws for a step
// failure: it is returned as { ok: false, failed, error }.
async function run_stage(conn, { rules, now = new Date(), run_id, to_id = null, max_batches = 1, force_daily = false, log = () => {}, steps = STEPS }) {
  const today = utc_day(now);
  const started_at = new Date();
  const out = { today, steps: {}, ok: true, failed: null, error: null };
  const plan = [
    ["extract", () => {
      const errs = validate_rules(rules);
      if (errs.length) throw new Error(`invalid rules: ${errs.join("; ")}`);
      return steps.extract(conn, { rules, run_id, started_at, max_batches, to_id, log });
    }],
    ["derive", () => steps.derive(conn, { now, run_id, started_at, log })],
    ["findings", () => steps.findings(conn, { today, run_id, started_at, force_daily, log })],
  ];
  for (const [name, fn] of plan) {
    const t0 = Date.now();
    try {
      out.steps[name] = { ...(await fn()), ms: Date.now() - t0 };
    } catch (e) {
      out.steps[name] = { error: e.message, ms: Date.now() - t0 };
      Object.assign(out, { ok: false, failed: name, error: e });
      break;
    }
  }
  try {
    out.watermarks = await read_watermarks(conn);
    out.watermarks_equal = watermarks_equal(out.watermarks);
  } catch (e) {
    out.watermarks = null;
    out.watermarks_equal = false;
    if (out.ok) Object.assign(out, { ok: false, failed: "watermarks", error: e });
  }
  return out;
}

// --------------------------------------------------------------- summaries
// Small, log-friendly views of a step result (run_log notes, CLI output).

function nonzero(o) {
  return Object.fromEntries(Object.entries(o || {}).filter(([, v]) => v));
}

function summarize(name, s) {
  if (s.error) return { error: s.error, ms: s.ms };
  if (name === "extract") {
    const x = s.stats;
    return { ms: s.ms, from: s.from, to: s.watermark, behind_ids: s.behind_ids, batches: x.batches, rows: x.rows, facts: x.facts, upserted: x.upserted,
      collisions: x.collisions, rule_errors: x.rule_errors, skipped: nonzero(x.skipped),
      late: { rows: x.late.rows, facts: x.late.facts, inserted: x.late.inserted, systems: x.late.systems, rule_errors: x.late.rule_errors } };
  }
  if (name === "derive") {
    const x = s.stats;
    return { ms: s.ms, from: s.from, to: s.watermark, systems: s.systems, days: s.days, full_rebuilds: s.full_rebuilds,
      derived: { inserted: x.derived_inserted, updated: x.derived_updated, deleted: x.derived_deleted },
      daily_rows: x.daily_inserted, exam_rows: x.exams_inserted, clock: x.clock, per_system_ms: s.per_system_ms };
  }
  if (name === "findings") {
    const x = s.stats;
    return { ms: s.ms, from: s.from, to: s.watermark, mode: s.mode, systems: s.systems, evaluated: x.evaluated, skipped_stale: s.skipped_stale,
      inserted: x.inserted, updated: x.updated, deleted: x.deleted, drift: x.drift, findings: x.findings, open: x.open,
      ...(s.drift_detail.length ? { drift_detail: s.drift_detail } : {}) };
  }
  return { ms: s.ms };
}

// A successful step that still deserves a WARN in the run log.
function step_warnings(name, s) {
  const w = [];
  if (s.error) return w;
  if (name === "extract") {
    if (s.stats.late.inserted) w.push(`late-commit re-read inserted ${s.stats.late.inserted} facts (${s.stats.late.systems.join(", ")})`);
    if (s.stats.rule_errors || s.stats.late.rule_errors) w.push(`rule errors: ${s.stats.rule_errors + s.stats.late.rule_errors}`);
  }
  if (name === "findings" && s.stats.drift) w.push(`findings drift: ${s.stats.drift}`);
  return w;
}

// ---------------------------------------------------------------- rehearsal

// `cli.js stage --rehearse` (§15.2 item 4). ONE transaction, rolled back,
// under the lock. Runs the stage as production would, on the current
// pending range:
//   run 1  catch-up : the pending range up to the last ge_ct run (if any)
//   run 2  typical  : the last ge_ct run's rows (what a 30-min run brings)
//   run 3  daily    : no new rows, findings for all systems (the daily pass)
// then, on the uncommitted data: verify, verify-derive, verify-findings;
// derive touched = full rebuild (content fingerprints); findings default =
// replay (fingerprint). Then ROLLBACK.
const LAST_RUN_GAP = "15 minutes"; // ge_ct runs are 30 min apart; one run's captures span a few minutes

async function rehearse_stage(db, { rules, log = () => {} }) {
  return db.task(async (conn) => {
    const { got } = await conn.one("SELECT pg_try_advisory_lock(hashtext($1)) AS got", [LOCK_KEY]);
    if (!got) return { skipped: "another insight run holds the lock" };
    try {
      const pre = await stage_preflight(conn);
      log(`preflight: user=${pre.user} schema_version=${pre.schema_version} last_partition=${pre.last_partition} (${pre.months_left} months left)${pre.partition_warning ? " WARNING: add partitions" : ""}`);
      return await conn.tx(async (t) => {
        const before = { watermarks: await read_watermarks(t), derive: await t.one(DERIVE_COUNTS_SQL), findings: await t.one(FINDINGS_COUNTS_SQL),
          derive_pending: pending_summary(await read_derive_pending(t)) };
        const wm = before.watermarks.ge_ct_extract;
        const range = await t.one(`WITH p AS (SELECT id, capture_datetime FROM log.ge_ct_gesys WHERE id > $1)
          SELECT (SELECT max(id) FROM p)::bigint AS max_id, (SELECT count(*) FROM p)::int AS n,
                 (SELECT min(capture_datetime) FROM p) AS first_capture, (SELECT max(capture_datetime) FROM p) AS last_capture,
                 (SELECT min(id) FROM p WHERE capture_datetime > (SELECT max(capture_datetime) FROM p) - interval '${LAST_RUN_GAP}')::bigint AS last_run_from,
                 (SELECT count(*) FROM p WHERE capture_datetime > (SELECT max(capture_datetime) FROM p) - interval '${LAST_RUN_GAP}')::int AS last_run_rows`, [wm]);
        log(`before (inside the transaction): ${JSON.stringify(before)}`);
        log(`pending range: ids ${wm + 1}..${range.max_id}, ${range.n} rows, captured ${range.first_capture && range.first_capture.toISOString()} .. ${range.last_capture && range.last_capture.toISOString()}; the last ge_ct run: ${range.last_run_rows} rows from id ${range.last_run_from}`);

        const runs = [];
        const max_id = range.max_id === null ? wm : Number(range.max_id);
        const last_from = range.last_run_from === null ? null : Number(range.last_run_from);
        if (last_from !== null && last_from - 1 > wm) runs.push({ label: "run 1, catch-up (pending range before the last ge_ct run)", to_id: last_from - 1 });
        runs.push({ label: `run ${runs.length + 1}, typical (the last ge_ct run's rows)`, to_id: max_id });
        runs.push({ label: `run ${runs.length + 1}, daily pass (no new rows; findings for all systems)`, to_id: max_id, force_daily: true });
        for (const r of runs) {
          const res = await run_stage(t, { rules, now: new Date(), run_id: crypto.randomUUID(), to_id: r.to_id, force_daily: !!r.force_daily });
          r.ok = res.ok; r.failed = res.failed; r.error = res.error ? res.error.message : null; r.today = res.today;
          r.watermarks = res.watermarks; r.watermarks_equal = res.watermarks_equal;
          r.steps = Object.fromEntries(Object.entries(res.steps).map(([k, s]) => [k, summarize(k, s)]));
          r.warnings = Object.entries(res.steps).flatMap(([k, s]) => step_warnings(k, s));
          r.ms = Object.values(res.steps).reduce((n, s) => n + s.ms, 0);
          log(`${r.label}: ${r.ok ? "ok" : `FAILED at ${r.failed}: ${r.error}`}, ${r.ms} ms; watermarks ${JSON.stringify(r.watermarks)}${r.watermarks_equal ? " (equal)" : " NOT EQUAL"}`);
          for (const [k, s] of Object.entries(r.steps)) log(`  ${k}: ${JSON.stringify(s)}`);
          for (const w of r.warnings) log(`  WARNING: ${w}`);
          if (!r.ok) break;
        }
        const today = runs[runs.length - 1].today;
        const checks = {
          runs_ok: runs.every((r) => r.ok),
          watermarks_equal_after_each_run: runs.every((r) => r.watermarks_equal),
          caught_up: runs.every((r) => r.ok) && runs[runs.length - 1].watermarks.ge_ct_extract === max_id,
          findings_drift: runs.reduce((n, r) => n + ((r.steps.findings && r.steps.findings.drift) || 0), 0),
          derive_pending_left: pending_summary(await read_derive_pending(t)),
        };

        log("verify on the rehearsed (uncommitted) facts:");
        const vf = await verify_facts(t, runs[runs.length - 1].watermarks.ge_ct_extract);
        checks.verify = { ok: vf.ok, cells: vf.cells, differ: vf.diffs.length, facts: vf.total, catalog: vf.catalog };
        log(`  ${vf.cells} system×metric cells, ${vf.diffs.length ? `${vf.diffs.length} differ: ${JSON.stringify(vf.diffs.slice(0, 10))}` : "all equal"}; catalog ${JSON.stringify(vf.catalog)}`);
        log("verify-derive on the rehearsed data:");
        checks.verify_derive = (await run_verify_derive(t, (m) => log(`  ${m}`))).ok;
        log("verify-findings on the rehearsed rows:");
        checks.verify_findings = (await run_verify_findings(t, { today, as_of_by_system: await read_as_of(t), log: (m) => log(`  ${m}`) })).ok;

        // derive touched = full rebuild
        const fp_touched = await t.one(DERIVE_FINGERPRINT_SQL);
        const t1 = Date.now();
        const systems = await derive_systems(t);
        let derived_changes = 0;
        for (const s of systems) {
          const r = await t.tx((tt) => derive_system(tt, s, scope_full([s])));
          derived_changes += r.derived_facts.inserted + r.derived_facts.updated + r.derived_facts.deleted;
        }
        const fp_full = await t.one(DERIVE_FINGERPRINT_SQL);
        const differs = Object.keys(fp_full).filter((k) => fp_full[k] !== fp_touched[k]);
        checks.derive_touched_eq_full = { same: !differs.length && !derived_changes, differs, derived_changes, systems: systems.length, full_rebuild_ms: Date.now() - t1 };
        log(`derive touched vs full rebuild of ${systems.length} systems (${Date.now() - t1} ms): ${differs.length ? `DIFFERS in ${differs.join(", ")}` : "identical"}; derived-fact changes ${derived_changes}`);

        // findings default = replay
        const fp_default = await t.one(FINDINGS_FINGERPRINT_SQL);
        const t2 = Date.now();
        const fsys = await findings_systems(t);
        let replay_changes = 0;
        for (const s of fsys) {
          const r = await t.tx((tt) => findings_system(tt, s, { today, replay: true }));
          replay_changes += r.inserted + r.updated + r.deleted;
        }
        const fp_replay = await t.one(FINDINGS_FINGERPRINT_SQL);
        checks.findings_default_eq_replay = { same: fp_default.md5 === fp_replay.md5 && !replay_changes, findings: fp_default.n, replay_findings: fp_replay.n, replay_changes, replay_ms: Date.now() - t2 };
        log(`findings default vs replay as of ${today} (${fsys.length} systems, ${Date.now() - t2} ms): ${checks.findings_default_eq_replay.same ? "identical" : "DIFFER"} (${fp_default.n} vs ${fp_replay.n} findings; replay changed ${replay_changes})`);

        const ok = checks.runs_ok && checks.watermarks_equal_after_each_run && checks.caught_up && !checks.findings_drift && !checks.derive_pending_left.systems
          && checks.verify.ok && checks.verify_derive && checks.verify_findings && checks.derive_touched_eq_full.same && checks.findings_default_eq_replay.same;
        throw Object.assign(new Error("ROLLBACK (rehearsal)"), { rehearsal: { preflight: pre, before, range, runs, checks, ok } });
      }).catch((e) => {
        if (e.rehearsal) return { rolled_back: true, ...e.rehearsal };
        throw e;
      });
    } finally {
      await conn.one("SELECT pg_advisory_unlock(hashtext($1)) AS ok", [LOCK_KEY]);
    }
  });
}

module.exports = { run_stage, rehearse_stage, stage_preflight, read_watermarks, watermarks_equal, summarize, step_warnings, utc_day, STEPS, LOCK_KEY, MIN_SCHEMA_VERSION };
