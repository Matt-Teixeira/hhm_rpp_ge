"use strict";
// The shared insight stage wrapper (PLAN-MRI-INSIGHTS.md §11.2 item 1),
// factored out of CT's insight/index.js run_ct_insight and its CV copy
// insight/cv/index.js run_cv_insight, with their differences as cfg.
// GE MRI's run_mri_insight (insight/mri/index.js) uses it from MRI-5, and CT's
// run_ct_insight (insight/index.js) and CV's run_cv_insight
// (insight/cv/index.js) from MRI-5b (PLAN-MRI-INSIGHTS.md §12): each is a
// thin caller that checks its own switch before loading this file.
//
//   await run_insight_stage(cfg, run_log, addLogEvent, deps)
//
// cfg (from the modality's index.js, which checks its kill switch BEFORE
// loading this file, so "off" loads nothing):
//   func               run_log function name, e.g. "run_mri_insight"
//   app_name           PostgreSQL application_name, e.g. "insight_mri_stage"
//   label              in the lock-skip and deadline texts, e.g. "GE MRI insight"
//   load_stage()       the stage module: LOCK_KEY, stage_preflight(conn),
//                      run_stage(conn, opts), summarize, step_warnings
//   run_args(deps)     optional: extra run_stage options, loaded before the
//                      connection (CT: its rules registry)
//   preflight_warnings(pre)  optional: WARN texts from the preflight result
//                      (CT: partitions running out); the run goes on
//
// - Never rejects. Every failure goes to run_log as an ERROR event and the
//   ingest run carries on; the next run catches up.
// - Its own pool as insight_writer (insight/db.js), closed at the end, with
//   bounded connect / statement / lock / query times and a 5-minute deadline
//   for the whole stage, so it can't keep the ingest process waiting.
// - One advisory lock (the stage module's LOCK_KEY) for the whole stage. If
//   it is held (a manual cli.js run, or an overlapping stage), the stage
//   skips.
// - Preflight failure: a WARN and the run is skipped.
//
// This file loads no modality module (the CT, CV and MRI isolation tests).

// Values of utils/logger/enums.js (gitignored; identical in dev and prod).
const INFO = "INFO";
const WARN = "WARN";
const ERROR = "ERROR";
const DETAILS = "DETAILS";
const CATCH = "CATCH";
const STATEMENT_TIMEOUT_MS = 120000;
// Bounded connect, and a client-side backstop a little above the server's
// statement_timeout (fires only if the server never answers).
const CONNECT_TIMEOUT_MS = 10000;
const QUERY_TIMEOUT_MS = STATEMENT_TIMEOUT_MS + 15000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Whole-stage deadline. Per-query limits bound one statement, not a
// sequence of them. At the deadline the stage's connection is killed: the
// in-flight transaction rolls back (each batch / system is its own
// transaction and its pending work stays recorded), the session's advisory
// lock is released, and the next run catches up.
const STAGE_DEADLINE_MS = 5 * 60 * 1000;

const CFG_KEYS = ["func", "app_name", "label", "load_stage"];

// deps (tests only): { connect, stage, deadline_ms, ...whatever cfg.run_args reads }
async function run_insight_stage(cfg, run_log, addLogEvent, deps = {}) {
  const t0 = Date.now();
  let closed = false; // after the deadline, the abandoned stage must not log any more
  const ev = async (type, note, err = null) => {
    if (closed) return;
    try {
      await addLogEvent(type, run_log, cfg.func, type === ERROR ? CATCH : DETAILS, note, err);
    } catch (_) {
      // logging must never fail the ingest run
    }
  };
  let db = null;
  let sco = null;
  let timer = null;
  try {
    const missing = CFG_KEYS.filter((k) => !cfg[k]);
    if (missing.length) throw new Error(`stage wrapper: cfg lacks ${missing.join(", ")}`);
    const connect = deps.connect || require("./db").connect;
    const stage = deps.stage || cfg.load_stage();
    const extra = cfg.run_args ? cfg.run_args(deps) : {};
    const deadline_ms = deps.deadline_ms || STAGE_DEADLINE_MS;
    const run_id = run_log && UUID_RE.test(run_log.run_id || "") ? run_log.run_id : require("crypto").randomUUID();
    db = connect("writer", { statementTimeoutMs: STATEMENT_TIMEOUT_MS, connectTimeoutMs: CONNECT_TIMEOUT_MS,
      queryTimeoutMs: QUERY_TIMEOUT_MS, applicationName: cfg.app_name });
    // one dedicated connection (bounded by the connect timeout), so the
    // deadline can kill it; transactions on it work as in a task
    sco = await db.connect();
    const conn = sco;

    const work = (async () => {
      const { got } = await conn.one("SELECT pg_try_advisory_lock(hashtext($1)) AS got", [stage.LOCK_KEY]);
      if (!got) {
        await ev(INFO, { step: "lock", skipped: `another ${cfg.label} run holds the lock; the next run catches up` });
        return { skipped: "lock" };
      }
      try {
        let pre;
        try {
          pre = await stage.stage_preflight(conn);
        } catch (e) {
          await ev(WARN, { step: "preflight", skipped: e.message });
          return { skipped: "preflight", reason: e.message };
        }
        for (const warning of cfg.preflight_warnings ? cfg.preflight_warnings(pre) : []) await ev(WARN, { step: "preflight", warning });
        const r = await stage.run_stage(conn, { ...extra, now: new Date(), run_id });
        for (const [name, s] of Object.entries(r.steps)) {
          if (s.error) {
            await ev(ERROR, { step: name, ms: s.ms }, r.error);
            continue;
          }
          const warnings = stage.step_warnings(name, s);
          await ev(warnings.length ? WARN : INFO, { step: name, ...stage.summarize(name, s), ...(warnings.length ? { warnings } : {}) });
        }
        if (r.failed === "watermarks") await ev(ERROR, { step: "watermarks" }, r.error);
        await ev(r.ok && r.watermarks_equal ? INFO : WARN,
          { step: "summary", ok: r.ok, failed: r.failed, today: r.today, ms: Date.now() - t0, watermarks: r.watermarks, watermarks_equal: r.watermarks_equal });
        return { ok: r.ok, failed: r.failed, watermarks: r.watermarks, watermarks_equal: r.watermarks_equal };
      } finally {
        if (!closed) await conn.one("SELECT pg_advisory_unlock(hashtext($1)) AS ok", [stage.LOCK_KEY]).catch(() => {});
      }
    })();
    work.catch(() => {}); // if abandoned at the deadline, its later rejection is expected, never unhandled

    const expired = new Promise((resolve) => { timer = setTimeout(() => resolve(true), deadline_ms); });
    const r = await Promise.race([work, expired]);
    if (r !== true) return r;

    await ev(ERROR, { step: "deadline", ms: Date.now() - t0 },
      new Error(`${cfg.label} stage exceeded ${deadline_ms} ms: connection closed, its open transaction rolls back; the next run catches up`));
    closed = true;
    try {
      sco.done(true); // kill: closes the socket, the in-flight query fails
    } catch (_) {
      // already gone
    }
    sco = null;
    return { error: "deadline" };
  } catch (e) {
    await ev(ERROR, { step: "stage", ms: Date.now() - t0 }, e);
    return { error: e.message };
  } finally {
    clearTimeout(timer);
    if (sco) {
      try {
        sco.done();
      } catch (_) {
        // already released
      }
    }
    if (db) {
      try {
        await db.$pool.end();
      } catch (_) {
        // already closed
      }
    }
  }
}

module.exports = { run_insight_stage, STATEMENT_TIMEOUT_MS, CONNECT_TIMEOUT_MS, QUERY_TIMEOUT_MS, STAGE_DEADLINE_MS };
