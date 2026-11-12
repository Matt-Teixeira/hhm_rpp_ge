"use strict";
// The GE CV insight stage (PLAN-CV-INSIGHTS.md §12.2), called from the
// repo's index.js on_boot() after the system loop, for GE_CV only:
//
//   await run_cv_insight(run_log, addLogEvent)
//
// A copy of CT's wrapper (insight/index.js run_ct_insight), so the CT stage
// is not touched (§12.3 Q2). Factor a shared wrapper out with a third stage.
//
// - Off unless INSIGHT_CV_ENABLED=true (its own switch, §12.3 Q1). Off, it
//   returns at once: it loads no module, opens no connection and logs
//   nothing, so the GE_CV run is exactly what it was before.
// - Never rejects. Every failure goes to run_log as an ERROR event and the
//   GE_CV run carries on; the next run catches up from the job state.
// - Its own pool as insight_writer (insight/db.js), closed at the end, with
//   bounded connect / statement / lock / query times and a 5-minute deadline
//   for the whole stage, so it can't keep the GE_CV process waiting.
// - One advisory lock (cv/load.js LOCK_KEY) for the whole stage. If it is
//   held (a manual cv/cli.js run, or an overlapping stage), the stage skips.
// - Preflight: the writer role, C1, C2, schema version >= 8; otherwise log
//   a WARN and skip.
// - The steps (./stage.js): extract (late-commit re-read + at most one 50k
//   batch) -> derive (pending days, code labels) -> findings (all systems,
//   default mode). Each step's counts and ms go to run_log.

const FUNC = "run_cv_insight";
// Values of utils/logger/enums.js (gitignored; identical in dev and prod).
const INFO = "INFO";
const WARN = "WARN";
const ERROR = "ERROR";
const DETAILS = "DETAILS";
const CATCH = "CATCH";
const STATEMENT_TIMEOUT_MS = 120000;
const CONNECT_TIMEOUT_MS = 10000;
const QUERY_TIMEOUT_MS = STATEMENT_TIMEOUT_MS + 15000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const enabled = () => process.env.INSIGHT_CV_ENABLED === "true";

// Whole-stage deadline. At the deadline the stage's connection is killed:
// the in-flight transaction rolls back (each batch / system is its own
// transaction and its pending work stays recorded), the session's advisory
// lock is released, and the next run catches up. Typical run ~2-3 s
// (§12.1).
const STAGE_DEADLINE_MS = 5 * 60 * 1000;

// deps (tests only): { connect, stage, deadline_ms }
async function run_cv_insight(run_log, addLogEvent, deps = {}) {
  if (!enabled()) return { skipped: "disabled" };
  const t0 = Date.now();
  let closed = false; // after the deadline, the abandoned stage must not log any more
  const ev = async (type, note, err = null) => {
    if (closed) return;
    try {
      await addLogEvent(type, run_log, FUNC, type === ERROR ? CATCH : DETAILS, note, err);
    } catch (_) {
      // logging must never fail the GE_CV run
    }
  };
  let db = null;
  let sco = null;
  let timer = null;
  try {
    const connect = deps.connect || require("../db").connect;
    const stage = deps.stage || require("./stage");
    const deadline_ms = deps.deadline_ms || STAGE_DEADLINE_MS;
    const run_id = run_log && UUID_RE.test(run_log.run_id || "") ? run_log.run_id : require("crypto").randomUUID();
    db = connect("writer", { statementTimeoutMs: STATEMENT_TIMEOUT_MS, connectTimeoutMs: CONNECT_TIMEOUT_MS,
      queryTimeoutMs: QUERY_TIMEOUT_MS, applicationName: "insight_cv_stage" });
    // one dedicated connection (bounded by the connect timeout), so the
    // deadline can kill it; transactions on it work as in a task
    sco = await db.connect();
    const conn = sco;

    const work = (async () => {
      const { got } = await conn.one("SELECT pg_try_advisory_lock(hashtext($1)) AS got", [stage.LOCK_KEY]);
      if (!got) {
        await ev(INFO, { step: "lock", skipped: "another GE CV insight run holds the lock; the next run catches up" });
        return { skipped: "lock" };
      }
      try {
        try {
          await stage.stage_preflight(conn);
        } catch (e) {
          await ev(WARN, { step: "preflight", skipped: e.message });
          return { skipped: "preflight", reason: e.message };
        }
        const r = await stage.run_stage(conn, { now: new Date(), run_id });
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
      new Error(`GE CV insight stage exceeded ${deadline_ms} ms: connection closed, its open transaction rolls back; the next run catches up`));
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

module.exports = { run_cv_insight, enabled, STATEMENT_TIMEOUT_MS, CONNECT_TIMEOUT_MS, QUERY_TIMEOUT_MS, STAGE_DEADLINE_MS };
