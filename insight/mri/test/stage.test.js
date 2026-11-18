"use strict";
// node insight/mri/test/stage.test.js   (no DB needed)
// The MRI-5 stage (PLAN-MRI-INSIGHTS.md §11.2): extract_step, run_stage,
// the run_log summaries, stage_preflight, and run_mri_insight through the
// shared wrapper insight/stage_wrapper.js (kill switch, one lock,
// preflight, failures, the deadline). Modelled on insight/cv/test/stage.test.js.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const stage = require("../stage");
const load = require("../load");
const derive = require("../derive");
const frun = require("../findings/run");
// NOT required at the top: ../index (checked below to load nothing when
// off) and ../../stage_wrapper (checked to stay unloaded when off).
const WRAPPER = path.join(__dirname, "..", "..", "stage_wrapper.js");
const MRI_INDEX = path.join(__dirname, "..", "index.js");

// ------------------------------------------------------------ extract_step

// A row with no system: skipped by the rules, so a batch has no facts and
// only job state is written (made-up values).
const noSystem = (id) => ({ id: String(id), capture_datetime: new Date("2026-11-16T15:48:05Z"), system_id: null, epoch: 1794850000, record_number_concurrent: 0,
  message_number: 2218714, type: "hostA\tscn", message: "x", coil: null, psd: null, host_datetime: new Date("2026-11-16T15:40:00Z") });

// The source has two batches waiting (101-102, 103-104): the stage must take one.
function batchConn({ batches = [[noSystem(101), noSystem(102)], [noSystem(103), noSystem(104)]], job = { watermark_id: "100", watermark_capture_datetime: null }, max = "150" } = {}) {
  let reads = 0;
  const jobWrites = [];
  const batchParams = [];
  const queries = [];
  const conn = {
    batchParams, jobWrites, queries,
    oneOrNone: async (q) => { queries.push(q); return job; },
    one: async (q) => { queries.push(q); return { m: max }; },
    any: async (q, p) => { batchParams.push(p); return batches[reads++] || []; },
    tx: async (cb) => cb({
      any: async () => [],
      oneOrNone: async () => null,
      one: async () => ({ last_run_stats: {} }),
      none: async (q, p) => { if (/INSERT INTO insight\.job_state \(job_name, watermark_id/.test(q)) jobWrites.push({ watermark: p[1], status: p[5], stats: JSON.parse(p[6]) }); },
    }),
  };
  return conn;
}

test("extract_step: from the watermark, one batch by default, behind_ids against the source max", async () => {
  const conn = batchConn();
  const r = await load.extract_step(conn, { run_id: "x" });
  assert.deepStrictEqual([r.from, r.watermark, r.end, r.behind_ids], [100, 102, 150, 48]);
  assert.deepStrictEqual(conn.batchParams, [[100, 150, null]], "ONE batch read, from the watermark to the source max (a second one is waiting)");
  assert.strictEqual(r.stats.mode, "stage");
  assert.deepStrictEqual([r.stats.batches, r.stats.rows, r.stats.facts], [1, 2, 0]);
  assert.deepStrictEqual(r.stats.skipped, { no_system: 2 });
  assert.deepStrictEqual(conn.jobWrites.map((w) => [w.watermark, w.status]), [[102, "ok"]]);
  assert.ok(conn.queries.some((q) => /max\(id\), 0\) AS m FROM log\.ge_mri_gesys/.test(q)), "the source max is MRI's table");
  // to_id (the rehearsal) bounds the read; behind_ids still counts to the source max
  const c2 = batchConn();
  const r2 = await load.extract_step(c2, { run_id: "x", to_id: 120 });
  assert.deepStrictEqual(c2.batchParams[0], [100, 120, null]);
  assert.strictEqual(r2.behind_ids, 48);
});

test("extract_step: refuses without a watermark, and an invalid registry before any query", async () => {
  await assert.rejects(load.extract_step(batchConn({ job: null }), { run_id: "x" }), /no ge_mri_extract watermark: run `mri\/cli\.js backfill --apply` first/);
  const conn = batchConn();
  await assert.rejects(load.extract_step(conn, { run_id: "x", check: () => ["bad rule"] }), /invalid MRI rule registry, nothing written: bad rule/);
  assert.deepStrictEqual([conn.queries, conn.batchParams, conn.jobWrites], [[], [], []]);
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
        stats: { mode: "stage", batches: 1, rows: 10, records: 9, duplicates: 1, facts: 7, upserted: 7, collisions: 0, skipped: { no_system: 0, outside_partitions: 1 },
          rule_errors: 0, unreviewed_codes: [], late: { rows: 2, records: 0, duplicates: 2, facts: 0, inserted: 0, systems: [] } } }),
      derive: mk("derive", { watermark: 20, pending_after: {},
        stats: { full: false, systems: 1, daily: [{ system_id: "SME1", scope: 2, deleted: 5, inserted: 6 }, { system_id: "SME2", scope: "none" }], codes: { codes: 823, unlabeled: 462, uncategorized: 462 } } }),
      findings: mk("findings", { watermark: 20, drift_detail: [],
        stats: { systems: 17, evaluated: 6, skipped_stale: ["SME3"], inserted: 0, updated: 1, deleted: 0, drift: 0, findings: 69, open: 26 } }),
    },
  };
}
const WM = (e, d, f) => ({ ge_mri_extract: e, ge_mri_derive: d, ge_mri_findings: f });
const wmConn = (w = WM(20, 20, 20)) => ({
  any: async (q, p) => {
    assert.deepStrictEqual(p, [["ge_mri_extract", "ge_mri_derive", "ge_mri_findings"]]);
    return Object.entries(w).map(([job_name, watermark_id]) => ({ job_name, watermark_id: String(watermark_id) }));
  },
});

test("run_stage: extract -> derive -> findings, one batch per run, today = the UTC date, one run id", async () => {
  const f = fakeSteps();
  const r = await stage.run_stage(wmConn(), { now: new Date("2026-11-16T23:48:30Z"), run_id: "x", steps: f.steps });
  assert.deepStrictEqual(f.calls.map((c) => c.name), ["extract", "derive", "findings"]);
  assert.strictEqual(f.calls[0].opts.max_batches, 1);
  assert.strictEqual(f.calls[0].opts.to_id, null);
  assert.strictEqual(f.calls[2].opts.today, "2026-11-16");
  assert.ok(f.calls.every((c) => c.opts.run_id === "x"));
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.watermarks, WM(20, 20, 20));
  assert.strictEqual(r.watermarks_equal, true);
  for (const k of ["extract", "derive", "findings"]) assert.ok(Number.isFinite(r.steps[k].ms), k);
});

test("run_stage: a step runs only if the one before succeeded; the failure is returned, not thrown", async () => {
  for (const fail of ["extract", "derive", "findings"]) {
    const f = fakeSteps(fail);
    const r = await stage.run_stage(wmConn(WM(20, 10, 10)), { run_id: "x", steps: f.steps });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.failed, fail);
    assert.match(r.error.message, new RegExp(`${fail} broke`));
    assert.strictEqual(f.calls[f.calls.length - 1].name, fail, "nothing after the failed step");
    assert.strictEqual(r.watermarks_equal, false);
  }
  const r = await stage.run_stage({ any: async () => { throw new Error("gone"); } }, { run_id: "x", steps: fakeSteps().steps });
  assert.deepStrictEqual([r.ok, r.failed, r.watermarks_equal], [false, "watermarks", false]);
});

test("watermarks_equal: all three present and the same; the MRI job names and lock", () => {
  assert.strictEqual(stage.watermarks_equal(WM(5, 5, 5)), true);
  assert.strictEqual(stage.watermarks_equal(WM(5, 5, 0)), false);
  assert.strictEqual(stage.watermarks_equal(WM(null, null, null)), false);
  assert.deepStrictEqual(stage.JOBS, ["ge_mri_extract", "ge_mri_derive", "ge_mri_findings"]);
  assert.strictEqual(stage.LOCK_KEY, "insight_ge_mri");
  assert.strictEqual(stage.MIN_SCHEMA_VERSION, 9);
});

test("summaries and warnings: log-friendly; WARN for late inserts, rule errors, unreviewed codes, a backlog, pending left, a slow derive, drift", async () => {
  const f = fakeSteps();
  const s = {};
  for (const [k, fn] of Object.entries(f.steps)) s[k] = { ...(await fn(null, {})), ms: 3 };
  assert.deepStrictEqual(stage.summarize("extract", s.extract), { ms: 3, from: 10, to: 20, behind_ids: 0, batches: 1, rows: 10, records: 9, duplicates: 1, facts: 7,
    upserted: 7, collisions: 0, skipped: { outside_partitions: 1 }, rule_errors: 0, unreviewed_codes: [], late: { rows: 2, facts: 0, inserted: 0, systems: [] } });
  assert.deepStrictEqual(stage.summarize("derive", s.derive), { ms: 3, to: 20, systems: ["SME1"], days: 2, full: 0, daily: { deleted: 5, inserted: 6 },
    codes: { codes: 823, unlabeled: 462, uncategorized: 462 }, pending_after: [] });
  assert.deepStrictEqual(stage.summarize("findings", s.findings), { ms: 3, to: 20, evaluated: 6, skipped_stale: ["SME3"], inserted: 0, updated: 1, deleted: 0, drift: 0, findings: 69, open: 26 });
  for (const k of Object.keys(s)) assert.deepStrictEqual(stage.step_warnings(k, s[k]), [], k);
  const ex = JSON.parse(JSON.stringify(s.extract));
  Object.assign(ex, { behind_ids: 9000 });
  Object.assign(ex.stats, { unreviewed_codes: [999], rule_errors: 2 });
  Object.assign(ex.stats.late, { inserted: 2, systems: ["SME1"] });
  assert.deepStrictEqual(stage.step_warnings("extract", ex), ["late-commit re-read inserted 2 facts (SME1)",
    "2 rule errors (rows the MRI rules could not classify; see mri/cli.js dry-run)",
    "error codes not yet reviewed (counted in mri.error only): 999", "extract is 9000 ids behind the source (one batch per run; the next runs catch up)"]);
  assert.deepStrictEqual(stage.step_warnings("derive", { ...s.derive, pending_after: { SME1: ["2026-11-16"] } }), ["derive left pending days: SME1"]);
  // plan §11.3 Q3: the code-label rebuild is watched; at the limit no WARN, above it one
  assert.deepStrictEqual(stage.step_warnings("derive", { ...s.derive, ms: stage.DERIVE_WARN_MS }), []);
  assert.deepStrictEqual(stage.step_warnings("derive", { ...s.derive, ms: stage.DERIVE_WARN_MS + 1 }),
    [`derive took ${stage.DERIVE_WARN_MS + 1} ms (> 30000): the code-label rebuild grows with mri.error; plan a cheaper rebuild (plan §11.3 Q3)`]);
  assert.deepStrictEqual(stage.step_warnings("findings", { stats: { drift: 2 } }), ["findings drift: 2"]);
  assert.deepStrictEqual(stage.summarize("derive", { error: "x", ms: 4 }), { error: "x", ms: 4 });
  assert.deepStrictEqual(stage.step_warnings("derive", { error: "x" }), []);
});

// ---------------------------------------------------------- stage_preflight

async function asWriter(fn) {
  const old = process.env.INSIGHT_PG_USER;
  process.env.INSIGHT_PG_USER = "insight_writer";
  try { return await fn(); } finally { if (old === undefined) delete process.env.INSIGHT_PG_USER; else process.env.INSIGHT_PG_USER = old; }
}

test("stage_preflight: the extract apply preflight, schema >= 9, and an extract watermark", async () => {
  const saved = load.preflight;
  const seen = [];
  try {
    const conn = (job) => ({ oneOrNone: async (q, p) => { assert.deepStrictEqual(p, ["ge_mri_extract"]); return job; } });
    load.preflight = async (c, o) => { seen.push(o.mode); return { user: "insight_writer", schema_version: 9, partition_warning: false }; };
    assert.deepStrictEqual(await stage.stage_preflight(conn({ watermark_id: "5" })), { user: "insight_writer", schema_version: 9, partition_warning: false });
    await assert.rejects(stage.stage_preflight(conn(null)), /no ge_mri_extract watermark: run `mri\/cli\.js backfill --apply` first/);
    load.preflight = async () => ({ user: "insight_writer", schema_version: 8 });
    await assert.rejects(stage.stage_preflight(conn({ watermark_id: "5" })), /version 8 < 9: apply migration 009/);
    load.preflight = async () => { throw new Error("refusing --apply: CT verifiers not yet scoped to CT keys (plan §6.4 C1-MRI)"); };
    await assert.rejects(stage.stage_preflight(conn({ watermark_id: "5" })), /C1-MRI/);
    assert.deepStrictEqual(seen, ["apply", "apply"], "the apply preflight, not the rehearsal one");
  } finally { load.preflight = saved; }
});

test("stage_preflight with the real extract preflight: passes once C1-MRI is in (plan §10), refused as a superuser, another role or without C2-MRI", async () => {
  const fake = ({ u = "insight_writer", su = false, can_read = true } = {}) => ({
    one: async (q) => (/current_user/.test(q) ? { u, su, can_read } : /schema_migrations/.test(q) ? { v: 9 } : { last: "ge_mri_facts_2028_12" }),
    oneOrNone: async () => ({ watermark_id: "5" }),
  });
  await asWriter(async () => {
    // C1-MRI is done in this checkout (every CT verifier exports MRI_AWARE), so the live stage may start;
    // the refusal itself is covered by mri.test.js "C1-MRI interlock" with fake modules.
    const pre = await stage.stage_preflight(fake());
    assert.strictEqual(pre.schema_version, 9);
    await assert.rejects(stage.stage_preflight(fake({ su: true })), /expected the limited/);
    await assert.rejects(stage.stage_preflight(fake({ u: "someone_else" })), /expected the limited/);
    await assert.rejects(stage.stage_preflight(fake({ can_read: false })), /C2-MRI/);
  });
});

test("the rehearsal's others check covers every non-MRI row of the shared tables, by prefix (no backslash)", () => {
  assert.match(stage.OTHERS_SQL, /insight\.findings WHERE source <> 'ge_mri'/);
  assert.match(stage.OTHERS_SQL, /finding_catalog WHERE left\(finding_key, 4\) <> 'mri_'/);
  assert.match(stage.OTHERS_SQL, /metric_catalog WHERE left\(metric_key, 4\) <> 'mri\.'/);
  assert.match(stage.OTHERS_SQL, /job_state WHERE left\(job_name, 7\) <> 'ge_mri_'/);
  assert.strictEqual("ge_mri_".length, 7);
  assert.match(stage.RANGE_SQL, /FROM log\.ge_mri_gesys WHERE id > \$1/);
  assert.doesNotMatch(stage.OTHERS_SQL + stage.RANGE_SQL + stage.MRI_COUNTS_SQL, /\\/);
});

test("plan §11.2 items 4 and 6: the stage rehearsal and findings --rehearse are REPEATABLE READ (a concurrent CT / CV commit can't show as 'others changed')", () => {
  assert.match(stage.REHEARSAL_TX_MODE.begin(), /^begin isolation level repeatable read$/i);
  assert.match(frun.REHEARSAL_TX_MODE.begin(), /^begin isolation level repeatable read$/i);
  const src = fs.readFileSync(path.join(__dirname, "..", "stage.js"), "utf8");
  assert.match(src, /conn\.tx\(\{ mode: REHEARSAL_TX_MODE \}, async \(t\) => \{\n\s+const before = \{ watermarks/);
  const fsrc = fs.readFileSync(path.join(__dirname, "..", "findings", "run.js"), "utf8");
  assert.match(fsrc, /if \(mode === "rehearse"\) \{\n(\s+\/\/.*\n)+\s+return await conn\.tx\(\{ mode: REHEARSAL_TX_MODE \}, async \(t\) => \{\n\s+const before = await t\.one\(COUNTS_SQL\);/);
});

test("STEPS: the real cores; findings runs the MRI-4 apply preflight first and writes nothing if it refuses", async () => {
  const saved = { pre: frun.preflight, step: frun.findings_step, ex: load.extract_step, dv: derive.derive_step };
  const calls = [];
  try {
    frun.preflight = async (c, o) => { calls.push(["preflight", o.mode]); };
    frun.findings_step = async (c, o) => { calls.push(["findings_step", o.today]); return { stats: {} }; };
    load.extract_step = async (c, o) => { calls.push(["extract_step", o.max_batches]); return {}; };
    derive.derive_step = async (c, pgp, o) => { calls.push(["derive_step", typeof pgp.helpers, o.full]); return {}; };
    await stage.STEPS.extract({}, { max_batches: 1 });
    await stage.STEPS.derive({}, {});
    await stage.STEPS.findings({}, { today: "2026-11-16" });
    assert.deepStrictEqual(calls, [["extract_step", 1], ["derive_step", "object", undefined], ["preflight", "apply"], ["findings_step", "2026-11-16"]]);
    calls.length = 0;
    frun.preflight = async () => { throw new Error("GE MRI derive is not caught up (pending: SME1)"); };
    await assert.rejects(stage.STEPS.findings({}, { today: "2026-11-16" }), /not caught up/);
    assert.deepStrictEqual(calls, [], "no findings written after a refused preflight");
  } finally {
    Object.assign(frun, { preflight: saved.pre, findings_step: saved.step });
    load.extract_step = saved.ex;
    derive.derive_step = saved.dv;
  }
});

test("cli stage: --rehearse only, nothing else; the database name is asked first", () => {
  const { args } = require("../cli");
  assert.strictEqual(args(["stage", "--rehearse"]).cmd, "stage");
  for (const bad of [["stage"], ["stage", "--apply"], ["stage", "--rehearse", "--apply"], ["stage", "--rehearse", "--replay"], ["stage", "--rehearse", "--to-id", "5"],
    ["stage", "--rehearse", "--system", "SME1"], ["stage", "--rehearse", "--full"], ["stage", "--rehearse", "--batches", "1"]]) {
    assert.throws(() => args(bad), /stage takes only --rehearse/, bad.join(" "));
  }
  const src = fs.readFileSync(path.join(__dirname, "..", "cli.js"), "utf8");
  const branch = src.slice(src.indexOf('if (a.cmd === "stage") {\n    try {'));
  assert.ok(branch.indexOf('await confirm(db, { mode: "rehearse", what: "STAGE" })') > 0, "the prompt");
  assert.ok(branch.indexOf("await confirm(db") < branch.indexOf("rehearse_stage(db"), "the prompt comes before the rehearsal");
  assert.match(src, /Type the database name to continue/);
});

// ---------------------------------------- run_mri_insight + stage_wrapper

function fakeDb({ got = true, unlockThrows = false, connectThrows = null } = {}) {
  const calls = [];
  const sco = {
    one: async (q, p) => {
      if (/pg_try_advisory_lock/.test(q)) { calls.push(`lock:${p[0]}`); return { got }; }
      if (/pg_advisory_unlock/.test(q)) { calls.push(`unlock:${p[0]}`); if (unlockThrows) throw new Error("connection lost"); return { ok: true }; }
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

function fakeStage({ preflight = async () => ({ partition_warning: false }), result = null, throws = null } = {}) {
  const calls = [];
  return {
    calls,
    LOCK_KEY: "insight_ge_mri",
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
  return { today: "2026-11-16", ok: true, failed: null, error: null, watermarks: WM(20, 20, 20), watermarks_equal: true, steps };
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
const on = (fn) => withEnv({ INSIGHT_MRI_ENABLED: "true" }, fn);
const RUN_LOG = { run_id: "6f1c0d3e-6a51-4f43-9a52-0d1b5c7e2a10", log_events: [] };
const steps_of = (l) => l.events.map((e) => `${e.type}:${e.note.step}`);

test("insight/mri/index.js loads no module at require time, and off loads not even the shared wrapper", async () => {
  const src = fs.readFileSync(MRI_INDEX, "utf8");
  const top = src.split("async function run_mri_insight")[0];
  assert.ok(!/require\(/.test(top), "no top-level require");
  assert.strictEqual(require.cache[WRAPPER], undefined, "nothing loaded the wrapper yet");
  const { run_mri_insight } = require("../index");
  await withEnv({ INSIGHT_MRI_ENABLED: undefined }, () => run_mri_insight(RUN_LOG, logger().add));
  assert.strictEqual(require.cache[WRAPPER], undefined, "off: the wrapper is not loaded");
});

test("kill switch: off unless INSIGHT_MRI_ENABLED=true (CT's and CV's switches don't turn it on); off connects to nothing and logs nothing", async () => {
  const { run_mri_insight } = require("../index");
  for (const v of [undefined, "", "false", "TRUE", "1", "yes", " true"]) {
    const l = logger();
    let connected = false;
    const r = await withEnv({ INSIGHT_MRI_ENABLED: v, INSIGHT_ENABLED: "true", INSIGHT_CV_ENABLED: "true" },
      () => run_mri_insight(RUN_LOG, l.add, { connect: () => { connected = true; throw new Error("must not connect"); } }));
    assert.deepStrictEqual(r, { skipped: "disabled" }, String(v));
    assert.strictEqual(connected, false);
    assert.deepStrictEqual(l.events, []);
  }
});

test("on: the MRI lock for the whole stage, a run_log event per step and a summary, unlock and pool closed", async () => {
  const { run_mri_insight, FUNC, APP_NAME } = require("../index");
  const d = fakeDb();
  const s = fakeStage({ result: await okResult() });
  const l = logger();
  let mode = null;
  let opts = null;
  const r = await on(() => run_mri_insight(RUN_LOG, l.add, { connect: (m, o) => { mode = m; opts = o; return d.db; }, stage: s }));
  assert.strictEqual(mode, "writer");
  assert.strictEqual(opts.applicationName, "insight_mri_stage");
  assert.deepStrictEqual([FUNC, APP_NAME], ["run_mri_insight", "insight_mri_stage"]);
  assert.deepStrictEqual(d.calls, ["lock:insight_ge_mri", "unlock:insight_ge_mri", "release", "end"]);
  assert.strictEqual(s.calls.length, 1);
  assert.strictEqual(s.calls[0].run_id, RUN_LOG.run_id); // job_state.last_run_id = the GE_MRI run's id
  assert.ok(s.calls[0].now instanceof Date);
  assert.deepStrictEqual(Object.keys(s.calls[0]), ["now", "run_id"], "MRI passes no extra run_stage options");
  assert.deepStrictEqual(steps_of(l), ["INFO:extract", "INFO:derive", "INFO:findings", "INFO:summary"]);
  assert.ok(l.events.every((e) => e.func === "run_mri_insight" && e.tag === "DETAILS"));
  assert.strictEqual(l.events[3].note.watermarks_equal, true);
  assert.deepStrictEqual(l.events[3].note.watermarks, WM(20, 20, 20));
  assert.deepStrictEqual(r, { ok: true, failed: null, watermarks: WM(20, 20, 20), watermarks_equal: true });
});

test("a step with a warning is a WARN event carrying the warnings; a partition warning is a WARN and the run goes on", async () => {
  const { run_mri_insight } = require("../index");
  const res = await okResult();
  res.steps.findings.stats.drift = 1;
  let l = logger();
  await on(() => run_mri_insight(RUN_LOG, l.add, { connect: () => fakeDb().db, stage: fakeStage({ result: res }) }));
  assert.deepStrictEqual(steps_of(l), ["INFO:extract", "INFO:derive", "WARN:findings", "INFO:summary"]);
  assert.deepStrictEqual(l.events[2].note.warnings, ["findings drift: 1"]);
  l = logger();
  const s = fakeStage({ result: await okResult(), preflight: async () => ({ partition_warning: true, last_partition: "ge_mri_facts_2028_12", months_left: 17 }) });
  const r = await on(() => run_mri_insight(RUN_LOG, l.add, { connect: () => fakeDb().db, stage: s }));
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(steps_of(l), ["WARN:preflight", "INFO:extract", "INFO:derive", "INFO:findings", "INFO:summary"]);
  assert.strictEqual(l.events[0].note.warning, "insight.ge_mri_facts partitions end at ge_mri_facts_2028_12 (17 months left): add partitions (plan §6.6)");
});

test("lock held: logged as a skip, no unlock of a lock it doesn't hold, pool closed", async () => {
  const { run_mri_insight } = require("../index");
  const d = fakeDb({ got: false });
  const s = fakeStage({ result: await okResult() });
  const l = logger();
  const r = await on(() => run_mri_insight(RUN_LOG, l.add, { connect: () => d.db, stage: s }));
  assert.deepStrictEqual(r, { skipped: "lock" });
  assert.deepStrictEqual(d.calls, ["lock:insight_ge_mri", "release", "end"]);
  assert.strictEqual(s.calls.length, 0);
  assert.deepStrictEqual(steps_of(l), ["INFO:lock"]);
  assert.strictEqual(l.events[0].note.skipped, "another GE MRI insight run holds the lock; the next run catches up");
});

test("preflight failure (wrong role, old schema, C1-MRI / C2-MRI missing, no watermark): WARN and skip, nothing run, unlocked", async () => {
  const { run_mri_insight } = require("../index");
  const d = fakeDb();
  const s = fakeStage({ preflight: async () => { throw new Error("no ge_mri_extract watermark: run `mri/cli.js backfill --apply` first"); } });
  const l = logger();
  const r = await on(() => run_mri_insight(RUN_LOG, l.add, { connect: () => d.db, stage: s }));
  assert.deepStrictEqual(r, { skipped: "preflight", reason: "no ge_mri_extract watermark: run `mri/cli.js backfill --apply` first" });
  assert.strictEqual(s.calls.length, 0);
  assert.deepStrictEqual(d.calls, ["lock:insight_ge_mri", "unlock:insight_ge_mri", "release", "end"]);
  assert.deepStrictEqual(steps_of(l), ["WARN:preflight"]);
});

test("a failed step is an ERROR event with the error; the summary is a WARN; never thrown", async () => {
  const { run_mri_insight } = require("../index");
  const res = await okResult();
  delete res.steps.findings;
  res.steps.derive = { error: "statement timeout", ms: 120000 };
  Object.assign(res, { ok: false, failed: "derive", error: new Error("statement timeout"), watermarks_equal: false });
  const d = fakeDb();
  const l = logger();
  const r = await on(() => run_mri_insight(RUN_LOG, l.add, { connect: () => d.db, stage: fakeStage({ result: res }) }));
  assert.strictEqual(r.ok, false);
  assert.deepStrictEqual(steps_of(l), ["INFO:extract", "ERROR:derive", "WARN:summary"]);
  assert.strictEqual(l.events[1].tag, "CATCH");
  assert.match(l.events[1].err.message, /statement timeout/);
  assert.deepStrictEqual(d.calls, ["lock:insight_ge_mri", "unlock:insight_ge_mri", "release", "end"]);
  // a failed watermark read is its own ERROR
  const res2 = await okResult();
  Object.assign(res2, { ok: false, failed: "watermarks", error: new Error("gone"), watermarks: null, watermarks_equal: false });
  const l2 = logger();
  await on(() => run_mri_insight(RUN_LOG, l2.add, { connect: () => fakeDb().db, stage: fakeStage({ result: res2 }) }));
  assert.deepStrictEqual(steps_of(l2), ["INFO:extract", "INFO:derive", "INFO:findings", "ERROR:watermarks", "WARN:summary"]);
});

test("never rejects: connect, the stage, the unlock, the logger and the wrapper's require can all throw", async () => {
  const { run_mri_insight } = require("../index");
  let l = logger();
  let r = await on(() => run_mri_insight(RUN_LOG, l.add, { connect: () => { throw new Error("INSIGHT_PG_USER / INSIGHT_PG_PW not set"); }, stage: fakeStage() }));
  assert.match(r.error, /INSIGHT_PG_USER/);
  assert.deepStrictEqual(steps_of(l), ["ERROR:stage"]);
  const d = fakeDb({ unlockThrows: true });
  l = logger();
  r = await on(() => run_mri_insight(RUN_LOG, l.add, { connect: () => d.db, stage: fakeStage({ throws: new Error("connection terminated") }) }));
  assert.match(r.error, /connection terminated/);
  assert.deepStrictEqual(d.calls, ["lock:insight_ge_mri", "unlock:insight_ge_mri", "release", "end"]);
  const d2 = fakeDb();
  const ok2 = await okResult();
  r = await on(() => run_mri_insight(RUN_LOG, logger({ throws: true }).add, { connect: () => d2.db, stage: fakeStage({ result: ok2 }) }));
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(d2.calls, ["lock:insight_ge_mri", "unlock:insight_ge_mri", "release", "end"]);
  const s3 = fakeStage({ result: await okResult() });
  await on(() => run_mri_insight({ log_events: [] }, logger().add, { connect: () => fakeDb().db, stage: s3 }));
  assert.match(s3.calls[0].run_id, /^[0-9a-f-]{36}$/);
  // a wrapper that can't be loaded: an ERROR event, no rejection (also with a throwing logger)
  const broken = { get run_insight_stage() { throw new Error("Cannot find module '../stage_wrapper'"); } };
  l = logger();
  r = await on(() => run_mri_insight(RUN_LOG, l.add, { wrapper: broken }));
  assert.match(r.error, /Cannot find module/);
  assert.deepStrictEqual(l.events.map((e) => [e.type, e.func, e.tag, e.note.step]), [["ERROR", "run_mri_insight", "CATCH", "stage"]]);
  r = await on(() => run_mri_insight(RUN_LOG, logger({ throws: true }).add, { wrapper: broken }));
  assert.match(r.error, /Cannot find module/);
  // the loading stage module itself can throw (cfg.load_stage)
  l = logger();
  const { run_insight_stage } = require("../../stage_wrapper");
  r = await run_insight_stage({ func: "f", app_name: "a", label: "L", load_stage: () => { throw new Error("stage broke at load"); } }, RUN_LOG, l.add, { connect: () => fakeDb().db });
  assert.match(r.error, /stage broke at load/);
  assert.deepStrictEqual(steps_of(l), ["ERROR:stage"]);
});

test("stage_wrapper: an incomplete cfg is an ERROR before any connection", async () => {
  const { run_insight_stage } = require("../../stage_wrapper");
  for (const k of ["func", "app_name", "label", "load_stage"]) {
    const cfg = { func: "f", app_name: "a", label: "L", load_stage: () => fakeStage() };
    delete cfg[k];
    const l = logger();
    let connected = false;
    const r = await run_insight_stage(cfg, RUN_LOG, l.add, { connect: () => { connected = true; return fakeDb().db; } });
    assert.match(r.error, new RegExp(`cfg lacks ${k}`), k);
    assert.strictEqual(connected, false, k);
    assert.deepStrictEqual(steps_of(l), ["ERROR:stage"], k);
  }
});

test("stage_wrapper: run_args are loaded before connecting and passed to run_stage (CT's rules, for MRI-5b)", async () => {
  const { run_insight_stage } = require("../../stage_wrapper");
  const order = [];
  const s = fakeStage({ result: await okResult() });
  const d = fakeDb();
  const r = await run_insight_stage({ func: "f", app_name: "a", label: "L", load_stage: () => s, run_args: (deps) => { order.push("args"); return { rules: deps.rules }; } },
    RUN_LOG, logger().add, { connect: () => { order.push("connect"); return d.db; }, rules: ["r1"] });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(order, ["args", "connect"]);
  assert.deepStrictEqual(Object.keys(s.calls[0]), ["rules", "now", "run_id"]);
  assert.deepStrictEqual(s.calls[0].rules, ["r1"]);
});

test("bounded: connect timeout and a query backstop above the statement timeout", async () => {
  const { run_mri_insight } = require("../index");
  const W = require("../../stage_wrapper");
  assert.ok(W.CONNECT_TIMEOUT_MS > 0 && W.CONNECT_TIMEOUT_MS <= 30000);
  assert.ok(W.QUERY_TIMEOUT_MS > W.STATEMENT_TIMEOUT_MS);
  assert.deepStrictEqual([W.STATEMENT_TIMEOUT_MS, W.CONNECT_TIMEOUT_MS, W.QUERY_TIMEOUT_MS, W.STAGE_DEADLINE_MS], [120000, 10000, 135000, 300000], "the CT / CV values");
  let opts = null;
  const r = await on(() => run_mri_insight(RUN_LOG, logger().add, { connect: (m, o) => { opts = o; throw new Error("timeout expired"); }, stage: fakeStage() }));
  assert.deepStrictEqual([opts.connectTimeoutMs, opts.queryTimeoutMs, opts.statementTimeoutMs], [W.CONNECT_TIMEOUT_MS, W.QUERY_TIMEOUT_MS, W.STATEMENT_TIMEOUT_MS]);
  assert.match(r.error, /timeout expired/);
});

test("deadline: a stage past it is abandoned: ERROR, connection killed, pool closed, nothing logged after", async () => {
  const { run_mri_insight } = require("../index");
  const d = fakeDb();
  let rejectStage;
  const s = fakeStage();
  s.run_stage = () => new Promise((_, rej) => { rejectStage = rej; });
  d.sco.onKill = () => rejectStage(new Error("Connection terminated"));
  const l = logger();
  const t0 = Date.now();
  const r = await on(() => run_mri_insight(RUN_LOG, l.add, { connect: () => d.db, stage: s, deadline_ms: 60 }));
  assert.deepStrictEqual(r, { error: "deadline" });
  assert.ok(Date.now() - t0 < 2000);
  assert.deepStrictEqual(d.calls, ["lock:insight_ge_mri", "kill", "end"]);
  assert.deepStrictEqual(steps_of(l), ["ERROR:deadline"]);
  assert.match(l.events[0].err.message, /^GE MRI insight stage exceeded 60 ms: connection closed/);
  await new Promise((res) => setTimeout(res, 20));
  assert.strictEqual(l.events.length, 1);
});

test("isolation: the shared wrapper loads only ./db and crypto (no modality module); MRI's index loads only the wrapper and ./stage", () => {
  const req = (f) => [...fs.readFileSync(f, "utf8").matchAll(/require\(\s*["'`]([^"'`]+)["'`]\s*\)/g)].map((m) => m[1]).sort();
  assert.deepStrictEqual(req(WRAPPER), ["./db", "crypto"]);
  assert.deepStrictEqual(req(MRI_INDEX), ["../stage_wrapper", "./stage"]);
});

// ----------------------------------------------- review MRI5-STAGE (P3, note)

// A DB-free rehearsal: watermark 100, pending max 120, the last run from 111
// (so catch-up to 110, typical to 120, no rows); extract fails in run `fail_at`.
function rehearsalDb({ fail_at = null } = {}) {
  let wm = 100;
  const calls = [];
  const conn = {
    one: async (q, p) => {
      if (/pg_try_advisory_lock/.test(q)) { calls.push("lock"); return { got: true }; }
      if (/pg_advisory_unlock/.test(q)) { calls.push("unlock"); return { ok: true }; }
      if (q === stage.MRI_COUNTS_SQL) return { facts: 1 };
      if (q === stage.OTHERS_SQL) return { findings: "a", finding_catalog: "b", metric_catalog: "c", job_state: "d" };
      if (q === stage.RANGE_SQL) return { max_id: "120", n: 20, first_capture: new Date("2026-11-16T10:18:00Z"), last_capture: new Date("2026-11-16T10:48:00Z"), last_run_from: "111", last_run_rows: 10 };
      throw new Error(`unexpected one ${q.slice(0, 40)}`);
    },
    any: async () => stage.JOBS.map((job_name) => ({ job_name, watermark_id: String(wm) })),
    oneOrNone: async () => ({ p: {}, c: false }),
    tx: async (mode, cb) => {
      calls.push(mode.mode === stage.REHEARSAL_TX_MODE ? "tx:repeatable read" : "tx:other");
      const saved = wm;
      try { return await cb(conn); } finally { wm = saved; calls.push("rollback"); }
    },
  };
  let n = 0;
  const steps = {
    extract: async (c, o) => {
      if (++n === fail_at) throw new Error("natural-key conflict probe");
      wm = o.to_id;
      return { from: 0, watermark: wm, end: wm, behind_ids: 0, stats: { batches: 1, rows: 1, records: 1, duplicates: 0, facts: 1, upserted: 1, collisions: 0, skipped: {}, rule_errors: 0, unreviewed_codes: [], late: {} } };
    },
    derive: async () => ({ watermark: wm, pending_after: {}, stats: { daily: [], codes: {} } }),
    findings: async () => ({ watermark: wm, stats: { drift: 0 } }),
  };
  return { db: { task: async (cb) => cb(conn) }, calls, steps };
}

async function withStubbedStage(steps, fn) {
  const saved = { pre: load.preflight, job: load.read_job, ex: load.extract_step, dv: derive.derive_step, fp: frun.preflight, fs: frun.findings_step };
  load.preflight = async () => ({ user: "insight_writer", schema_version: 9, last_partition: "p", months_left: 25 });
  load.read_job = async () => ({ watermark_id: "100" });
  load.extract_step = steps.extract;
  derive.derive_step = async (c, pgp, o) => steps.derive(c, o);
  frun.preflight = async () => {};
  frun.findings_step = steps.findings;
  try { return await fn(); } finally {
    Object.assign(load, { preflight: saved.pre, read_job: saved.job, extract_step: saved.ex });
    derive.derive_step = saved.dv;
    Object.assign(frun, { preflight: saved.fp, findings_step: saved.fs });
  }
}

test("review MRI5-STAGE P3: a failure in the first or the middle rehearsal run returns a structured failed result (no TypeError), rolled back and unlocked", async () => {
  for (const [fail_at, ran] of [[1, 1], [2, 2]]) {
    const f = rehearsalDb({ fail_at });
    const lines = [];
    const r = await withStubbedStage(f.steps, () => stage.rehearse_stage(f.db, { log: (s) => lines.push(s) }));
    assert.strictEqual(r.rolled_back, true, `fail at ${fail_at}`);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.runs.length, ran, "only the executed runs");
    assert.strictEqual(r.runs[ran - 1].failed, "extract");
    assert.strictEqual(r.runs[ran - 1].error, "natural-key conflict probe");
    assert.deepStrictEqual([r.checks.runs_ok, r.checks.caught_up, r.checks.findings_drift], [false, false, 0]);
    assert.strictEqual(r.checks.not_run.length, 3 - ran);
    assert.strictEqual(r.checks.verify, undefined, "no verify after a failed run");
    assert.strictEqual(r.watermarks_unchanged_after_rollback, true);
    assert.deepStrictEqual(f.calls, ["lock", "tx:repeatable read", "rollback", "unlock"]);
    assert.ok(lines.some((l) => /FAILED at extract: natural-key conflict probe/.test(l)));
    assert.ok(lines.some((l) => /^not run after the failure: /.test(l)));
  }
  // the plan: catch-up to 110, typical to 120, no rows to 120
  const f = rehearsalDb({ fail_at: 3 });
  const r = await withStubbedStage(f.steps, () => stage.rehearse_stage(f.db, {}));
  assert.deepStrictEqual(r.runs.map((x) => x.to_id), [110, 120, 120]);
  assert.deepStrictEqual(r.checks.not_run, []);
  assert.strictEqual(r.checks.runs_ok, false);
});

test("review MRI5-STAGE note: in a fresh process, run_mri_insight with the switch off loads no module at all and logs nothing", () => {
  const { spawnSync } = require("child_process");
  const script = `
    const Module = require("module");
    const orig = Module._load;
    const idx = require(${JSON.stringify(MRI_INDEX)});
    const loaded = [];
    Module._load = function (req, ...rest) { loaded.push(req); return orig.call(this, req, ...rest); };
    const events = [];
    delete process.env.INSIGHT_MRI_ENABLED;
    idx.run_mri_insight({ log_events: [] }, async (...a) => events.push(a)).then((r) => {
      process.stdout.write(JSON.stringify({ r, loaded, events: events.length }));
    });`;
  const out = spawnSync(process.execPath, ["-e", script], { encoding: "utf8", env: { ...process.env, INSIGHT_MRI_ENABLED: "" } });
  assert.strictEqual(out.status, 0, out.stderr);
  assert.deepStrictEqual(JSON.parse(out.stdout), { r: { skipped: "disabled" }, loaded: [], events: 0 });
});
