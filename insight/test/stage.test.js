"use strict";
// node insight/test/stage.test.js   (no DB needed)
// The Phase 5 stage (PLAN-CT-INSIGHTS.md §15.2): pending touched days and
// systems, the daily trigger, the late-commit re-read and job_state SQL,
// step sequencing, and the hook's contract (off by default, never throws,
// one lock, pool closed).
const test = require("node:test");
const assert = require("node:assert");
const { merge_pending, scope_from_pending, pending_summary, fleet_today_of, daily_pass_due, touched_cte, PENDING_FULL_DAYS } = require("../pending");
const { upsert_statements, apply_batches, LATE_SQL, LATE_WINDOW_S } = require("../load");
const { WRITE_JOB_SQL: DERIVE_WRITE_JOB_SQL } = require("../derive/run");
const { WRITE_JOB_SQL: FINDINGS_WRITE_JOB_SQL } = require("../findings/run");
const { OFFSET_BREAKS_SQL } = require("../derive/daily");
const stage = require("../stage");
const { run_ct_insight, CONNECT_TIMEOUT_MS, QUERY_TIMEOUT_MS, STATEMENT_TIMEOUT_MS } = require("../index");
const { rules } = require("../rules/ge_ct");

// ----------------------------------------------------------- pending days

test("merge_pending: union of days per system, sorted; input not modified", () => {
  const before = { SME1: ["2026-11-03"] };
  const out = merge_pending(before, [
    { system_id: "SME1", day: "2026-11-04", offset_breaks: false },
    { system_id: "SME1", day: "2026-11-03", offset_breaks: false },
    { system_id: "SME2", day: "2026-11-04", offset_breaks: false },
  ]);
  assert.deepStrictEqual(out, { SME1: ["2026-11-03", "2026-11-04"], SME2: ["2026-11-04"] });
  assert.deepStrictEqual(before, { SME1: ["2026-11-03"] });
  assert.deepStrictEqual(merge_pending(null, []), {});
});

test("merge_pending: an offset break, a bad day or too many days make the system a full rebuild, and full stays full", () => {
  assert.deepStrictEqual(merge_pending({ SME1: ["2026-11-03"] }, [{ system_id: "SME1", day: "2026-11-04", offset_breaks: true }]), { SME1: "full" });
  assert.deepStrictEqual(merge_pending({}, [{ system_id: "SME1", day: null, offset_breaks: false }]), { SME1: "full" });
  assert.deepStrictEqual(merge_pending({ SME1: "full" }, [{ system_id: "SME1", day: "2026-11-04", offset_breaks: false }]), { SME1: "full" });
  const many = Array.from({ length: PENDING_FULL_DAYS }, (_, i) => ({ system_id: "SME1", day: `2026-10-${String(i + 1).padStart(2, "0")}`, offset_breaks: false }));
  assert.strictEqual(merge_pending({}, many).SME1.length, PENDING_FULL_DAYS);
  assert.strictEqual(merge_pending({}, [...many, { system_id: "SME1", day: "2026-11-01", offset_breaks: false }]).SME1, "full");
});

test("scope_from_pending: days or full; malformed entries are rebuilt in full; summary counts", () => {
  const scope = scope_from_pending({ SME2: ["2026-11-04"], SME1: "full", SME3: ["bad"], SME4: 7 });
  assert.deepStrictEqual([...scope.keys()], ["SME1", "SME2", "SME3", "SME4"]);
  assert.deepStrictEqual(scope.get("SME1"), { full: true });
  assert.deepStrictEqual([...scope.get("SME2").days], ["2026-11-04"]);
  assert.deepStrictEqual(scope.get("SME3"), { full: true });
  assert.deepStrictEqual(scope.get("SME4"), { full: true });
  assert.strictEqual(scope_from_pending(null).size, 0);
  assert.deepStrictEqual(pending_summary({ SME1: "full", SME2: ["2026-11-03", "2026-11-04"] }), { systems: 2, days: 2, full: 1 });
});

test("daily pass (§15.3 Q3): due on the first run whose UTC date differs from the last fleet run's", () => {
  // the row written by the Phase 4 replay: no fleet_today, a fleet-wide run
  const phase4 = { today: "2026-11-04", replay: true, systems_selected: "all" };
  assert.strictEqual(fleet_today_of(phase4), "2026-11-04");
  assert.strictEqual(daily_pass_due(fleet_today_of(phase4), "2026-11-04"), false);
  assert.strictEqual(daily_pass_due(fleet_today_of(phase4), "2026-11-05"), true);
  // a touched run carries fleet_today; its own `today` is not a fleet date
  assert.strictEqual(fleet_today_of({ today: "2026-11-05", systems_selected: 3, fleet_today: "2026-11-04" }), "2026-11-04");
  assert.strictEqual(fleet_today_of({ today: "2026-11-05", systems_selected: 3 }), null);
  assert.strictEqual(fleet_today_of(null), null);
  assert.strictEqual(daily_pass_due(null, "2026-11-05"), true);
});

// ------------------------------------------------------------------- SQL

test("facts upsert returns the touched days of what it inserted, with the same offset test as derive", () => {
  const f = { system_id: "SME1", epoch: 1, record_number_concurrent: 0, metric_key: "env.plenum_temp", host_datetime: new Date("2026-11-01T06:51:58Z"),
    host_local: "2026-11-01T01:51:58", value_num: 1, value_text: null, exam_no: null, attrs: null, source_id: 1, source_capture_datetime: new Date(), rule_version: 1 };
  const [q] = upsert_statements([f]);
  assert.match(q, /RETURNING system_id, host_datetime, host_local\)/);
  assert.match(q, /to_char\(up\.host_local, 'YYYY-MM-DD'\) AS day/);
  assert.match(q, /count\(\*\)::int AS n\s+FROM up GROUP BY 1, 2/);
  // derive's touched_from_source_range test, on the returned rows
  assert.ok(q.includes(`bool_or(${OFFSET_BREAKS_SQL.replace(/\bf\./g, "up.")})`));
  assert.strictEqual(touched_cte("X").includes("WITH up AS (X"), true);
});

test("late-commit re-read: at or below the watermark, 2 h of captures before its capture time, rows without facts", () => {
  assert.strictEqual(LATE_WINDOW_S, 7200);
  assert.match(LATE_SQL, /WHERE g\.id <= \$1 AND g\.capture_datetime >= \$2::timestamptz - make_interval\(secs => \$3\)/);
  assert.match(LATE_SQL, /NOT EXISTS \(SELECT 1 FROM insight\.ge_ct_facts f WHERE f\.source_id = g\.id\)/);
  assert.match(LATE_SQL, /ORDER BY g\.id\s*$/);
  // the same columns as the batch read (host_local from the device date/time)
  assert.match(LATE_SQL, /to_char\(to_date\(host_date, 'DD-Mon-YYYY'\) \+ host_time/);
});

test("job_state writes keep the pending work and the per-system as-of dates", () => {
  // derive: pending is kept, a run's stats can't overwrite it
  assert.match(DERIVE_WRITE_JOB_SQL, /jsonb_build_object\('pending', coalesce\(job_state\.last_run_stats -> 'pending', '\{\}'::jsonb\)\) \|\| \(EXCLUDED\.last_run_stats - 'pending'\)/);
  // findings: fleet_today first (the run's stats override it), as_of_by_system and pending_systems last (kept)
  const i_fleet = FINDINGS_WRITE_JOB_SQL.indexOf("'fleet_today', job_state.last_run_stats -> 'fleet_today'");
  const i_ex = FINDINGS_WRITE_JOB_SQL.indexOf("(EXCLUDED.last_run_stats - 'as_of_by_system' - 'pending_systems')");
  const i_kept = FINDINGS_WRITE_JOB_SQL.indexOf("jsonb_build_object('as_of_by_system', coalesce(job_state.last_run_stats -> 'as_of_by_system'");
  assert.ok(i_fleet > 0 && i_ex > i_fleet && i_kept > i_ex, "order: kept fleet_today || run stats || kept as_of/pending");
  assert.match(FINDINGS_WRITE_JOB_SQL, /'pending_systems', coalesce\(job_state\.last_run_stats -> 'pending_systems', '\{\}'::jsonb\)/);
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
        stats: { batches: 1, rows: 10, facts: 7, upserted: 7, collisions: 0, rule_errors: 0, skipped: { missing_key: 0 }, late: { rows: 3, facts: 0, inserted: 0, systems: [], rule_errors: 0 } } }),
      derive: mk("derive", { from: 10, watermark: 20, systems: 1, days: 1, full_rebuilds: [], per_system_ms: { SME1: 5 },
        stats: { derived_inserted: 0, derived_updated: 0, derived_deleted: 0, daily_inserted: 4, exams_inserted: 1, clock: { ok: 1 } } }),
      findings: mk("findings", { from: 10, watermark: 20, mode: "touched", systems: 1, skipped_stale: 0, drift_detail: [],
        stats: { evaluated: 1, inserted: 0, updated: 0, deleted: 0, drift: 0, findings: 2, open: 1 } }),
    },
  };
}
const wmConn = (w = { ge_ct_extract: 20, ge_ct_derive: 20, ge_ct_findings: 20 }) => ({
  any: async () => Object.entries(w).map(([job_name, watermark_id]) => ({ job_name, watermark_id: String(watermark_id) })),
});

test("run_stage: extract -> derive -> findings, one batch per run, today = the UTC date", async () => {
  const f = fakeSteps();
  const r = await stage.run_stage(wmConn(), { rules, now: new Date("2026-11-05T00:18:30Z"), run_id: "x", steps: f.steps });
  assert.deepStrictEqual(f.calls.map((c) => c.name), ["extract", "derive", "findings"]);
  assert.strictEqual(f.calls[0].opts.max_batches, 1);
  assert.strictEqual(f.calls[2].opts.today, "2026-11-05");
  assert.strictEqual(f.calls[2].opts.force_daily, false);
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.watermarks, { ge_ct_extract: 20, ge_ct_derive: 20, ge_ct_findings: 20 });
  assert.strictEqual(r.watermarks_equal, true);
  for (const k of ["extract", "derive", "findings"]) assert.ok(Number.isFinite(r.steps[k].ms), k);
});

test("run_stage: a step runs only if the one before succeeded; the failure is returned, not thrown", async () => {
  for (const [fail, ran] of [["extract", ["extract"]], ["derive", ["extract", "derive"]], ["findings", ["extract", "derive", "findings"]]]) {
    const f = fakeSteps(fail);
    const r = await stage.run_stage(wmConn({ ge_ct_extract: 20, ge_ct_derive: 10, ge_ct_findings: 10 }), { rules, run_id: "x", steps: f.steps });
    assert.deepStrictEqual(f.calls.map((c) => c.name), ran, fail);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.failed, fail);
    assert.match(r.steps[fail].error, /broke/);
    assert.strictEqual(r.watermarks_equal, false);
  }
  // invalid rules: extract fails before reading anything
  const f = fakeSteps();
  const r = await stage.run_stage(wmConn(), { rules: [{ key: "Bad Key" }], run_id: "x", steps: f.steps });
  assert.strictEqual(r.failed, "extract");
  assert.deepStrictEqual(f.calls, []);
});

test("step summaries are small and warnings flag late commits, rule errors and drift", () => {
  const s = { from: 1, watermark: 2, behind_ids: 0, ms: 3,
    stats: { batches: 1, rows: 5, facts: 2, upserted: 2, collisions: 0, rule_errors: 1, skipped: { missing_key: 0, no_host_local: 2 },
      late: { rows: 4, facts: 2, inserted: 2, systems: ["SME1"], rule_errors: 0 } } };
  const sum = stage.summarize("extract", s);
  assert.deepStrictEqual(sum.skipped, { no_host_local: 2 });
  assert.deepStrictEqual(sum.late, { rows: 4, facts: 2, inserted: 2, systems: ["SME1"], rule_errors: 0 });
  assert.deepStrictEqual(stage.step_warnings("extract", s), ["late-commit re-read inserted 2 facts (SME1)", "rule errors: 1"]);
  assert.deepStrictEqual(stage.step_warnings("findings", { stats: { drift: 2 } }), ["findings drift: 2"]);
  assert.deepStrictEqual(stage.step_warnings("derive", { stats: {} }), []);
  assert.deepStrictEqual(stage.summarize("derive", { error: "x", ms: 4 }), { error: "x", ms: 4 });
});

// --------------------------------------------------------- run_ct_insight

function fakeDb({ got = true, unlockThrows = false } = {}) {
  const calls = [];
  const conn = {
    one: async (q) => {
      if (/pg_try_advisory_lock/.test(q)) { calls.push("lock"); return { got }; }
      if (/pg_advisory_unlock/.test(q)) { calls.push("unlock"); if (unlockThrows) throw new Error("connection lost"); return { ok: true }; }
      throw new Error(`unexpected query ${q}`);
    },
  };
  const db = { task: async (fn) => fn(conn), $pool: { end: async () => { calls.push("end"); } } };
  return { db, calls };
}

function fakeStage({ preflight = async () => ({ partition_warning: false }), result = null, throws = null } = {}) {
  const calls = [];
  return {
    calls,
    LOCK_KEY: "insight_ge_ct",
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

const okResult = () => ({ today: "2026-11-05", ok: true, failed: null, error: null, watermarks: { ge_ct_extract: 20, ge_ct_derive: 20, ge_ct_findings: 20 }, watermarks_equal: true,
    steps: { extract: { from: 10, watermark: 20, behind_ids: 0, stats: { batches: 1, rows: 10, facts: 7, upserted: 7, collisions: 0, rule_errors: 0, skipped: {}, late: { rows: 3, facts: 0, inserted: 0, systems: [], rule_errors: 0 } }, ms: 5 },
      derive: { from: 10, watermark: 20, systems: 1, days: 1, full_rebuilds: [], per_system_ms: {}, stats: { derived_inserted: 0, derived_updated: 0, derived_deleted: 0, daily_inserted: 4, exams_inserted: 1, clock: {} }, ms: 6 },
      findings: { from: 10, watermark: 20, mode: "touched", systems: 1, skipped_stale: 0, drift_detail: [], stats: { evaluated: 1, inserted: 0, updated: 0, deleted: 0, drift: 0, findings: 2, open: 1 }, ms: 7 } } });

function logger({ throws = false } = {}) {
  const events = [];
  const add = async (type, run_log, func, tag, note, err) => {
    events.push({ type, func, tag, note, err });
    if (throws) throw new Error("logger broke");
  };
  return { events, add };
}

async function withEnv(value, fn) {
  const old = process.env.INSIGHT_ENABLED;
  if (value === undefined) delete process.env.INSIGHT_ENABLED; else process.env.INSIGHT_ENABLED = value;
  try { return await fn(); } finally { if (old === undefined) delete process.env.INSIGHT_ENABLED; else process.env.INSIGHT_ENABLED = old; }
}
const RUN_LOG = { run_id: "6f1c0d3e-6a51-4f43-9a52-0d1b5c7e2a10", log_events: [] };

test("kill switch: off unless INSIGHT_ENABLED=true; off connects to nothing and logs nothing", async () => {
  for (const v of [undefined, "", "false", "TRUE", "1", "yes", " true"]) {
    const l = logger();
    let connected = false;
    const r = await withEnv(v, () => run_ct_insight(RUN_LOG, l.add, { connect: () => { connected = true; throw new Error("must not connect"); } }));
    assert.deepStrictEqual(r, { skipped: "disabled" }, String(v));
    assert.strictEqual(connected, false);
    assert.deepStrictEqual(l.events, []);
  }
});

test("on: one lock for the whole stage, a run_log event per step and a summary, unlock and pool closed", async () => {
  const d = fakeDb();
  const s = fakeStage({ result: okResult() });
  const l = logger();
  let mode = null;
  const r = await withEnv("true", () => run_ct_insight(RUN_LOG, l.add, { connect: (m, o) => { mode = m; assert.strictEqual(o.applicationName, "insight_stage"); return d.db; }, stage: s, rules }));
  assert.strictEqual(mode, "writer");
  assert.deepStrictEqual(d.calls, ["lock", "unlock", "end"]);
  assert.strictEqual(s.calls.length, 1);
  assert.strictEqual(s.calls[0].run_id, RUN_LOG.run_id); // job_state.last_run_id = the ge_ct run's id
  assert.deepStrictEqual(l.events.map((e) => `${e.type}:${e.note.step}`), ["INFO:extract", "INFO:derive", "INFO:findings", "INFO:summary"]);
  assert.ok(l.events.every((e) => e.func === "run_ct_insight" && e.tag === "DETAILS"));
  assert.strictEqual(l.events[3].note.watermarks_equal, true);
  assert.strictEqual(r.ok, true);
});

test("lock held: logged as a skip, no unlock of a lock it doesn't hold, pool closed", async () => {
  const d = fakeDb({ got: false });
  const s = fakeStage({ result: okResult() });
  const l = logger();
  const r = await withEnv("true", () => run_ct_insight(RUN_LOG, l.add, { connect: () => d.db, stage: s, rules }));
  assert.deepStrictEqual(r, { skipped: "lock" });
  assert.deepStrictEqual(d.calls, ["lock", "end"]);
  assert.strictEqual(s.calls.length, 0);
  assert.deepStrictEqual(l.events.map((e) => `${e.type}:${e.note.step}`), ["INFO:lock"]);
});

test("preflight failure (wrong role, old schema): WARN and skip, nothing run, unlocked", async () => {
  const d = fakeDb();
  const s = fakeStage({ preflight: async () => { throw new Error("insight schema version 4 < 5"); } });
  const l = logger();
  const r = await withEnv("true", () => run_ct_insight(RUN_LOG, l.add, { connect: () => d.db, stage: s, rules }));
  assert.strictEqual(r.skipped, "preflight");
  assert.strictEqual(s.calls.length, 0);
  assert.deepStrictEqual(d.calls, ["lock", "unlock", "end"]);
  assert.deepStrictEqual(l.events.map((e) => `${e.type}:${e.note.step}`), ["WARN:preflight"]);
  // partition runway warning is logged but the stage runs
  const d2 = fakeDb();
  const s2 = fakeStage({ preflight: async () => ({ partition_warning: true, last_partition: "ge_ct_facts_2027_01", months_left: 2 }), result: okResult() });
  const l2 = logger();
  await withEnv("true", () => run_ct_insight(RUN_LOG, l2.add, { connect: () => d2.db, stage: s2, rules }));
  assert.strictEqual(l2.events[0].type, "WARN");
  assert.match(l2.events[0].note.warning, /add partitions/);
  assert.strictEqual(s2.calls.length, 1);
});

test("a failed step is an ERROR event with the error; the summary is a WARN; never thrown", async () => {
  const res = okResult();
  delete res.steps.findings;
  res.steps.derive = { error: "statement timeout", ms: 120000 };
  Object.assign(res, { ok: false, failed: "derive", error: new Error("statement timeout"), watermarks_equal: false });
  const d = fakeDb();
  const l = logger();
  const r = await withEnv("true", () => run_ct_insight(RUN_LOG, l.add, { connect: () => d.db, stage: fakeStage({ result: res }), rules }));
  assert.strictEqual(r.ok, false);
  assert.deepStrictEqual(l.events.map((e) => `${e.type}:${e.note.step}`), ["INFO:extract", "ERROR:derive", "WARN:summary"]);
  assert.strictEqual(l.events[1].tag, "CATCH");
  assert.match(l.events[1].err.message, /statement timeout/);
  assert.deepStrictEqual(d.calls, ["lock", "unlock", "end"]);
});

test("never rejects: connect, the stage, the unlock and the logger can all throw", async () => {
  // connect throws (e.g. INSIGHT_PG_USER unset)
  let l = logger();
  let r = await withEnv("true", () => run_ct_insight(RUN_LOG, l.add, { connect: () => { throw new Error("INSIGHT_PG_USER / INSIGHT_PG_PW not set"); }, stage: fakeStage(), rules }));
  assert.match(r.error, /INSIGHT_PG_USER/);
  assert.deepStrictEqual(l.events.map((e) => `${e.type}:${e.note.step}`), ["ERROR:stage"]);
  assert.ok(l.events[0].err instanceof Error);
  // run_stage throws outright; unlock throws too
  const d = fakeDb({ unlockThrows: true });
  l = logger();
  r = await withEnv("true", () => run_ct_insight(RUN_LOG, l.add, { connect: () => d.db, stage: fakeStage({ throws: new Error("connection terminated") }), rules }));
  assert.match(r.error, /connection terminated/);
  assert.deepStrictEqual(d.calls, ["lock", "unlock", "end"]);
  // the logger itself throws on every event
  const d2 = fakeDb();
  r = await withEnv("true", () => run_ct_insight(RUN_LOG, logger({ throws: true }).add, { connect: () => d2.db, stage: fakeStage({ result: okResult() }), rules }));
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(d2.calls, ["lock", "unlock", "end"]);
  // a run_log without a uuid run_id still gets a valid run id
  const s3 = fakeStage({ result: okResult() });
  await withEnv("true", () => run_ct_insight({ log_events: [] }, logger().add, { connect: () => fakeDb().db, stage: s3, rules }));
  assert.match(s3.calls[0].run_id, /^[0-9a-f-]{36}$/);
});

test("insight/index.js loads no module at require time (off = the ge_ct process is unchanged)", () => {
  const src = require("fs").readFileSync(require.resolve("../index"), "utf8");
  const top = src.split("async function run_ct_insight")[0];
  assert.ok(!/require\(/.test(top), "no top-level require");
});

test("cli stage: --rehearse only", () => {
  const { args } = require("../cli");
  assert.strictEqual(args(["stage", "--rehearse"]).cmd, "stage");
  assert.throws(() => args(["stage"]), /needs --rehearse/);
  assert.throws(() => args(["stage", "--apply"]), /no --apply/);
  assert.throws(() => args(["stage", "--rehearse", "--apply"]), /no --apply/);
  assert.throws(() => args(["stage", "--rehearse", "--systems", "SME1"]), /no other flags/);
});

// ------------------------------------------------------- review PHASE5-STAGE

test("F1: a batch whose COMMIT fails leaves the recorded watermark and stats at the last committed batch", async () => {
  const row = (id) => ({ id, capture_datetime: new Date("2026-11-04T16:18:00Z"), system_id: "SME1", epoch: id, record_number_concurrent: 0,
    type: "host\tnone", message: "nothing a rule matches", host_datetime: new Date("2026-11-04T16:00:00Z"), host_local: "2026-11-04T11:00:00" });
  let reads = 0;
  const jobWrites = [];
  let txs = 0;
  const conn = {
    any: async () => (reads++ === 0 ? [row(101), row(102)] : []),
    tx: async (cb) => {
      const n = ++txs;
      await cb({
        any: async () => [],
        oneOrNone: async () => null,
        none: async (q, p) => { if (/insight\.job_state/.test(q)) jobWrites.push({ tx: n, watermark: p[1], status: p[5], stats: JSON.parse(p[6]) }); },
      });
      if (n === 1) throw new Error("COMMIT failed"); // the body ran, the commit didn't
    },
  };
  const stats = { mode: "stage", rows: 0, facts: 0, upserted: 0, collisions: 0, batches: 0, skipped: {}, rule_errors: 0 };
  const job = { watermark_id: "100", watermark_capture_datetime: new Date("2026-11-04T15:48:00Z") };
  await assert.rejects(apply_batches(conn, { rules, start: 100, end: 102, max_batches: 1, job, run_id: "x", started_at: new Date(), stats }), /COMMIT failed/);
  const err = jobWrites.find((w) => w.status === "error");
  assert.ok(err, "error row written");
  assert.strictEqual(err.tx, 2);
  assert.strictEqual(err.watermark, 100, "the failed batch's id must not be recorded");
  assert.strictEqual(err.stats.batches, 0);
  assert.strictEqual(stats.rows, 0);
});

test("F1: a committed batch advances the watermark and stats", async () => {
  const row = (id) => ({ id, capture_datetime: new Date("2026-11-04T16:18:00Z"), system_id: "SME1", epoch: id, record_number_concurrent: 0,
    type: "host\tnone", message: "nothing a rule matches", host_datetime: new Date("2026-11-04T16:00:00Z"), host_local: "2026-11-04T11:00:00" });
  let reads = 0;
  const conn = { any: async () => (reads++ === 0 ? [row(101), row(102)] : []), tx: async (cb) => cb({ any: async () => [], oneOrNone: async () => null, none: async () => {} }) };
  const stats = { mode: "stage", rows: 0, facts: 0, upserted: 0, collisions: 0, batches: 0, skipped: {}, rule_errors: 0 };
  const r = await apply_batches(conn, { rules, start: 100, end: 102, max_batches: 1, job: { watermark_id: "100", watermark_capture_datetime: null }, run_id: "x", started_at: new Date(), stats });
  assert.strictEqual(r.watermark, 102);
  assert.strictEqual(stats.batches, 1);
  assert.strictEqual(stats.rows, 2);
});

test("F2: the stage's pool has a connect timeout and a query backstop above the statement timeout", async () => {
  assert.ok(CONNECT_TIMEOUT_MS > 0 && CONNECT_TIMEOUT_MS <= 30000);
  assert.ok(QUERY_TIMEOUT_MS > STATEMENT_TIMEOUT_MS);
  let opts = null;
  const l = logger();
  const r = await withEnv("true", () => run_ct_insight(RUN_LOG, l.add, { connect: (m, o) => { opts = o; throw new Error("timeout expired"); }, stage: fakeStage(), rules }));
  assert.strictEqual(opts.connectTimeoutMs, CONNECT_TIMEOUT_MS);
  assert.strictEqual(opts.queryTimeoutMs, QUERY_TIMEOUT_MS);
  assert.strictEqual(opts.statementTimeoutMs, STATEMENT_TIMEOUT_MS);
  assert.match(r.error, /timeout expired/);
  assert.deepStrictEqual(l.events.map((e) => `${e.type}:${e.note.step}`), ["ERROR:stage"]);
});

test("F2: connect() hands the timeouts to the pool only when given (no connection is opened)", { skip: !process.env.PG_SSL_PATH && "no PG_SSL_PATH" }, () => {
  const { connect } = require("../db");
  const a = connect("readonly", { connectTimeoutMs: 10000, queryTimeoutMs: 135000 });
  assert.strictEqual(a.$cn.connectionTimeoutMillis, 10000);
  assert.strictEqual(a.$cn.query_timeout, 135000);
  const b = connect("readonly");
  assert.ok(!("connectionTimeoutMillis" in b.$cn) && !("query_timeout" in b.$cn), "CLI connections unchanged");
});
