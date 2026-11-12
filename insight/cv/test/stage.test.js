"use strict";
// node insight/cv/test/stage.test.js   (no DB needed)
// The CV-5 stage (PLAN-CV-INSIGHTS.md §12.2): the lock-free cores and their
// watermarks, run_stage, the run_log summaries, and run_cv_insight (kill
// switch, one lock, preflight, failures, the deadline).
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const stage = require("../stage");
const { run_cv_insight, STATEMENT_TIMEOUT_MS, CONNECT_TIMEOUT_MS, QUERY_TIMEOUT_MS, STAGE_DEADLINE_MS } = require("../index");
const load = require("../load");
const derive = require("../derive");
const frun = require("../findings/run");

// ------------------------------------------------------- the cores (step 1)

// A relay row: classified and ignored, so a batch has no facts and only job state is written.
const relay = (id) => ({ id: String(id), capture_datetime: new Date("2026-11-12T15:48:05Z"), system_id: "SME1", sequencenumber: id, host_date: "2026-11-12",
  host_time: "08:00:00.000", subsystem: "RTA", errorcode: 1050168, exceptioncategory: null, repeatcount: 0, debugtext: " (null)", sourcefile: "XRImChainPos",
  sourceline: 1, host_datetime: new Date("2026-11-12T16:00:00Z") });

function batchConn({ failCommit = 0, rows = [relay(101), relay(102)] } = {}) {
  let reads = 0;
  let txs = 0;
  const jobWrites = [];
  const batchParams = [];
  const conn = {
    batchParams,
    any: async (q, p) => { batchParams.push(p); return reads++ === 0 ? rows : []; },
    tx: async (cb) => {
      const n = ++txs;
      const r = await cb({
        any: async () => [],
        oneOrNone: async () => null,
        one: async () => ({ last_run_stats: {} }),
        none: async (q, p) => { if (/INSERT INTO insight\.job_state \(job_name, watermark_id/.test(q)) jobWrites.push({ tx: n, watermark: p[1], status: p[5], stats: JSON.parse(p[6]) }); },
      });
      if (n === failCommit) throw new Error("COMMIT failed"); // the body ran, the commit didn't
      return r;
    },
  };
  return { conn, jobWrites };
}
const newStats = () => ({ mode: "stage", rows: 0, facts: 0, upserted: 0, collisions: 0, batches: 0, ignored: {}, skipped: {}, rule_errors: 0, unreviewed_codes: [] });
const JOB = { watermark_id: "100", watermark_capture_datetime: null };

test("apply_range: a committed batch advances the watermark and stats; the catalog sync is its own transaction first", async () => {
  const { conn, jobWrites } = batchConn();
  const stats = newStats();
  const r = await load.apply_range(conn, { job: JOB, start: 100, end: 102, max_batches: 1, run_id: "x", started_at: new Date(), stats });
  assert.strictEqual(r.watermark, 102);
  assert.deepStrictEqual([stats.batches, stats.rows, stats.facts], [1, 2, 0]);
  assert.deepStrictEqual(stats.ignored, { rta_relay: 2 });
  assert.deepStrictEqual(jobWrites.map((w) => [w.tx, w.watermark, w.status]), [[2, 102, "ok"]]);
  assert.strictEqual(stats.late.skipped, "no watermark capture time");
});

test("apply_range: a batch whose COMMIT fails leaves the recorded watermark and stats at the last committed batch", async () => {
  const { conn, jobWrites } = batchConn({ failCommit: 2 });
  const stats = newStats();
  await assert.rejects(load.apply_range(conn, { job: JOB, start: 100, end: 102, max_batches: 1, run_id: "x", started_at: new Date(), stats }), /COMMIT failed/);
  const err = jobWrites.find((w) => w.status === "error");
  assert.ok(err, "error row written");
  assert.strictEqual(err.watermark, 100, "the failed batch's id must not be recorded");
  assert.strictEqual(err.stats.batches, 0);
  assert.strictEqual(stats.rows, 0);
});

test("extract_step: from the watermark, one batch by default, behind_ids against the source max; refuses without a watermark", async () => {
  const { conn } = batchConn();
  conn.oneOrNone = async () => JOB;
  conn.one = async () => ({ m: "150" });
  const r = await load.extract_step(conn, { run_id: "x" });
  assert.deepStrictEqual([r.from, r.watermark, r.end, r.behind_ids], [100, 102, 150, 48]);
  assert.deepStrictEqual(conn.batchParams[0], [100, 150, null], "the batch reads from the watermark to the source max");
  assert.strictEqual(r.stats.batches, 1);
  const { conn: c2 } = batchConn();
  c2.oneOrNone = async () => null;
  await assert.rejects(load.extract_step(c2, { run_id: "x" }), /no ge_cv_extract watermark/);
});

function deriveConn({ pending = { SME1: ["2026-11-12"] }, extract_wm = "500", codes_owed = false } = {}) {
  const lastRuns = [];
  let cleared = false;
  const pend = () => ({ last_run_stats: { pending: cleared ? {} : pending } });
  const t = {
    oneOrNone: async () => pend(),
    result: async (q) => ({ rowCount: /^DELETE/.test(q) ? 3 : 4 }),
    none: async (q, p) => {
      if (/#- ARRAY\['pending'/.test(q)) cleared = true;
      if (/last_run_finished_at = now\(\)/.test(q)) lastRuns.push({ status: p[3], watermark: p[5], stats: JSON.parse(p[4]) });
    },
  };
  const conn = {
    oneOrNone: async (q) => {
      if (/SELECT watermark_id FROM insight\.job_state/.test(q)) return extract_wm === null ? null : { watermark_id: extract_wm };
      if (/codes_pending/.test(q)) return { c: codes_owed };
      return pend();
    },
    any: async () => [{ system_id: "SME1" }, { system_id: "SME2" }],
    tx: async (cb) => cb(t),
  };
  return { conn, lastRuns };
}

test("derive_step: on success the derive watermark = the extract watermark read first; an error keeps the old one", async () => {
  const d = deriveConn();
  let rebuilt = 0;
  const r = await derive.derive_step(d.conn, null, { run_id: "x", rebuild: async () => { rebuilt++; return { codes: 1, unlabeled: 0 }; } });
  assert.strictEqual(r.watermark, 500);
  assert.strictEqual(rebuilt, 1, "codes rebuilt after a derived system");
  assert.deepStrictEqual(r.stats.daily, [{ system_id: "SME1", scope: 1, deleted: 3, inserted: 4 }]);
  assert.deepStrictEqual(d.lastRuns.map((x) => [x.status, x.watermark]), [["ok", 500]]);

  const e = deriveConn();
  await assert.rejects(derive.derive_step(e.conn, null, { run_id: "x", rebuild: async () => { throw new Error("codes broke"); } }), /codes broke/);
  assert.deepStrictEqual(e.lastRuns.map((x) => [x.status, x.watermark]), [["error", null]], "null = keep the old watermark");
});

test("derive_step: nothing pending and no codes owed does no work but still records the run and the watermark", async () => {
  const d = deriveConn({ pending: {} });
  const r = await derive.derive_step(d.conn, null, { run_id: "x", rebuild: async () => assert.fail("no rebuild") });
  assert.deepStrictEqual(r.stats.codes, { skipped: "nothing pending" });
  assert.deepStrictEqual(r.stats.daily, []);
  assert.deepStrictEqual(d.lastRuns.map((x) => [x.status, x.watermark]), [["ok", 500]]);
  // owed code labels from an earlier stopped run are rebuilt
  let rebuilt = 0;
  await derive.derive_step(deriveConn({ pending: {}, codes_owed: true }).conn, null, { run_id: "x", rebuild: async () => { rebuilt++; return {}; } });
  assert.strictEqual(rebuilt, 1);
});

test("write_last_run / findings WRITE_JOB_SQL: the watermark is set only when given", () => {
  assert.match(derive.write_last_run.toString(), /watermark_id = coalesce\(\$6::bigint, watermark_id\)/);
  assert.match(frun.WRITE_JOB_SQL, /VALUES \(\$1, coalesce\(\$6::bigint, 0\)/);
  assert.match(frun.WRITE_JOB_SQL, /SET watermark_id = coalesce\(\$6::bigint, job_state\.watermark_id\)/);
});

function findingsConn({ derive_wm = "500" } = {}) {
  const jobs = [];
  const t = {
    result: async () => ({ rowCount: 0 }),
    any: async () => [],
    none: async (q, p) => { if (q === frun.WRITE_JOB_SQL) jobs.push({ status: p[3], watermark: p[5] }); },
  };
  const conn = {
    oneOrNone: async () => (derive_wm === null ? null : { watermark_id: derive_wm }),
    any: async () => [],
    one: async () => ({ findings: 13, open: 2, catalog: 5 }),
    tx: async (cb) => cb(t),
  };
  return { conn, jobs };
}

test("findings_step: a fleet-wide run records the derive watermark; a system selection writes no job state", async () => {
  const f = findingsConn();
  const r = await frun.findings_step(f.conn, { today: "2026-11-12", run_id: "x" });
  assert.strictEqual(r.watermark, 500);
  assert.deepStrictEqual(f.jobs, [{ status: "ok", watermark: 500 }]);
  const g = findingsConn();
  const r2 = await frun.findings_step(g.conn, { systems: ["SME1"], list: [], today: "2026-11-12", run_id: "x" });
  assert.strictEqual(r2.watermark, null);
  assert.deepStrictEqual(g.jobs, []);
  await assert.rejects(frun.findings_step(f.conn, { today: "11/12/2026" }), /bad today/);
});

// ------------------------------------------------------------- run_stage

function fakeSteps(fail = null) {
  const calls = [];
  const mk = (name, result) => async (conn, opts) => {
    calls.push({ name, opts });
    if (fail === name) throw new Error(`${name} broke`);
    return result;
  };
  return {
    calls,
    steps: {
      extract: mk("extract", { from: 10, watermark: 20, end: 20, behind_ids: 0,
        stats: { batches: 1, rows: 10, facts: 7, upserted: 7, collisions: 0, ignored: { rta_relay: 3 }, skipped: { no_system: 0 }, unreviewed_codes: [], late: { rows: 2, facts: 0, inserted: 0, systems: [] } } }),
      derive: mk("derive", { watermark: 20, pending_after: {},
        stats: { full: false, systems: 1, daily: [{ system_id: "SME1", scope: 2, deleted: 5, inserted: 6 }, { system_id: "SME2", scope: "none" }], codes: { codes: 203, unlabeled: 13 } } }),
      findings: mk("findings", { watermark: 20, drift_detail: [],
        stats: { systems: 2, evaluated: 2, skipped_stale: [], inserted: 0, updated: 1, deleted: 0, drift: 0, findings: 13, open: 2 } }),
    },
  };
}
const wmConn = (w = { ge_cv_extract: 20, ge_cv_derive: 20, ge_cv_findings: 20 }) => ({
  any: async () => Object.entries(w).map(([job_name, watermark_id]) => ({ job_name, watermark_id: String(watermark_id) })),
});

test("run_stage: extract -> derive -> findings, one batch per run, today = the UTC date, one run id", async () => {
  const f = fakeSteps();
  const r = await stage.run_stage(wmConn(), { now: new Date("2026-11-12T23:48:30Z"), run_id: "x", steps: f.steps });
  assert.deepStrictEqual(f.calls.map((c) => c.name), ["extract", "derive", "findings"]);
  assert.strictEqual(f.calls[0].opts.max_batches, 1);
  assert.strictEqual(f.calls[0].opts.to_id, null);
  assert.strictEqual(f.calls[2].opts.today, "2026-11-12");
  assert.ok(f.calls.every((c) => c.opts.run_id === "x"));
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.watermarks, { ge_cv_extract: 20, ge_cv_derive: 20, ge_cv_findings: 20 });
  assert.strictEqual(r.watermarks_equal, true);
  for (const k of ["extract", "derive", "findings"]) assert.ok(Number.isFinite(r.steps[k].ms), k);
});

test("run_stage: a step runs only if the one before succeeded; the failure is returned, not thrown", async () => {
  for (const fail of ["extract", "derive", "findings"]) {
    const f = fakeSteps(fail);
    const r = await stage.run_stage(wmConn({ ge_cv_extract: 20, ge_cv_derive: 10, ge_cv_findings: 10 }), { run_id: "x", steps: f.steps });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.failed, fail);
    assert.match(r.error.message, new RegExp(`${fail} broke`));
    assert.strictEqual(f.calls[f.calls.length - 1].name, fail, "nothing after the failed step");
    assert.strictEqual(r.watermarks_equal, false);
  }
  const r = await stage.run_stage({ any: async () => { throw new Error("gone"); } }, { run_id: "x", steps: fakeSteps().steps });
  assert.deepStrictEqual([r.ok, r.failed, r.watermarks_equal], [false, "watermarks", false]);
});

test("watermarks_equal: all three present and the same", () => {
  assert.strictEqual(stage.watermarks_equal({ ge_cv_extract: 5, ge_cv_derive: 5, ge_cv_findings: 5 }), true);
  assert.strictEqual(stage.watermarks_equal({ ge_cv_extract: 5, ge_cv_derive: 5, ge_cv_findings: 0 }), false);
  assert.strictEqual(stage.watermarks_equal({ ge_cv_extract: null, ge_cv_derive: null, ge_cv_findings: null }), false);
  assert.deepStrictEqual(stage.JOBS, ["ge_cv_extract", "ge_cv_derive", "ge_cv_findings"]);
});

test("summaries and warnings: log-friendly, WARN for late inserts, unreviewed codes, a backlog, pending left, drift", async () => {
  const f = fakeSteps();
  const s = {};
  for (const [k, fn] of Object.entries(f.steps)) s[k] = { ...(await fn(null, {})), ms: 3 };
  assert.deepStrictEqual(stage.summarize("extract", s.extract), { ms: 3, from: 10, to: 20, behind_ids: 0, batches: 1, rows: 10, facts: 7, upserted: 7, collisions: 0,
    ignored: { rta_relay: 3 }, skipped: {}, unreviewed_codes: [], late: { rows: 2, facts: 0, inserted: 0, systems: [] } });
  assert.deepStrictEqual(stage.summarize("derive", s.derive), { ms: 3, to: 20, systems: ["SME1"], days: 2, full: 0, daily: { deleted: 5, inserted: 6 },
    codes: { codes: 203, unlabeled: 13 }, pending_after: [] });
  assert.deepStrictEqual(stage.summarize("findings", s.findings), { ms: 3, to: 20, evaluated: 2, skipped_stale: [], inserted: 0, updated: 1, deleted: 0, drift: 0, findings: 13, open: 2 });
  for (const k of Object.keys(s)) assert.deepStrictEqual(stage.step_warnings(k, s[k]), [], k);
  const ex = JSON.parse(JSON.stringify(s.extract));
  Object.assign(ex, { behind_ids: 9000 });
  Object.assign(ex.stats, { unreviewed_codes: [999] });
  Object.assign(ex.stats.late, { inserted: 2, systems: ["SME1"] });
  assert.deepStrictEqual(stage.step_warnings("extract", ex), ["late-commit re-read inserted 2 facts (SME1)",
    "error codes not yet reviewed (counted in cv.error only): 999", "extract is 9000 ids behind the source (one batch per run; the next runs catch up)"]);
  assert.deepStrictEqual(stage.step_warnings("derive", { ...s.derive, pending_after: { SME1: ["2026-11-12"] } }), ["derive left pending days: SME1"]);
  assert.deepStrictEqual(stage.step_warnings("findings", { stats: { drift: 2 } }), ["findings drift: 2"]);
  assert.deepStrictEqual(stage.summarize("derive", { error: "x", ms: 4 }), { error: "x", ms: 4 });
  assert.deepStrictEqual(stage.step_warnings("derive", { error: "x" }), []);
});

test("stage_preflight: the extract apply preflight (role, C1, C2) plus schema >= 8", async () => {
  const old = process.env.INSIGHT_PG_USER;
  process.env.INSIGHT_PG_USER = "insight_writer";
  try {
    const c = (v) => ({ one: async (q) => (/current_user/.test(q) ? { u: "insight_writer", su: false, can_read: true } : { v }) });
    await assert.rejects(stage.stage_preflight(c(7)), /version 7 < 8: apply migration 008/);
    assert.deepStrictEqual(await stage.stage_preflight(c(8)), { user: "insight_writer", schema_version: 8 });
    await assert.rejects(stage.stage_preflight({ one: async () => ({ u: "avantehs_admin", su: false, can_read: true }) }), /expected the limited/);
  } finally { if (old === undefined) delete process.env.INSIGHT_PG_USER; else process.env.INSIGHT_PG_USER = old; }
});

test("the rehearsal's CT check covers every non-CV row of the shared tables, by prefix (no backslash)", () => {
  assert.match(stage.CT_SQL, /insight\.findings WHERE source <> 'ge_cv'/);
  assert.match(stage.CT_SQL, /finding_catalog WHERE left\(finding_key, 3\) <> 'cv_'/);
  assert.match(stage.CT_SQL, /metric_catalog WHERE left\(metric_key, 3\) <> 'cv\.'/);
  assert.match(stage.CT_SQL, /job_state WHERE left\(job_name, 6\) <> 'ge_cv_'/);
  assert.doesNotMatch(stage.CT_SQL + stage.RANGE_SQL + stage.CV_COUNTS_SQL, /\\/);
});

// --------------------------------------------------------- run_cv_insight

function fakeDb({ got = true, unlockThrows = false, connectThrows = null } = {}) {
  const calls = [];
  const sco = {
    one: async (q, p) => {
      if (/pg_try_advisory_lock/.test(q)) { calls.push(`lock:${p[0]}`); return { got }; }
      if (/pg_advisory_unlock/.test(q)) { calls.push("unlock"); if (unlockThrows) throw new Error("connection lost"); return { ok: true }; }
      throw new Error(`unexpected query ${q}`);
    },
    done: (kill) => { calls.push(kill ? "kill" : "release"); if (sco.onKill && kill) sco.onKill(); },
  };
  const db = {
    connect: async () => { if (connectThrows) throw connectThrows; return sco; },
    $pool: { end: async () => { calls.push("end"); } },
  };
  return { db, calls, sco };
}

function fakeStage({ preflight = async () => ({}), result = null, throws = null } = {}) {
  const calls = [];
  return {
    calls,
    LOCK_KEY: "insight_ge_cv",
    stage_preflight: preflight,
    summarize: stage.summarize,
    step_warnings: stage.step_warnings,
    run_stage: async (conn, opts) => {
      calls.push(opts);
      if (throws) throw throws;
      return result;
    },
  };
}

async function okResult() {
  const f = fakeSteps();
  const steps = {};
  for (const [k, fn] of Object.entries(f.steps)) steps[k] = { ...(await fn(null, {})), ms: 5 };
  return { today: "2026-11-12", ok: true, failed: null, error: null, watermarks: { ge_cv_extract: 20, ge_cv_derive: 20, ge_cv_findings: 20 }, watermarks_equal: true, steps };
}

function logger({ throws = false } = {}) {
  const events = [];
  const add = async (type, run_log, func, tag, note, err) => {
    events.push({ type, func, tag, note, err });
    if (throws) throw new Error("logger broke");
  };
  return { events, add };
}

async function withEnv(vars, fn) {
  const old = {};
  for (const [k, v] of Object.entries(vars)) { old[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { return await fn(); } finally { for (const [k, v] of Object.entries(old)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
}
const on = (fn) => withEnv({ INSIGHT_CV_ENABLED: "true" }, fn);
const RUN_LOG = { run_id: "6f1c0d3e-6a51-4f43-9a52-0d1b5c7e2a10", log_events: [] };

test("kill switch: off unless INSIGHT_CV_ENABLED=true (CT's INSIGHT_ENABLED does not turn it on); off connects to nothing and logs nothing", async () => {
  for (const v of [undefined, "", "false", "TRUE", "1", "yes", " true"]) {
    const l = logger();
    let connected = false;
    const r = await withEnv({ INSIGHT_CV_ENABLED: v, INSIGHT_ENABLED: "true" },
      () => run_cv_insight(RUN_LOG, l.add, { connect: () => { connected = true; throw new Error("must not connect"); } }));
    assert.deepStrictEqual(r, { skipped: "disabled" }, String(v));
    assert.strictEqual(connected, false);
    assert.deepStrictEqual(l.events, []);
  }
});

test("on: one CV lock for the whole stage, a run_log event per step and a summary, unlock and pool closed", async () => {
  const d = fakeDb();
  const s = fakeStage({ result: await okResult() });
  const l = logger();
  let mode = null;
  const r = await on(() => run_cv_insight(RUN_LOG, l.add, { connect: (m, o) => { mode = m; assert.strictEqual(o.applicationName, "insight_cv_stage"); return d.db; }, stage: s }));
  assert.strictEqual(mode, "writer");
  assert.deepStrictEqual(d.calls, ["lock:insight_ge_cv", "unlock", "release", "end"]);
  assert.strictEqual(s.calls.length, 1);
  assert.strictEqual(s.calls[0].run_id, RUN_LOG.run_id); // job_state.last_run_id = the GE_CV run's id
  assert.deepStrictEqual(l.events.map((e) => `${e.type}:${e.note.step}`), ["INFO:extract", "INFO:derive", "INFO:findings", "INFO:summary"]);
  assert.ok(l.events.every((e) => e.func === "run_cv_insight" && e.tag === "DETAILS"));
  assert.strictEqual(l.events[3].note.watermarks_equal, true);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(stage.LOCK_KEY, "insight_ge_cv", "the CV lock, not CT's");
});

test("a step with a warning is a WARN event carrying the warnings", async () => {
  const res = await okResult();
  res.steps.findings.stats.drift = 1;
  const l = logger();
  await on(() => run_cv_insight(RUN_LOG, l.add, { connect: () => fakeDb().db, stage: fakeStage({ result: res }) }));
  assert.deepStrictEqual(l.events.map((e) => `${e.type}:${e.note.step}`), ["INFO:extract", "INFO:derive", "WARN:findings", "INFO:summary"]);
  assert.deepStrictEqual(l.events[2].note.warnings, ["findings drift: 1"]);
});

test("lock held: logged as a skip, no unlock of a lock it doesn't hold, pool closed", async () => {
  const d = fakeDb({ got: false });
  const s = fakeStage({ result: await okResult() });
  const l = logger();
  const r = await on(() => run_cv_insight(RUN_LOG, l.add, { connect: () => d.db, stage: s }));
  assert.deepStrictEqual(r, { skipped: "lock" });
  assert.deepStrictEqual(d.calls, ["lock:insight_ge_cv", "release", "end"]);
  assert.strictEqual(s.calls.length, 0);
  assert.deepStrictEqual(l.events.map((e) => `${e.type}:${e.note.step}`), ["INFO:lock"]);
});

test("preflight failure (wrong role, old schema, C1/C2 missing): WARN and skip, nothing run, unlocked", async () => {
  const d = fakeDb();
  const s = fakeStage({ preflight: async () => { throw new Error("insight schema version 7 < 8: apply migration 008 first"); } });
  const l = logger();
  const r = await on(() => run_cv_insight(RUN_LOG, l.add, { connect: () => d.db, stage: s }));
  assert.strictEqual(r.skipped, "preflight");
  assert.strictEqual(s.calls.length, 0);
  assert.deepStrictEqual(d.calls, ["lock:insight_ge_cv", "unlock", "release", "end"]);
  assert.deepStrictEqual(l.events.map((e) => `${e.type}:${e.note.step}`), ["WARN:preflight"]);
  assert.match(l.events[0].note.skipped, /008/);
});

test("a failed step is an ERROR event with the error; the summary is a WARN; never thrown", async () => {
  const res = await okResult();
  delete res.steps.findings;
  res.steps.derive = { error: "statement timeout", ms: 120000 };
  Object.assign(res, { ok: false, failed: "derive", error: new Error("statement timeout"), watermarks_equal: false });
  const d = fakeDb();
  const l = logger();
  const r = await on(() => run_cv_insight(RUN_LOG, l.add, { connect: () => d.db, stage: fakeStage({ result: res }) }));
  assert.strictEqual(r.ok, false);
  assert.deepStrictEqual(l.events.map((e) => `${e.type}:${e.note.step}`), ["INFO:extract", "ERROR:derive", "WARN:summary"]);
  assert.strictEqual(l.events[1].tag, "CATCH");
  assert.match(l.events[1].err.message, /statement timeout/);
  assert.deepStrictEqual(d.calls, ["lock:insight_ge_cv", "unlock", "release", "end"]);
});

test("never rejects: connect, the stage, the unlock and the logger can all throw", async () => {
  let l = logger();
  let r = await on(() => run_cv_insight(RUN_LOG, l.add, { connect: () => { throw new Error("INSIGHT_PG_USER / INSIGHT_PG_PW not set"); }, stage: fakeStage() }));
  assert.match(r.error, /INSIGHT_PG_USER/);
  assert.deepStrictEqual(l.events.map((e) => `${e.type}:${e.note.step}`), ["ERROR:stage"]);
  const d = fakeDb({ unlockThrows: true });
  l = logger();
  r = await on(() => run_cv_insight(RUN_LOG, l.add, { connect: () => d.db, stage: fakeStage({ throws: new Error("connection terminated") }) }));
  assert.match(r.error, /connection terminated/);
  assert.deepStrictEqual(d.calls, ["lock:insight_ge_cv", "unlock", "release", "end"]);
  const d2 = fakeDb();
  const ok2 = await okResult();
  r = await on(() => run_cv_insight(RUN_LOG, logger({ throws: true }).add, { connect: () => d2.db, stage: fakeStage({ result: ok2 }) }));
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(d2.calls, ["lock:insight_ge_cv", "unlock", "release", "end"]);
  const s3 = fakeStage({ result: await okResult() });
  await on(() => run_cv_insight({ log_events: [] }, logger().add, { connect: () => fakeDb().db, stage: s3 }));
  assert.match(s3.calls[0].run_id, /^[0-9a-f-]{36}$/);
});

test("bounded: connect timeout and a query backstop above the statement timeout", async () => {
  assert.ok(CONNECT_TIMEOUT_MS > 0 && CONNECT_TIMEOUT_MS <= 30000);
  assert.ok(QUERY_TIMEOUT_MS > STATEMENT_TIMEOUT_MS);
  let opts = null;
  const r = await on(() => run_cv_insight(RUN_LOG, logger().add, { connect: (m, o) => { opts = o; throw new Error("timeout expired"); }, stage: fakeStage() }));
  assert.deepStrictEqual([opts.connectTimeoutMs, opts.queryTimeoutMs, opts.statementTimeoutMs], [CONNECT_TIMEOUT_MS, QUERY_TIMEOUT_MS, STATEMENT_TIMEOUT_MS]);
  assert.match(r.error, /timeout expired/);
});

test("deadline: a stage past it is abandoned: ERROR, connection killed, pool closed, nothing logged after", async () => {
  assert.ok(STAGE_DEADLINE_MS >= 60000 && STAGE_DEADLINE_MS <= 10 * 60000, "minutes, well under the 30-min cadence");
  const d = fakeDb();
  let rejectStage;
  const s = fakeStage();
  s.run_stage = () => new Promise((_, rej) => { rejectStage = rej; });
  d.sco.onKill = () => rejectStage(new Error("Connection terminated"));
  const l = logger();
  const t0 = Date.now();
  const r = await on(() => run_cv_insight(RUN_LOG, l.add, { connect: () => d.db, stage: s, deadline_ms: 60 }));
  assert.deepStrictEqual(r, { error: "deadline" });
  assert.ok(Date.now() - t0 < 2000);
  assert.deepStrictEqual(d.calls, ["lock:insight_ge_cv", "kill", "end"]);
  assert.deepStrictEqual(l.events.map((e) => `${e.type}:${e.note.step}`), ["ERROR:deadline"]);
  await new Promise((res) => setTimeout(res, 20));
  assert.strictEqual(l.events.length, 1);
});

test("insight/cv/index.js loads no module at require time (off = the GE_CV process is unchanged)", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
  const top = src.split("async function run_cv_insight")[0];
  assert.ok(!/require\(/.test(top), "no top-level require");
});

test("cli stage: --rehearse only, nothing else", () => {
  const { args } = require("../cli");
  assert.strictEqual(args(["stage", "--rehearse"]).cmd, "stage");
  for (const bad of [["stage"], ["stage", "--apply"], ["stage", "--rehearse", "--apply"], ["stage", "--rehearse", "--replay"], ["stage", "--rehearse", "--to-id", "5"], ["stage", "--rehearse", "--system", "SME1"]]) {
    assert.throws(() => args(bad), /stage takes only --rehearse/, bad.join(" "));
  }
  const src = fs.readFileSync(path.join(__dirname, "..", "cli.js"), "utf8");
  assert.match(src, /Type the database name to continue/);
  assert.ok(src.indexOf("await confirm(db)") < src.indexOf("rehearse_stage(db"), "the prompt comes before the rehearsal");
});

test("STEPS: the real steps; findings runs the CV-4 apply preflight first and writes nothing if it refuses", async () => {
  const saved = { pre: frun.preflight, step: frun.findings_step, ex: load.extract_step, dv: derive.derive_step };
  const calls = [];
  try {
    frun.preflight = async (c, o) => { calls.push(["preflight", o.mode]); };
    frun.findings_step = async (c, o) => { calls.push(["findings_step", o.today]); return { stats: {} }; };
    load.extract_step = async (c, o) => { calls.push(["extract_step", o.max_batches]); return {}; };
    derive.derive_step = async (c, pgp, o) => { calls.push(["derive_step", typeof pgp.helpers, o.full]); return {}; };
    await stage.STEPS.extract({}, { max_batches: 1 });
    await stage.STEPS.derive({}, {});
    await stage.STEPS.findings({}, { today: "2026-11-12" });
    assert.deepStrictEqual(calls, [["extract_step", 1], ["derive_step", "object", undefined], ["preflight", "apply"], ["findings_step", "2026-11-12"]]);
    calls.length = 0;
    frun.preflight = async () => { throw new Error("GE CV derive is not caught up (pending: SME1"); };
    await assert.rejects(stage.STEPS.findings({}, { today: "2026-11-12" }), /not caught up/);
    assert.deepStrictEqual(calls, [], "no findings written after a refused preflight");
  } finally {
    Object.assign(frun, { preflight: saved.pre, findings_step: saved.step });
    load.extract_step = saved.ex;
    derive.derive_step = saved.dv;
  }
});

test("review CV5-STAGE: the rehearsal is one REPEATABLE READ transaction (a concurrent CT commit can't show as a CT change)", () => {
  assert.match(stage.REHEARSAL_TX_MODE.begin(), /^begin isolation level repeatable read$/i);
  const src = fs.readFileSync(path.join(__dirname, "..", "stage.js"), "utf8");
  assert.match(src, /conn\.tx\(\{ mode: REHEARSAL_TX_MODE \}, async \(t\) => \{\n\s+const before = \{ watermarks/);
});

test("review CV5-CORES P3: a manual findings apply logs each system's drift details", async () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "findings", "run.js"), "utf8");
  const core = src.slice(src.indexOf("async function findings_step"));
  assert.match(core, /for \(const d of r\.drift\.slice\(0, 5\)\) log\(`    drift: \$\{d\}`\)/);
});
