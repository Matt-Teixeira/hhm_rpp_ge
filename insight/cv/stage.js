"use strict";
// The GE CV insight stage's steps (PLAN-CV-INSIGHTS.md §12.2), the CV
// counterpart of insight/stage.js. Lock-free: the live stage (./index.js)
// and `cv/cli.js stage --rehearse` hold load.js LOCK_KEY around it.
//
//   1. extract : catalog sync, the late-commit re-read, then at most one 50k
//                batch from the 'ge_cv_extract' watermark (§12.3 Q4)
//   2. derive  : the pending device days the extract recorded, one
//                transaction per system, then the code labels if owed;
//                'ge_cv_derive' watermark = the extract watermark
//   3. findings: default mode, all systems, every run (§12.3 Q3), after the
//                CV-4 preflight (derive caught up, facts = daily);
//                'ge_cv_findings' watermark = the derive watermark
//
// A step runs only if the one before it succeeded. Each catches up from its
// own state, so the next run redoes a failed or skipped step.
//
// Loaded only by the GE_CV run (./index.js) and cv/cli.js; nothing in the
// GE CT run loads this file.
const crypto = require("crypto");
const { pgp } = require("../db");
const load = require("./load");
const derive = require("./derive");
const frun = require("./findings/run");
const { verify_cv_facts } = require("./verify");
const { verify_cv_derive } = require("./verify_derive");
const { run_verify: run_verify_findings } = require("./findings/verify");

const LOCK_KEY = load.LOCK_KEY;
const MIN_SCHEMA_VERSION = 8; // CV-4 findings --apply needs 008
const JOBS = [load.JOB, load.DERIVE_JOB, frun.JOB];
const utc_day = (d) => new Date(d).toISOString().slice(0, 10);

const STEPS = {
  extract: (conn, o) => load.extract_step(conn, o),
  derive: (conn, o) => derive.derive_step(conn, pgp, o),
  findings: async (conn, o) => {
    await frun.preflight(conn, { mode: "apply" });
    return frun.findings_step(conn, o);
  },
};

// The writer role (not superuser), SELECT on log.ge_cv_syserror (C2), the
// CT verifiers CV-aware (C1), schema >= 8.
async function stage_preflight(conn) {
  const pre = await load.preflight(conn, { mode: "apply" });
  if (pre.schema_version < MIN_SCHEMA_VERSION) throw new Error(`insight schema version ${pre.schema_version} < ${MIN_SCHEMA_VERSION}: apply migration 008 first`);
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
    return { ms: s.ms, from: s.from, to: s.watermark, behind_ids: s.behind_ids, batches: x.batches, rows: x.rows, facts: x.facts, upserted: x.upserted,
      collisions: x.collisions, ignored: nonzero(x.ignored), skipped: nonzero(x.skipped), unreviewed_codes: x.unreviewed_codes,
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
    if (s.stats.unreviewed_codes && s.stats.unreviewed_codes.length) w.push(`error codes not yet reviewed (counted in cv.error only): ${s.stats.unreviewed_codes.join(", ")}`);
    if (s.behind_ids) w.push(`extract is ${s.behind_ids} ids behind the source (one batch per run; the next runs catch up)`);
  }
  if (name === "derive" && s.pending_after && Object.keys(s.pending_after).length) w.push(`derive left pending days: ${Object.keys(s.pending_after).join(", ")}`);
  if (name === "findings" && s.stats.drift) w.push(`findings drift: ${s.stats.drift}`);
  return w;
}

// ---------------------------------------------------------------- rehearsal

// Everything that is not CV: must be the same before and after the stage.
const CT_SQL = `SELECT
  (SELECT md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) FROM (SELECT * FROM insight.findings WHERE source <> 'ge_cv') x) AS findings,
  (SELECT md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) FROM (SELECT * FROM insight.finding_catalog WHERE left(finding_key, 3) <> 'cv_') x) AS finding_catalog,
  (SELECT md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) FROM (SELECT * FROM insight.metric_catalog WHERE left(metric_key, 3) <> 'cv.') x) AS metric_catalog,
  (SELECT md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) FROM (SELECT * FROM insight.job_state WHERE left(job_name, 6) <> 'ge_cv_') x) AS job_state`;
const CV_COUNTS_SQL = `SELECT (SELECT count(*) FROM insight.ge_cv_facts)::int AS facts, (SELECT count(*) FROM insight.ge_cv_daily)::int AS daily,
  (SELECT count(*) FROM insight.ge_cv_codes)::int AS codes, (SELECT count(*) FROM insight.findings WHERE source = 'ge_cv')::int AS findings,
  (SELECT count(*) FROM insight.findings WHERE source = 'ge_cv' AND status = 'open')::int AS open`;
// REPEATABLE READ (review CV5-STAGE): every check sees one snapshot, so a CT
// stage (or a GE_CV ingest) committing during the rehearsal can't show as
// "CT changed". The rehearsal writes only CV rows, which only holders of
// the CV lock write, so it can't hit a serialization failure.
const REHEARSAL_TX_MODE = new pgp.txMode.TransactionMode({ tiLevel: pgp.txMode.isolationLevel.repeatableRead });
const LAST_RUN_GAP = "15 minutes"; // GE_CV runs are 30 min apart; one run's captures span seconds
const RANGE_SQL = `WITH p AS (SELECT id, capture_datetime FROM log.ge_cv_syserror WHERE id > $1)
  SELECT (SELECT max(id) FROM p)::bigint AS max_id, (SELECT count(*) FROM p)::int AS n,
         (SELECT min(capture_datetime) FROM p) AS first_capture, (SELECT max(capture_datetime) FROM p) AS last_capture,
         (SELECT min(id) FROM p WHERE capture_datetime > (SELECT max(capture_datetime) FROM p) - interval '${LAST_RUN_GAP}')::bigint AS last_run_from,
         (SELECT count(*) FROM p WHERE capture_datetime > (SELECT max(capture_datetime) FROM p) - interval '${LAST_RUN_GAP}')::int AS last_run_rows`;

async function derive_state(t) {
  const d = await t.oneOrNone("SELECT last_run_stats -> 'pending' AS p, last_run_stats -> 'codes_pending' AS c FROM insight.job_state WHERE job_name = $1", [load.DERIVE_JOB]);
  return { pending: d && d.p ? Object.keys(d.p) : [], codes_owed: !!(d && d.c === true) };
}

// `cv/cli.js stage --rehearse` (§12.2 item 6). ONE transaction, rolled
// back, under the lock. Runs the stage as production would, on the current
// pending range:
//   run 1  catch-up : the pending range before the last GE_CV run (if any)
//   run 2  typical  : the last GE_CV run's rows
//   run 3  no rows  : what most runs are
// then, on the uncommitted data: verify, verify-derive, verify-findings;
// derive touched = full rebuild (content fingerprint); findings default =
// replay (fingerprint); CT rows unchanged. Then ROLLBACK, and the watermarks
// are read again.
async function rehearse_stage(db, { log = () => {}, now = () => new Date(), on_run = async () => {} } = {}) {
  return db.task(async (conn) => {
    const { got } = await conn.one("SELECT pg_try_advisory_lock(hashtext($1)) AS got", [LOCK_KEY]);
    if (!got) return { skipped: "another GE CV insight run holds the lock" };
    try {
      const pre = await stage_preflight(conn);
      log(`preflight: user=${pre.user} schema_version=${pre.schema_version}`);
      const wm_before = await read_watermarks(conn);
      const res = await conn.tx({ mode: REHEARSAL_TX_MODE }, async (t) => {
        const before = { watermarks: await read_watermarks(t), counts: await t.one(CV_COUNTS_SQL), derive: await derive_state(t) };
        const ct_before = await t.one(CT_SQL);
        const wm = before.watermarks[load.JOB];
        if (wm === null) throw new Error("no ge_cv_extract watermark: run `cv/cli.js backfill --apply` first");
        const range = await t.one(RANGE_SQL, [wm]);
        log(`before (inside the transaction): ${JSON.stringify(before)}`);
        log(`pending range: ids ${wm + 1}..${range.max_id}, ${range.n} rows, captured ${range.first_capture && range.first_capture.toISOString()} .. ${range.last_capture && range.last_capture.toISOString()}; the last GE_CV run: ${range.last_run_rows} rows from id ${range.last_run_from}`);

        const runs = [];
        const max_id = range.max_id === null ? wm : Number(range.max_id);
        const last_from = range.last_run_from === null ? null : Number(range.last_run_from);
        if (last_from !== null && last_from - 1 > wm) runs.push({ label: "run 1, catch-up (pending range before the last GE_CV run)", to_id: last_from - 1 });
        runs.push({ label: `run ${runs.length + 1}, typical (the last GE_CV run's rows)`, to_id: max_id });
        runs.push({ label: `run ${runs.length + 1}, no new rows (what most runs are)`, to_id: max_id });
        for (const r of runs) {
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
          await on_run(r); // tests only: e.g. a concurrent CT commit
        }
        const last = runs[runs.length - 1];
        const today = last.today;
        const all_ok = runs.every((r) => r.ok);
        const checks = {
          runs_ok: all_ok,
          watermarks_equal_after_each_run: runs.every((r) => r.watermarks_equal),
          caught_up: all_ok && last.watermarks[load.JOB] === max_id,
          findings_drift: runs.reduce((n, r) => n + ((r.steps.findings && r.steps.findings.drift) || 0), 0),
          derive_left: await derive_state(t),
        };
        let fp_touched = null;
        if (all_ok) {
          log("verify on the rehearsed (uncommitted) facts:");
          const vf = await verify_cv_facts(t, last.watermarks[load.JOB]);
          checks.verify = { ok: vf.ok, cells: vf.cells, differ: vf.diffs ? vf.diffs.length : null };
          log(`  ${JSON.stringify(checks.verify)}`);
          log("verify-derive on the rehearsed data:");
          const vd = await verify_cv_derive(t);
          checks.verify_derive = vd.ok;
          log(`  ${vd.ok ? "ok" : `FAIL: ${JSON.stringify(vd).slice(0, 600)}`}`);
          log("verify-findings on the rehearsed rows:");
          checks.verify_findings = (await run_verify_findings(t, { today, as_of_by_system: await frun.read_as_of(t), log: (m) => log(`  ${m}`) })).ok;

          // derive touched = full rebuild
          fp_touched = await t.one(derive.FINGERPRINT_SQL);
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
        const ct_after = await t.one(CT_SQL);
        const ct_differs = Object.keys(ct_after).filter((k) => ct_after[k] !== ct_before[k]);
        checks.ct_unchanged = { same: !ct_differs.length, differs: ct_differs };
        log(`CT rows (findings, catalogs, job state): ${ct_differs.length ? `CHANGED in ${ct_differs.join(", ")}` : "unchanged"}`);
        const after = { counts: await t.one(CV_COUNTS_SQL) };
        log(`after (inside the transaction): ${JSON.stringify(after)}`);

        const ok = all_ok && checks.watermarks_equal_after_each_run && checks.caught_up && !checks.findings_drift
          && !checks.derive_left.pending.length && !checks.derive_left.codes_owed
          && checks.verify.ok && checks.verify_derive && checks.verify_findings
          && checks.derive_touched_eq_full.same && checks.findings_default_eq_replay.same && checks.ct_unchanged.same;
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
  run_stage, rehearse_stage, stage_preflight, read_watermarks, watermarks_equal, summarize, step_warnings, utc_day,
  STEPS, JOBS, LOCK_KEY, MIN_SCHEMA_VERSION, REHEARSAL_TX_MODE, CT_SQL, CV_COUNTS_SQL, RANGE_SQL,
};
