"use strict";
// The ge_ct insight stage (PLAN-CT-INSIGHTS.md §2, §15.2), called from the
// repo's index.js on_boot() after the system loop, for GE_CT only:
//
//   await run_ct_insight(run_log, addLogEvent)
//
// - Off unless INSIGHT_ENABLED=true. Off, it returns at once: it loads no
//   module, opens no connection and logs nothing, so the ge_ct run is
//   exactly what it was before (§15.3 Q1).
// - Never rejects. Every failure goes to run_log as an ERROR event and the
//   ge_ct run carries on; the next run catches up from the watermarks.
// - Its own pool as insight_writer (insight/db.js), closed at the end, with
//   bounded connect / statement / lock / query times and a 5-minute deadline
//   for the whole stage, so it can't keep the ge_ct process waiting.
// - One advisory lock (load.js LOCK_KEY) for the whole stage. If it is held
//   (a manual cli.js run, or an overlapping stage), the stage skips.
// - Preflight: the writer role, schema version >= 5; otherwise log and skip.
// - The steps (insight/stage.js): extract (late-commit re-read + at most one
//   50k batch) -> derive (touched days) -> findings (touched systems; all
//   systems on the first run of a new UTC date). Each step's counts and ms
//   go to run_log.

const FUNC = "run_ct_insight";
// Values of utils/logger/enums.js (gitignored; identical in dev and prod).
const INFO = "INFO";
const WARN = "WARN";
const ERROR = "ERROR";
const DETAILS = "DETAILS";
const CATCH = "CATCH";
const STATEMENT_TIMEOUT_MS = 120000;
// review PHASE5-STAGE F2: bounded connect, and a client-side backstop a
// little above the server's statement_timeout (fires only if the server
// never answers).
const CONNECT_TIMEOUT_MS = 10000;
const QUERY_TIMEOUT_MS = STATEMENT_TIMEOUT_MS + 15000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const enabled = () => process.env.INSIGHT_ENABLED === "true";

// Whole-stage deadline (review PHASE5-HOOK F2). Per-query limits bound one
// statement, not a sequence of them. At the deadline the stage's connection
// is killed: the in-flight transaction rolls back (each batch / system is
// its own transaction and its pending work stays recorded), the session's
// advisory lock is released, and the next run catches up. Typical run ~9 s,
// catch-up ~21 s, full rebuild of all systems ~28 s (§15 rehearsal).
const STAGE_DEADLINE_MS = 5 * 60 * 1000;

// deps (tests only): { connect, stage, rules, deadline_ms }
async function run_ct_insight(run_log, addLogEvent, deps = {}) {
  if (!enabled()) return { skipped: "disabled" };
  const t0 = Date.now();
  let closed = false; // after the deadline, the abandoned stage must not log any more
  const ev = async (type, note, err = null) => {
    if (closed) return;
    try {
      await addLogEvent(type, run_log, FUNC, type === ERROR ? CATCH : DETAILS, note, err);
    } catch (_) {
      // logging must never fail the ge_ct run
    }
  };
  let db = null;
  let sco = null;
  let timer = null;
  try {
    const connect = deps.connect || require("./db").connect;
    const stage = deps.stage || require("./stage");
    const rules = deps.rules || require("./rules/ge_ct").rules;
    const deadline_ms = deps.deadline_ms || STAGE_DEADLINE_MS;
    const run_id = run_log && UUID_RE.test(run_log.run_id || "") ? run_log.run_id : require("crypto").randomUUID();
    db = connect("writer", { statementTimeoutMs: STATEMENT_TIMEOUT_MS, connectTimeoutMs: CONNECT_TIMEOUT_MS,
      queryTimeoutMs: QUERY_TIMEOUT_MS, applicationName: "insight_stage" });
    // one dedicated connection (bounded by the connect timeout), so the
    // deadline can kill it; transactions on it work as in a task
    sco = await db.connect();
    const conn = sco;

    const work = (async () => {
      const { got } = await conn.one("SELECT pg_try_advisory_lock(hashtext($1)) AS got", [stage.LOCK_KEY]);
      if (!got) {
        await ev(INFO, { step: "lock", skipped: "another insight run holds the lock; the next run catches up" });
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
        if (pre.partition_warning) {
          await ev(WARN, { step: "preflight", warning: `insight.ge_ct_facts partitions end at ${pre.last_partition} (${pre.months_left} months left): add partitions` });
        }
        const r = await stage.run_stage(conn, { rules, now: new Date(), run_id });
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
      new Error(`insight stage exceeded ${deadline_ms} ms: connection closed, its open transaction rolls back; the next run catches up`));
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

module.exports = { run_ct_insight, enabled, STATEMENT_TIMEOUT_MS, CONNECT_TIMEOUT_MS, QUERY_TIMEOUT_MS, STAGE_DEADLINE_MS };
