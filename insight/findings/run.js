"use strict";
// Running the findings stage (PLAN-CT-INSIGHTS.md §14.2, §14.5 step 4, §10).
//
// Runs ONLY as insight_writer, under the advisory lock shared with extract
// and derive (load.js LOCK_KEY).
//
// Every run recomputes each selected system's findings from its whole
// history (findings/state.js: pure, ~0.1 s per system) and reconciles
// insight.findings for that system:
//   --replay : the table becomes exactly the replay (insert / update /
//              delete, resolved history included). All systems.
//   default  : the Phase 5 path. Only systems with data in the last 7
//              device days are evaluated (others keep their state, §14.2
//              item 1); open findings are updated or removed, new ones
//              inserted. A stored RESOLVED finding whose resolve day is
//              still inside that 7-device-day window is treated like an
//              open one (its day may still be filling up: see
//              resolved_final); an older one is never changed or deleted,
//              and a difference there is reported as drift.
// An update happens only when a column differs, so a re-run changes nothing.
//
//   rehearse: ONE transaction, rolled back: pass 1 (the chosen mode); pass 2
//             (same again: must change nothing); after a replay, a default
//             pass (must change nothing, no drift); incremental consistency
//             (replay as of today-28, then default runs at today-21, -14,
//             -7, today: must end identical to pass 1, with no drift);
//             verify-findings on the uncommitted rows; ROLLBACK.
//   apply   : catalog sync, one transaction per system, then
//             insight.job_state 'ge_ct_findings' (fleet-wide runs only).
// Each system's transaction also records its as-of date in
// job_state.last_run_stats.as_of_by_system (fleet and --systems runs alike),
// so verify-findings re-derives every system at the date its rows were
// computed for (review PHASE4-RUN-VERIFY F2).
//
// Lock-free cores (the CLI and the Phase 5 stage hold the lock):
//   findings_apply_core: the apply loop; each system's transaction also
//             clears it from the pending systems derive marked (pending.js).
//   findings_step: the stage's step, default mode: the systems derive
//             touched since the last findings run, or all systems on the
//             first run of a new UTC date (§15.3 Q3), which also sets
//             fleet_today. Advances 'ge_ct_findings' to the derive watermark.
const { pgp } = require("../db");
const { LOCK_KEY } = require("../load");
const { load_inputs } = require("./load");
const { build_context, dnum, dstr } = require("./context");
const { replay_system } = require("./state");
const { finding_rules, catalog_rows } = require("./rules");
const { run_verify } = require("./verify");
const { clear_findings_pending, fleet_today_of, daily_pass_due } = require("../pending");

const JOB = "ge_ct_findings";
const MIN_SCHEMA_VERSION = 5; // finding_catalog, findings.data_through
const STALE_DAYS = 7;         // no data in the last 7 device days: not evaluated
const INCREMENTAL_STEPS = [-28, -21, -14, -7, 0];

const FINDINGS_CS = new pgp.helpers.ColumnSet([
  "system_id", "finding_key", { name: "opened_at", cast: "timestamptz" }, "source", "status", "severity",
  { name: "window_start", cast: "timestamptz" }, { name: "window_end", cast: "timestamptz" }, "observed", "baseline",
  { name: "evidence", cast: "jsonb", init: (c) => JSON.stringify(c.value) }, "rule_version",
  { name: "last_evaluated", cast: "timestamptz" }, { name: "resolved_at", cast: "timestamptz" }, { name: "data_through", cast: "date" },
], { table: new pgp.helpers.TableName({ table: "findings", schema: "insight" }) });
const UPDATABLE = ["source", "status", "severity", "window_start", "window_end", "observed", "baseline", "evidence", "rule_version",
  "last_evaluated", "resolved_at", "data_through"];
const UPSERT_SUFFIX = `
  ON CONFLICT (system_id, finding_key, opened_at) DO UPDATE SET
    ${UPDATABLE.map((c) => `${c} = EXCLUDED.${c}`).join(", ")}
  WHERE (${UPDATABLE.map((c) => `findings.${c}`).join(", ")}) IS DISTINCT FROM (${UPDATABLE.map((c) => `EXCLUDED.${c}`).join(", ")})`;

const CATALOG_CS = new pgp.helpers.ColumnSet(
  ["finding_key", "label", "description", "category", "default_severity", "rule_version", "customer_visible"],
  { table: new pgp.helpers.TableName({ table: "finding_catalog", schema: "insight" }) });
const CATALOG_SUFFIX = `
  ON CONFLICT (finding_key) DO UPDATE SET label = EXCLUDED.label, description = EXCLUDED.description, category = EXCLUDED.category,
    default_severity = EXCLUDED.default_severity, rule_version = EXCLUDED.rule_version, customer_visible = EXCLUDED.customer_visible,
    updated_at = now()
  WHERE (finding_catalog.label, finding_catalog.description, finding_catalog.category, finding_catalog.default_severity,
         finding_catalog.rule_version, finding_catalog.customer_visible)
    IS DISTINCT FROM (EXCLUDED.label, EXCLUDED.description, EXCLUDED.category, EXCLUDED.default_severity,
                      EXCLUDED.rule_version, EXCLUDED.customer_visible)`;

// Content of insight.findings (every column: all are deterministic).
const FINGERPRINT_SQL = `SELECT count(*)::int AS n, md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) AS md5
  FROM (SELECT system_id, finding_key, opened_at, source, status, severity, window_start, window_end, observed, baseline, evidence,
               rule_version, last_evaluated, resolved_at, data_through FROM insight.findings WHERE source = 'ge_ct') x`;
const COUNTS_SQL = `SELECT (SELECT count(*) FROM insight.findings)::int AS findings,
  (SELECT count(*) FROM insight.findings WHERE status = 'open')::int AS open,
  (SELECT count(*) FROM insight.finding_catalog)::int AS catalog`;
const STORED_SQL = `SELECT finding_key, opened_at, source, status, severity, window_start, window_end, observed, baseline, evidence,
  rule_version, last_evaluated, resolved_at, to_char(data_through, 'YYYY-MM-DD') AS data_through
  FROM insight.findings WHERE system_id = $1 AND source = 'ge_ct'`;

const keyOf = (r) => `${r.finding_key}|${new Date(r.opened_at).toISOString()}`;
// canonical JSON (sorted keys) for the drift comparison of resolved rows
const canon = (v) => (Array.isArray(v) ? `[${v.map(canon).join(",")}]`
  : v && typeof v === "object" ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(",")}}` : JSON.stringify(v));
// Every stored column of a finding, normalised, for the drift comparison.
const ts = (t) => (t === null || t === undefined ? null : new Date(t).toISOString());
const nm = (x) => (x === null || x === undefined ? null : Number(x));
const row_canon = (r) => canon({ source: r.source, status: r.status, severity: r.severity, window_start: ts(r.window_start),
  window_end: ts(r.window_end), observed: nm(r.observed), baseline: nm(r.baseline), evidence: r.evidence, rule_version: r.rule_version,
  last_evaluated: ts(r.last_evaluated), resolved_at: ts(r.resolved_at), data_through: String(r.data_through).slice(0, 10) });

async function preflight(t) {
  const who = await t.one("SELECT current_user AS u, (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS su");
  if (who.u !== process.env.INSIGHT_PG_USER || who.su) throw new Error(`refusing: connected as ${who.u}, expected the limited ${process.env.INSIGHT_PG_USER}`);
  const v = await t.one("SELECT coalesce(max(version), 0) AS v FROM insight.schema_migrations");
  if (v.v < MIN_SCHEMA_VERSION) throw new Error(`insight schema version ${v.v} < ${MIN_SCHEMA_VERSION}: apply migration 005 first`);
  return { user: who.u, schema_version: v.v };
}

async function sync_catalog(t) {
  const n = (await t.result(pgp.helpers.insert(catalog_rows(), CATALOG_CS) + CATALOG_SUFFIX)).rowCount;
  const extra = (await t.any("SELECT finding_key FROM insight.finding_catalog WHERE finding_key <> ALL($1)", [finding_rules.map((r) => r.key)]))
    .map((r) => r.finding_key);
  return { changed: n, extra };
}

async function all_systems(t) {
  return (await t.any("SELECT DISTINCT system_id FROM insight.ge_ct_daily ORDER BY 1")).map((r) => r.system_id);
}

// A stored resolved finding is final (default mode never changes it) once
// its resolve day (data_through) has left the system's evaluation window:
// it is STALE_DAYS or more device days older than the newest data day.
// Until then that day may still be filling up: a finding can resolve on the
// first facts of a device day, after which later facts move last_evaluated
// (= newest fact of data_through) or trip the rule again, so the replay
// keeps it open; a backlog after an outage or a late commit can do the same
// a few days later. (Monitoring 2026-11-05: SME01430 abort_rate_high
// resolved on a partly filled day and drifted on every later run.)
const resolved_final = (s, last_day) => s.status === "resolved" && dnum(s.data_through) <= dnum(last_day) - STALE_DAYS;

// Pure reconcile decision for one system: stored rows (from STORED_SQL) and
// the replay's rows, both Maps keyed by keyOf. replay: everything follows
// the replay. Default: open rows and resolved rows that aren't final follow
// the replay; final resolved rows are kept, a difference is drift.
function reconcile(system_id, stored, want, { replay, last_day }) {
  const frozen = (s) => !replay && resolved_final(s, last_day);
  const del = [], ups = [], drift = [];
  for (const [k, s] of stored) {
    if (want.has(k)) continue;
    if (frozen(s)) drift.push(`${system_id} ${k}: resolved finding no longer produced (kept)`);
    else del.push(s);
  }
  for (const [k, r] of want) {
    const s = stored.get(k);
    if (s && frozen(s)) {
      if (row_canon(r) !== row_canon(s)) drift.push(`${system_id} ${k}: resolved finding differs from the replay (kept)`);
      continue;
    }
    ups.push(r);
  }
  return { del, ups, drift };
}

// One system: compute, then reconcile its rows. Returns counts and the rows.
async function findings_system(t, system_id, { today, replay }) {
  const ctx = build_context(await load_inputs(t, system_id), today);
  const last = ctx.days.length ? ctx.days[ctx.days.length - 1].day : null;
  const out = { system_id, last_day: last, evaluated: true, inserted: 0, updated: 0, deleted: 0, unchanged: 0, drift: [], rows: [] };
  if (!replay && (!last || dnum(last) < dnum(today) - (STALE_DAYS - 1))) { out.evaluated = false; return out; }
  const rows = replay_system(ctx);
  out.rows = rows;
  await record_as_of(t, system_id, today);
  const stored = new Map((await t.any(STORED_SQL, [system_id])).map((r) => [keyOf(r), r]));
  const want = new Map(rows.map((r) => [keyOf(r), r]));

  const { del, ups, drift } = reconcile(system_id, stored, want, { replay, last_day: last });
  out.drift = drift;
  for (const s of del) {
    await t.none("DELETE FROM insight.findings WHERE system_id = $1 AND finding_key = $2 AND opened_at = $3", [system_id, s.finding_key, s.opened_at]);
    out.deleted++;
  }
  // resolved rows first, so a finding that closes frees (system, key) before a new one opens
  ups.sort((a, b) => (a.status === b.status ? 0 : a.status === "resolved" ? -1 : 1));
  if (ups.length) {
    const changed = (await t.result(pgp.helpers.insert(ups, FINDINGS_CS) + UPSERT_SUFFIX)).rowCount;
    const ins = ups.filter((r) => !stored.has(keyOf(r))).length;
    out.inserted = ins;
    out.updated = changed - ins;
    out.unchanged = ups.length - changed;
  }
  return out;
}

function totals(results) {
  const t = { systems: results.length, evaluated: 0, skipped_stale: [], findings: 0, open: 0, inserted: 0, updated: 0, deleted: 0, drift: 0 };
  for (const r of results) {
    if (!r.evaluated) { t.skipped_stale.push(`${r.system_id} (${r.last_day})`); continue; }
    t.evaluated++; t.findings += r.rows.length; t.open += r.rows.filter((x) => x.status === "open").length;
    t.inserted += r.inserted; t.updated += r.updated; t.deleted += r.deleted; t.drift += r.drift.length;
  }
  return t;
}
const changes = (t) => t.inserted + t.updated + t.deleted;

// Kept across runs: the per-system as-of map (record_as_of merges a system
// into it) and the pending systems (pending.js); both are only ever changed
// by their own per-system statements. fleet_today is kept unless the run's
// stats set it.
const WRITE_JOB_SQL = `INSERT INTO insight.job_state (job_name, watermark_id, last_run_id, last_run_started_at, last_run_finished_at, last_run_status, last_run_stats, updated_at)
     VALUES ($1, $2, $3, $4, now(), $5, $6::jsonb, now())
     ON CONFLICT (job_name) DO UPDATE SET watermark_id = EXCLUDED.watermark_id, last_run_id = EXCLUDED.last_run_id,
       last_run_started_at = EXCLUDED.last_run_started_at, last_run_finished_at = now(), last_run_status = EXCLUDED.last_run_status,
       last_run_stats = jsonb_strip_nulls(jsonb_build_object('fleet_today', job_state.last_run_stats -> 'fleet_today'))
         || (EXCLUDED.last_run_stats - 'as_of_by_system' - 'pending_systems')
         || jsonb_build_object('as_of_by_system', coalesce(job_state.last_run_stats -> 'as_of_by_system', '{}'::jsonb),
                               'pending_systems', coalesce(job_state.last_run_stats -> 'pending_systems', '{}'::jsonb)),
       updated_at = now()`;
async function write_job(t, { watermark_id, run_id, started_at, status, stats }) {
  await t.none(WRITE_JOB_SQL, [JOB, watermark_id, run_id, started_at, status, JSON.stringify(stats)]);
}

// Lock-free apply core: catalog, one transaction per system (findings +
// clear its pending mark), then job_state if write. On error: job_state
// 'error' with prev_watermark (if write), rethrow.
async function findings_apply_core(conn, { list, today, replay, write, watermark, prev_watermark, run_id, started_at, extra_stats = {}, log = () => {} }) {
  await conn.tx((t) => sync_catalog(t));
  const results = [];
  try {
    for (const s of list) {
      const r = await conn.tx(async (t) => {
        const out = await findings_system(t, s, { today, replay });
        await clear_findings_pending(t, s);
        return out;
      });
      results.push(r);
      if (r.evaluated) log(`  ${s}: ${r.rows.length} findings; +${r.inserted} ~${r.updated} -${r.deleted}${r.drift.length ? `; drift ${r.drift.length}` : ""} (committed)`);
    }
    const stats = { ...totals(results), today, replay, ...extra_stats };
    if (write) await conn.tx((t) => write_job(t, { watermark_id: watermark, run_id, started_at, status: "ok", stats }));
    return { stats, results };
  } catch (e) {
    const stats = { ...totals(results), today, replay, error: e.message, failed_after: results.map((r) => r.system_id) };
    if (write) await conn.tx((t) => write_job(t, { watermark_id: prev_watermark, run_id, started_at, status: "error", stats })).catch(() => {});
    throw e;
  }
}

// The stage's findings step (lock-free; the caller holds LOCK_KEY). Default
// mode only. force_daily: rehearsal only (time the daily pass).
async function findings_step(conn, { today, run_id, started_at = new Date(), force_daily = false, log = () => {} }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) throw new Error(`bad today ${today}`);
  const derive = await conn.oneOrNone("SELECT watermark_id FROM insight.job_state WHERE job_name = 'ge_ct_derive'");
  const prev = await conn.oneOrNone("SELECT watermark_id, last_run_stats FROM insight.job_state WHERE job_name = $1", [JOB]);
  const watermark = derive ? Number(derive.watermark_id) : 0;
  const prev_watermark = prev ? Number(prev.watermark_id) : 0;
  const prev_stats = (prev && prev.last_run_stats) || {};
  const prev_fleet = fleet_today_of(prev_stats);
  const daily = force_daily || daily_pass_due(prev_fleet, today);
  const pending = Object.keys(prev_stats.pending_systems || {}).sort();
  const list = daily ? [...new Set([...(await all_systems(conn)), ...pending])].sort() : pending;
  const r = await findings_apply_core(conn, { list, today, replay: false, write: true, watermark, prev_watermark, run_id, started_at,
    extra_stats: { mode: daily ? "daily" : "touched", systems_selected: daily ? "all" : list.length,
      ...(daily ? { fleet_today: today } : prev_fleet ? { fleet_today: prev_fleet } : {}) }, log });
  const { skipped_stale, ...t } = r.stats;
  return { from: prev_watermark, watermark, mode: daily ? "daily" : "touched", systems: list.length, skipped_stale: skipped_stale.length,
    drift_detail: r.results.flatMap((x) => x.drift).slice(0, 10), stats: t };
}

async function record_as_of(t, system_id, today) {
  await t.none(
    `INSERT INTO insight.job_state (job_name, watermark_id, last_run_stats, updated_at)
     VALUES ($1, 0, jsonb_build_object('as_of_by_system', $2::jsonb), now())
     ON CONFLICT (job_name) DO UPDATE SET
       last_run_stats = jsonb_set(coalesce(job_state.last_run_stats, '{}'::jsonb), '{as_of_by_system}',
                                  coalesce(job_state.last_run_stats -> 'as_of_by_system', '{}'::jsonb) || $2::jsonb),
       updated_at = now()`,
    [JOB, JSON.stringify({ [system_id]: today })]);
}

async function read_as_of(t) {
  const j = await t.oneOrNone("SELECT last_run_stats -> 'as_of_by_system' AS m FROM insight.job_state WHERE job_name = $1", [JOB]);
  return (j && j.m) || {};
}

async function run_findings(db, { mode, replay = false, systems = null, today, run_id, log = () => {} }) {
  if (!["rehearse", "apply"].includes(mode)) throw new Error(`bad mode ${mode}`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) throw new Error(`bad today ${today}`);
  const started_at = new Date();
  return db.task(async (conn) => {
    const { got } = await conn.one("SELECT pg_try_advisory_lock(hashtext($1)) AS got", [LOCK_KEY]);
    if (!got) return { skipped: "another insight run holds the lock" };
    try {
      const pre = await preflight(conn);
      const derive = await conn.oneOrNone("SELECT watermark_id FROM insight.job_state WHERE job_name = 'ge_ct_derive'");
      const watermark = derive ? Number(derive.watermark_id) : 0;
      const prevJob = await conn.oneOrNone("SELECT watermark_id FROM insight.job_state WHERE job_name = $1", [JOB]);
      const list = systems || (await all_systems(conn));
      log(`preflight: user=${pre.user} schema_version=${pre.schema_version}; derive watermark ${watermark}; ${list.length} systems; as of ${today}; ${replay ? "REPLAY (full history)" : "default (fresh systems, resolved history kept)"}`);

      const pass = async (t, label, opts) => {
        const results = [];
        const t0 = Date.now();
        for (const s of list) results.push(await findings_system(t, s, opts));
        const tt = totals(results);
        log(`  ${label} (as of ${opts.today}, ${opts.replay ? "replay" : "default"}, ${((Date.now() - t0) / 1000).toFixed(1)}s): ${tt.evaluated} evaluated, ${tt.skipped_stale.length} not evaluated (stale); findings ${tt.findings} (${tt.open} open); inserted ${tt.inserted}, updated ${tt.updated}, deleted ${tt.deleted}; drift ${tt.drift}`);
        for (const r of results) for (const d of r.drift.slice(0, 5)) log(`    drift: ${d}`);
        return { results, totals: tt };
      };

      if (mode === "rehearse") {
        return await conn.tx(async (t) => {
          const before = await t.one(COUNTS_SQL);
          log(`before (inside the transaction): ${JSON.stringify(before)}`);
          const cat = await sync_catalog(t);
          log(`catalog: ${cat.changed} rows inserted/updated${cat.extra.length ? `; not in the registry: ${cat.extra.join(", ")}` : ""}`);
          const p1 = await pass(t, "pass 1", { today, replay });
          const fp1 = await t.one(FINGERPRINT_SQL);
          const p2 = await pass(t, "pass 2 (same again)", { today, replay });
          const fp2 = await t.one(FINGERPRINT_SQL);
          const checks = { pass2_changes: changes(p2.totals), pass2_same: fp1.md5 === fp2.md5 };
          if (replay) {
            const p3 = await pass(t, "pass 3 (default after replay)", { today, replay: false });
            const fp3 = await t.one(FINGERPRINT_SQL);
            Object.assign(checks, { default_changes: changes(p3.totals), default_drift: p3.totals.drift, default_same: fp1.md5 === fp3.md5 });
          }
          // incremental consistency: what daily runs from today-28 would have built
          await t.none("DELETE FROM insight.findings WHERE source = 'ge_ct' AND system_id = ANY($1)", [list]);
          let drift = 0;
          for (const [i, off] of INCREMENTAL_STEPS.entries()) {
            const p = await pass(t, `incremental ${i + 1}/${INCREMENTAL_STEPS.length}`, { today: dstr(dnum(today) + off), replay: i === 0 });
            drift += p.totals.drift;
          }
          const fp4 = await t.one(FINGERPRINT_SQL);
          Object.assign(checks, { incremental_drift: drift, incremental_same: fp1.md5 === fp4.md5 });
          log(`checks: ${JSON.stringify(checks)}`);
          log("verify-findings on the rehearsed (uncommitted) rows:");
          const as_of_by_system = await read_as_of(t);
          const v = await run_verify(t, { today, as_of_by_system, log: (m) => log(`  ${m}`) });
          const ok = v.ok && !checks.pass2_changes && checks.pass2_same && (!replay || (!checks.default_changes && !checks.default_drift && checks.default_same))
            && !checks.incremental_drift && checks.incremental_same;
          const rows = p1.results.flatMap((r) => r.rows);
          throw Object.assign(new Error("ROLLBACK (rehearsal)"), { rehearsal: { before, pass1: p1.totals, checks, verify_ok: v.ok, ok, rows } });
        }).catch((e) => {
          if (e.rehearsal) return { rolled_back: true, ...e.rehearsal };
          throw e;
        });
      }

      // apply
      const r = await findings_apply_core(conn, { list, today, replay, write: !systems, watermark,
        prev_watermark: prevJob ? Number(prevJob.watermark_id) : 0, run_id, started_at,
        extra_stats: { systems_selected: systems ? systems.length : "all", ...(systems ? {} : { fleet_today: today }) }, log });
      return { stats: r.stats, after: await conn.one(COUNTS_SQL), rows: r.results.flatMap((x) => x.rows) };
    } finally {
      await conn.one("SELECT pg_advisory_unlock(hashtext($1)) AS ok", [LOCK_KEY]);
    }
  });
}

module.exports = {
  run_findings, findings_apply_core, findings_step, findings_system, all_systems, sync_catalog, read_as_of, totals, reconcile, resolved_final,
  JOB, COUNTS_SQL, FINGERPRINT_SQL, UPSERT_SUFFIX, WRITE_JOB_SQL, canon, row_canon,
};
