"use strict";
// The GE MRI insight stage's steps (PLAN-MRI-INSIGHTS.md §11.2 item 3), the
// MRI counterpart of insight/cv/stage.js. Lock-free: the live stage
// (./index.js through ../stage_wrapper.js) and `mri/cli.js stage
// --rehearse` hold load.js LOCK_KEY around it.
//
//   1. extract : catalog sync, the late-commit re-read, then at most one 50k
//                batch from the 'ge_mri_extract' watermark (§11.3 Q6)
//   2. derive  : the pending device days the extract recorded, one
//                transaction per system, then the code labels if owed
//                (every run with new rows, §11.3 Q3);
//                'ge_mri_derive' watermark = the extract watermark
//   3. findings: the MRI-4 apply preflight (derive caught up, facts =
//                daily), then default mode, all systems, every run
//                (§11.3 Q4); 'ge_mri_findings' watermark = the derive one
//
// A step runs only if the one before it succeeded. Each catches up from its
// own state, so the next run redoes a failed or skipped step.
//
// Loaded only by the GE_MRI run (./index.js) and mri/cli.js; nothing in the
// GE CT or CV run loads this file.
const crypto = require("crypto");
const { pgp } = require("../db");
const load = require("./load");
const derive = require("./derive");
const frun = require("./findings/run");
const { verify_mri_facts } = require("./verify");
const { verify_mri_derive } = require("./verify_derive");
const { run_verify: run_verify_findings } = require("./findings/verify");

const LOCK_KEY = load.LOCK_KEY;
const MIN_SCHEMA_VERSION = load.MIN_SCHEMA_VERSION; // 009
const JOBS = [load.JOB, load.DERIVE_JOB, frun.JOB];
// A derive slower than this is a WARN: the code-label rebuild grows with
// mri.error (plan §11.1: 7.6-9.4 s on 2026-11-16, ~8% a month; §11.3 Q3).
const DERIVE_WARN_MS = 30000;
const utc_day = (d) => new Date(d).toISOString().slice(0, 10);

const STEPS = {
  extract: (conn, o) => load.extract_step(conn, o),
  derive: (conn, o) => derive.derive_step(conn, pgp, o),
  findings: async (conn, o) => {
    await frun.preflight(conn, { mode: "apply" });
    return frun.findings_step(conn, o);
  },
};

// The extract apply preflight (the writer role, not a superuser; schema >=
// 9; C2-MRI; C1-MRI), plus an extract watermark: the first run catches up
// from the backfill, it never starts one (§11.3 Q7).
async function stage_preflight(conn) {
  const pre = await load.preflight(conn, { mode: "apply" });
  if (pre.schema_version < MIN_SCHEMA_VERSION) throw new Error(`insight schema version ${pre.schema_version} < ${MIN_SCHEMA_VERSION}: apply migration 009 first`);
  if (!(await load.read_job(conn))) throw new Error("no ge_mri_extract watermark: run `mri/cli.js backfill --apply` first");
  return pre;
}

async function read_watermarks(conn) {
  const rows = await conn.any("SELECT job_name, watermark_id FROM insight.job_state WHERE job_name = ANY($1)", [JOBS]);
  const w = Object.fromEntries(JOBS.map((j) => [j, null]));
  for (const r of rows) w[r.job_name] = Number(r.watermark_id);
  return w;
}
const watermarks_equal = (w) => w[JOBS[0]] !== null && w[JOBS[0]] === w[JOBS[1]] && w[JOBS[1]] === w[JOBS[2]];

// One stage run on conn (a task, or a transaction in the rehearsal: each
// step's transactions then become savepoints). Never throws for a step
// failure: it is returned as { ok: false, failed, error }.
async function run_stage(conn, { now = new Date(), run_id, to_id = null, max_batches = 1, log = () => {}, steps = STEPS }) {
  const today = utc_day(now);
  const started_at = new Date();
  const out = { today, steps: {}, ok: true, failed: null, error: null };
  const plan = [
    ["extract", () => steps.extract(conn, { run_id, started_at, max_batches, to_id, log })],
    ["derive", () => steps.derive(conn, { run_id, started_at })],
    ["findings", () => steps.findings(conn, { today, run_id, started_at })],
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
    const late = x.late || {};
    return { ms: s.ms, from: s.from, to: s.watermark, behind_ids: s.behind_ids, batches: x.batches, rows: x.rows, records: x.records, duplicates: x.duplicates,
      facts: x.facts, upserted: x.upserted, collisions: x.collisions, skipped: nonzero(x.skipped), rule_errors: x.rule_errors, unreviewed_codes: x.unreviewed_codes,
      late: { rows: late.rows || 0, facts: late.facts || 0, inserted: late.inserted || 0, systems: late.systems || [] } };
  }
  if (name === "derive") {
    const x = s.stats;
    const ran = x.daily.filter((d) => d.scope !== "none");
    return { ms: s.ms, to: s.watermark, systems: ran.map((d) => d.system_id),
      days: ran.reduce((n, d) => n + (typeof d.scope === "number" ? d.scope : 0), 0), full: ran.filter((d) => d.scope === "full").length,
      daily: { deleted: ran.reduce((n, d) => n + d.deleted, 0), inserted: ran.reduce((n, d) => n + d.inserted, 0) }, codes: x.codes,
      pending_after: Object.keys(s.pending_after || {}) };
  }
  if (name === "findings") {
    const x = s.stats;
    return { ms: s.ms, to: s.watermark, evaluated: x.evaluated, skipped_stale: x.skipped_stale, inserted: x.inserted, updated: x.updated, deleted: x.deleted,
      drift: x.drift, findings: x.findings, open: x.open, ...(s.drift_detail && s.drift_detail.length ? { drift_detail: s.drift_detail } : {}) };
  }
  return { ms: s.ms };
}

// A successful step that still deserves a WARN in the run log.
function step_warnings(name, s) {
  const w = [];
  if (s.error) return w;
  if (name === "extract") {
    const late = s.stats.late || {};
    if (late.inserted) w.push(`late-commit re-read inserted ${late.inserted} facts (${late.systems.join(", ")})`);
    if (s.stats.rule_errors) w.push(`${s.stats.rule_errors} rule errors (rows the MRI rules could not classify; see mri/cli.js dry-run)`);
    if (s.stats.unreviewed_codes && s.stats.unreviewed_codes.length) w.push(`error codes not yet reviewed (counted in mri.error only): ${s.stats.unreviewed_codes.join(", ")}`);
    if (s.behind_ids) w.push(`extract is ${s.behind_ids} ids behind the source (one batch per run; the next runs catch up)`);
  }
  if (name === "derive") {
    if (s.pending_after && Object.keys(s.pending_after).length) w.push(`derive left pending days: ${Object.keys(s.pending_after).join(", ")}`);
    if (s.ms > DERIVE_WARN_MS) w.push(`derive took ${s.ms} ms (> ${DERIVE_WARN_MS}): the code-label rebuild grows with mri.error; plan a cheaper rebuild (plan §11.3 Q3)`);
  }
  if (name === "findings" && s.stats.drift) w.push(`findings drift: ${s.stats.drift}`);
  return w;
}

// ---------------------------------------------------------------- rehearsal

// Everything that is not MRI: must be the same before and after the stage.
const OTHERS_SQL = `SELECT
  (SELECT md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) FROM (SELECT * FROM insight.findings WHERE source <> 'ge_mri') x) AS findings,
  (SELECT md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) FROM (SELECT * FROM insight.finding_catalog WHERE left(finding_key, 4) <> 'mri_') x) AS finding_catalog,
  (SELECT md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) FROM (SELECT * FROM insight.metric_catalog WHERE left(metric_key, 4) <> 'mri.') x) AS metric_catalog,
  (SELECT md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) FROM (SELECT * FROM insight.job_state WHERE left(job_name, 7) <> 'ge_mri_') x) AS job_state`;
const MRI_COUNTS_SQL = `SELECT (SELECT count(*) FROM insight.ge_mri_facts)::int AS facts, (SELECT count(*) FROM insight.ge_mri_daily)::int AS daily,
  (SELECT count(*) FROM insight.ge_mri_codes)::int AS codes, (SELECT count(*) FROM insight.findings WHERE source = 'ge_mri')::int AS findings,
  (SELECT count(*) FROM insight.findings WHERE source = 'ge_mri' AND status = 'open')::int AS open`;
// REPEATABLE READ (as CV review CV5-STAGE): every check sees one snapshot,
// so a CT or CV stage (or a GE_MRI ingest) committing during the rehearsal
// can't show as "others changed". The rehearsal writes only MRI rows, which
// only holders of the MRI lock write, so it can't hit a serialization
// failure.
const REHEARSAL_TX_MODE = new pgp.txMode.TransactionMode({ tiLevel: pgp.txMode.isolationLevel.repeatableRead });
const LAST_RUN_GAP = "15 minutes"; // GE_MRI runs are 30 min apart; one run's captures span seconds
const RANGE_SQL = `WITH p AS (SELECT id, capture_datetime FROM log.ge_mri_gesys WHERE id > $1)
  SELECT (SELECT max(id) FROM p)::bigint AS max_id, (SELECT count(*) FROM p)::int AS n,
         (SELECT min(capture_datetime) FROM p) AS first_capture, (SELECT max(capture_datetime) FROM p) AS last_capture,
         (SELECT min(id) FROM p WHERE capture_datetime > (SELECT max(capture_datetime) FROM p) - interval '${LAST_RUN_GAP}')::bigint AS last_run_from,
         (SELECT count(*) FROM p WHERE capture_datetime > (SELECT max(capture_datetime) FROM p) - interval '${LAST_RUN_GAP}')::int AS last_run_rows`;

async function derive_state(t) {
  const d = await t.oneOrNone("SELECT last_run_stats -> 'pending' AS p, last_run_stats -> 'codes_pending' AS c FROM insight.job_state WHERE job_name = $1", [load.DERIVE_JOB]);
  return { pending: d && d.p ? Object.keys(d.p) : [], codes_owed: !!(d && d.c === true) };
}

// `mri/cli.js stage --rehearse` (§11.2 item 4). ONE transaction, rolled
// back, under the lock. Runs the stage as production would, on the current
// pending range:
//   run 1  catch-up : the pending range before the last GE_MRI run (if any)
//   run 2  typical  : the last GE_MRI run's rows
//   run 3  no rows  : what most runs are
// then, on the uncommitted data: verify, verify-derive, verify-findings;
// derive touched = full rebuild (content fingerprint); findings default =
// replay (fingerprint); every non-MRI row unchanged. Then ROLLBACK, and the
// watermarks are read again.
async function rehearse_stage(db, { log = () => {}, now = () => new Date(), on_run = async () => {} } = {}) {
  return db.task(async (conn) => {
    const { got } = await conn.one("SELECT pg_try_advisory_lock(hashtext($1)) AS got", [LOCK_KEY]);
    if (!got) return { skipped: "another GE MRI insight run holds the lock" };
    try {
      const pre = await stage_preflight(conn);
      log(`preflight: user=${pre.user} schema_version=${pre.schema_version} last_partition=${pre.last_partition} (${pre.months_left} months left${pre.partition_warning ? ": ADD PARTITIONS" : ""})`);
      const wm_before = await read_watermarks(conn);
      const res = await conn.tx({ mode: REHEARSAL_TX_MODE }, async (t) => {
        const before = { watermarks: await read_watermarks(t), counts: await t.one(MRI_COUNTS_SQL), derive: await derive_state(t) };
        const others_before = await t.one(OTHERS_SQL);
        const wm = before.watermarks[load.JOB];
        if (wm === null) throw new Error("no ge_mri_extract watermark: run `mri/cli.js backfill --apply` first");
        const range = await t.one(RANGE_SQL, [wm]);
        log(`before (inside the transaction): ${JSON.stringify(before)}`);
        log(`pending range: ids ${wm + 1}..${range.max_id}, ${range.n} rows, captured ${range.first_capture && range.first_capture.toISOString()} .. ${range.last_capture && range.last_capture.toISOString()}; the last GE_MRI run: ${range.last_run_rows} rows from id ${range.last_run_from}`);

        // planned: every run the rehearsal intends; runs: those executed. After
        // a failed run the loop stops, and every check below reads only the
        // executed runs (review MRI5-STAGE P3).
        const planned = [];
        const max_id = range.max_id === null ? wm : Number(range.max_id);
        const last_from = range.last_run_from === null ? null : Number(range.last_run_from);
        if (last_from !== null && last_from - 1 > wm) planned.push({ label: "run 1, catch-up (pending range before the last GE_MRI run)", to_id: last_from - 1 });
        planned.push({ label: `run ${planned.length + 1}, typical (the last GE_MRI run's rows)`, to_id: max_id });
        planned.push({ label: `run ${planned.length + 1}, no new rows (what most runs are)`, to_id: max_id });
        const runs = [];
        for (const r of planned) {
          runs.push(r);
          const res = await run_stage(t, { now: now(), run_id: crypto.randomUUID(), to_id: r.to_id });
          r.ok = res.ok; r.failed = res.failed; r.error = res.error ? res.error.message : null; r.today = res.today;
          r.watermarks = res.watermarks; r.watermarks_equal = res.watermarks_equal;
          r.steps = Object.fromEntries(Object.entries(res.steps).map(([k, s]) => [k, summarize(k, s)]));
          r.warnings = Object.entries(res.steps).flatMap(([k, s]) => step_warnings(k, s));
          r.ms = Object.values(res.steps).reduce((n, s) => n + s.ms, 0);
          log(`${r.label}: ${r.ok ? "ok" : `FAILED at ${r.failed}: ${r.error}`}, ${r.ms} ms; watermarks ${JSON.stringify(r.watermarks)}${r.watermarks_equal ? " (equal)" : " NOT EQUAL"}`);
          for (const [k, s] of Object.entries(r.steps)) log(`  ${k}: ${JSON.stringify(s)}`);
          for (const w of r.warnings) log(`  WARNING: ${w}`);
          if (!r.ok) break;
          await on_run(r); // tests only: e.g. a concurrent CT / CV commit
        }
        const last = runs[runs.length - 1];
        const today = last.today;
        const all_ok = runs.length === planned.length && runs.every((r) => r.ok);
        const not_run = planned.slice(runs.length).map((r) => r.label);
        if (not_run.length) log(`not run after the failure: ${not_run.join("; ")}`);
        if (!all_ok) {
          // A failed run may have left this transaction aborted (an SQL error
          // outside a savepoint): no more SQL in it. Return what the executed
          // runs captured, and roll back; the watermarks are read again after
          // the rollback (review MRI5B P3).
          log("stopped at the failed run: no further checks in this transaction");
          const checks = { runs_ok: false, not_run, watermarks_equal_after_each_run: runs.every((r) => r.watermarks_equal), caught_up: false,
            findings_drift: runs.reduce((n, r) => n + ((r.steps.findings && r.steps.findings.drift) || 0), 0), stopped_after_failure: true };
          throw Object.assign(new Error("ROLLBACK (rehearsal)"), { rehearsal: { preflight: pre, before, after: null, range, runs, checks, ok: false } });
        }
        const checks = {
          runs_ok: all_ok,
          not_run,
          watermarks_equal_after_each_run: runs.every((r) => r.watermarks_equal),
          caught_up: all_ok && last.watermarks[load.JOB] === max_id,
          findings_drift: runs.reduce((n, r) => n + ((r.steps.findings && r.steps.findings.drift) || 0), 0),
          derive_left: await derive_state(t),
        };
        if (all_ok) {
          log("verify on the rehearsed (uncommitted) facts:");
          const vf = await verify_mri_facts(t, last.watermarks[load.JOB]);
          checks.verify = { ok: vf.ok, cells: vf.by_metric.cells, differ: vf.by_metric.diffs.length + vf.by_code.n_diffs + vf.scan_sums.diffs.length };
          log(`  ${JSON.stringify(checks.verify)}`);
          log("verify-derive on the rehearsed data:");
          const vd = await verify_mri_derive(t);
          checks.verify_derive = vd.ok;
          log(`  ${vd.ok ? "ok" : `FAIL: ${JSON.stringify(vd).slice(0, 600)}`}`);
          log("verify-findings on the rehearsed rows:");
          checks.verify_findings = (await run_verify_findings(t, { today, as_of_by_system: await frun.read_as_of(t), log: (m) => log(`  ${m}`) })).ok;

          // derive touched = full rebuild
          const fp_touched = await t.one(derive.FINGERPRINT_SQL);
          const t1 = Date.now();
          const systems = (await t.any(derive.SYSTEMS_SQL)).map((r) => r.system_id);
          for (const s of systems) await t.tx((tt) => derive.derive_daily(tt, s, "full"));
          await t.tx((tt) => derive.rebuild_codes(tt, pgp));
          const fp_full = await t.one(derive.FINGERPRINT_SQL);
          const differs = Object.keys(fp_full).filter((k) => fp_full[k] !== fp_touched[k]);
          checks.derive_touched_eq_full = { same: !differs.length, differs, systems: systems.length, full_rebuild_ms: Date.now() - t1 };
          log(`derive touched vs full rebuild of ${systems.length} systems (${Date.now() - t1} ms): ${differs.length ? `DIFFERS in ${differs.join(", ")}` : "identical"}`);

          // findings default = replay
          const fp_default = await t.one(frun.FINGERPRINT_SQL);
          const t2 = Date.now();
          const fsys = await frun.all_systems(t);
          let replay_changes = 0;
          for (const s of fsys) {
            const r = await t.tx((tt) => frun.findings_system(tt, s, { today, replay: true }));
            replay_changes += r.inserted + r.updated + r.deleted;
          }
          const fp_replay = await t.one(frun.FINGERPRINT_SQL);
          checks.findings_default_eq_replay = { same: fp_default.md5 === fp_replay.md5 && !replay_changes, findings: fp_default.n, replay_findings: fp_replay.n, replay_changes, replay_ms: Date.now() - t2 };
          log(`findings default vs replay as of ${today} (${fsys.length} systems, ${Date.now() - t2} ms): ${checks.findings_default_eq_replay.same ? "identical" : "DIFFER"} (${fp_default.n} vs ${fp_replay.n} findings; replay changed ${replay_changes})`);
        }
        const others_after = await t.one(OTHERS_SQL);
        const others_differ = Object.keys(others_after).filter((k) => others_after[k] !== others_before[k]);
        checks.others_unchanged = { same: !others_differ.length, differs: others_differ };
        log(`non-MRI rows (findings, catalogs, job state): ${others_differ.length ? `CHANGED in ${others_differ.join(", ")}` : "unchanged"}`);
        const after = { counts: await t.one(MRI_COUNTS_SQL) };
        log(`after (inside the transaction): ${JSON.stringify(after)}`);

        const ok = all_ok && checks.watermarks_equal_after_each_run && checks.caught_up && !checks.findings_drift
          && !checks.derive_left.pending.length && !checks.derive_left.codes_owed
          && checks.verify.ok && checks.verify_derive && checks.verify_findings
          && checks.derive_touched_eq_full.same && checks.findings_default_eq_replay.same && checks.others_unchanged.same;
        throw Object.assign(new Error("ROLLBACK (rehearsal)"), { rehearsal: { preflight: pre, before, after, range, runs, checks, ok } });
      }).catch((e) => {
        if (e.rehearsal) return { rolled_back: true, ...e.rehearsal };
        throw e;
      });
      const wm_after = await read_watermarks(conn);
      res.watermarks_unchanged_after_rollback = JSON.stringify(wm_before) === JSON.stringify(wm_after);
      log(`after ROLLBACK: watermarks ${JSON.stringify(wm_after)} ${res.watermarks_unchanged_after_rollback ? "(unchanged)" : "CHANGED"}`);
      res.ok = res.ok && res.watermarks_unchanged_after_rollback;
      return res;
    } finally {
      await conn.one("SELECT pg_advisory_unlock(hashtext($1)) AS ok", [LOCK_KEY]);
    }
  });
}

module.exports = {
  run_stage, rehearse_stage, stage_preflight, read_watermarks, watermarks_equal, summarize, step_warnings, utc_day, derive_state,
  STEPS, JOBS, LOCK_KEY, MIN_SCHEMA_VERSION, DERIVE_WARN_MS, REHEARSAL_TX_MODE, OTHERS_SQL, MRI_COUNTS_SQL, RANGE_SQL,
};
