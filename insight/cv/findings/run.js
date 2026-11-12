"use strict";
// Running the GE CV findings (PLAN-CV-INSIGHTS.md §10.4), the CV
// counterpart of insight/findings/run.js, with the same semantics:
//
// Runs ONLY as insight_writer, under the CV advisory lock shared with the
// CV extract and derive (../load.js LOCK_KEY).
//
// Every run recomputes each selected system's findings from its whole
// history (CT's pure fold, insight/findings/state.js, over the CV rules)
// and reconciles that system's source 'ge_cv' rows of insight.findings:
//   --replay : the table becomes exactly the replay (insert / update /
//              delete, resolved history included). All systems.
//   default  : only systems with data in the last 7 device days are
//              evaluated; open rows and resolved rows whose resolve day is
//              still inside that window follow the replay; older resolved
//              rows are never changed, a difference there is drift (CT's
//              reconcile / resolved_final, reused).
// An update happens only when a column differs, so a re-run changes nothing.
// Rows of other sources are never read, changed or deleted.
//
//   rehearse: ONE transaction, rolled back: pass 1 (the chosen mode); pass 2
//             (same again: must change nothing); after a replay, a default
//             pass (must change nothing, no drift); incremental consistency
//             (replay as of today-28, then default runs at today-21, -14,
//             -7, today: must end identical to pass 1, with no drift);
//             verify-findings on the uncommitted rows; ROLLBACK.
//   apply   : CV catalog sync, one transaction per system, then
//             insight.job_state 'ge_cv_findings' (fleet-wide runs only;
//             on success watermark_id = the ge_cv_derive watermark the run
//             covered, CV-5 plan §12.2 item 4).
//
// Interlocks:
//   - derive must be caught up: a successful derive run on record, no
//     pending days, no owed code labels, and the device days with facts
//     equal the days in ge_cv_daily (review CV4-FINDINGS P2: a missing
//     derive state must fail, not pass with no systems);
//   - --apply needs migration 008 (plan §10.5 C3: the ge_ct view filtered
//     by source, api.ge_cv_findings_v) and the C1 CT verifier change
//     (CT's findings verifier would otherwise count the cv_* catalog rows).
//
// Nothing in the GE CT run loads this file.
const { pgp } = require("../../db");
const { reconcile, totals, UPSERT_SUFFIX } = require("../../findings/run");
const { replay_system } = require("../../findings/state");
const { LOCK_KEY, DERIVE_JOB, ct_verifiers_not_cv_aware } = require("../load");
const { load_inputs } = require("./load");
const { build_context, dnum, dstr } = require("./context");
const { cv_finding_rules, cv_catalog_rows, validate_cv_finding_rules, KEY_PREFIX } = require("./rules");
const { run_verify, inventory_lines, INVENTORY_SQL, SOURCE } = require("./verify");

const JOB = "ge_cv_findings";
const MIN_SCHEMA_VERSION = 7;       // ge_cv_daily (rehearse)
const MIN_SCHEMA_VERSION_APPLY = 8; // + 008: findings views split by source (C3)
const STALE_DAYS = 7;
const INCREMENTAL_STEPS = [-28, -21, -14, -7, 0];

const FINDINGS_CS = new pgp.helpers.ColumnSet([
  "system_id", "finding_key", { name: "opened_at", cast: "timestamptz" }, "source", "status", "severity",
  { name: "window_start", cast: "timestamptz" }, { name: "window_end", cast: "timestamptz" }, "observed", "baseline",
  { name: "evidence", cast: "jsonb", init: (c) => JSON.stringify(c.value) }, "rule_version",
  { name: "last_evaluated", cast: "timestamptz" }, { name: "resolved_at", cast: "timestamptz" }, { name: "data_through", cast: "date" },
], { table: new pgp.helpers.TableName({ table: "findings", schema: "insight" }) });

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

const FINGERPRINT_SQL = `SELECT count(*)::int AS n, md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) AS md5
  FROM (SELECT system_id, finding_key, opened_at, source, status, severity, window_start, window_end, observed, baseline, evidence,
               rule_version, last_evaluated, resolved_at, data_through FROM insight.findings WHERE source = 'ge_cv') x`;
// Everything that is not CV: must be the same before and after a CV run.
const OTHERS_SQL = `SELECT
  (SELECT md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) FROM (SELECT * FROM insight.findings WHERE source <> 'ge_cv') x) AS findings,
  (SELECT md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) FROM (SELECT * FROM insight.finding_catalog WHERE left(finding_key, 3) <> 'cv_') x) AS catalog`;
const COUNTS_SQL = `SELECT (SELECT count(*) FROM insight.findings WHERE source = 'ge_cv')::int AS findings,
  (SELECT count(*) FROM insight.findings WHERE source = 'ge_cv' AND status = 'open')::int AS open,
  (SELECT count(*) FROM insight.finding_catalog WHERE left(finding_key, 3) = 'cv_')::int AS catalog`;
const STORED_SQL = `SELECT finding_key, opened_at, source, status, severity, window_start, window_end, observed, baseline, evidence,
  rule_version, last_evaluated, resolved_at, to_char(data_through, 'YYYY-MM-DD') AS data_through
  FROM insight.findings WHERE system_id = $1 AND source = 'ge_cv'`;
const SYSTEMS_SQL = "SELECT system_id FROM insight.ge_cv_facts UNION SELECT system_id FROM insight.ge_cv_daily ORDER BY 1";

const keyOf = (r) => `${r.finding_key}|${new Date(r.opened_at).toISOString()}`;

// CT's fold writes source 'ge_ct'; every CV row is relabelled here, and
// anything else is refused.
function as_cv_rows(rows) {
  return rows.map((r) => {
    if (!r.finding_key.startsWith(KEY_PREFIX)) throw new Error(`not a CV finding key: ${r.finding_key}`);
    return { ...r, source: SOURCE };
  });
}

async function preflight(t, { mode }) {
  const errs = validate_cv_finding_rules();
  if (errs.length) throw new Error(`invalid CV finding rules: ${errs.join("; ")}`);
  const who = await t.one("SELECT current_user AS u, (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS su");
  if (who.u !== process.env.INSIGHT_PG_USER || who.su) throw new Error(`refusing: connected as ${who.u}, expected the limited ${process.env.INSIGHT_PG_USER}`);
  const v = await t.one("SELECT coalesce(max(version), 0) AS v FROM insight.schema_migrations");
  const need = mode === "apply" ? MIN_SCHEMA_VERSION_APPLY : MIN_SCHEMA_VERSION;
  if (v.v < need) throw new Error(`insight schema version ${v.v} < ${need}: apply migration ${String(need).padStart(3, "0")} first${mode === "apply" ? " (plan §10.5 C3)" : ""}`);
  const d = await t.oneOrNone("SELECT last_run_status AS s, last_run_stats -> 'pending' AS p, last_run_stats -> 'codes_pending' AS c FROM insight.job_state WHERE job_name = $1", [DERIVE_JOB]);
  if (!d || d.s !== "ok") throw new Error(`GE CV derive has no successful run on record (status: ${d ? d.s : "no job state"}): run \`cv/cli.js derive --apply\` first`);
  const pending = d.p ? Object.keys(d.p) : [];
  if (pending.length || d.c === true) {
    throw new Error(`GE CV derive is not caught up (pending: ${pending.join(", ") || "none"}; code labels owed: ${d.c === true}): run \`cv/cli.js derive --apply\` first`);
  }
  const inv = await t.any(INVENTORY_SQL);
  if (inv.length) throw new Error(`GE CV facts and ge_cv_daily disagree (run \`cv/cli.js derive --apply --full\`): ${inventory_lines(inv).join("; ")}`);
  if (mode === "apply") {
    const missing = ct_verifiers_not_cv_aware();
    if (missing.length) throw new Error(`refusing --apply: CT verifiers not yet scoped to CT keys (plan §7.4 C1): ${missing.join(", ")}`);
  }
  return { user: who.u, schema_version: v.v };
}

async function sync_catalog(t) {
  const n = (await t.result(pgp.helpers.insert(cv_catalog_rows(), CATALOG_CS) + CATALOG_SUFFIX)).rowCount;
  const extra = (await t.any("SELECT finding_key FROM insight.finding_catalog WHERE left(finding_key, 3) = 'cv_' AND finding_key <> ALL($1)",
    [cv_finding_rules.map((r) => r.key)])).map((r) => r.finding_key);
  return { changed: n, extra };
}

async function all_systems(t) {
  return (await t.any(SYSTEMS_SQL)).map((r) => r.system_id);
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

// Kept across runs: the per-system as-of map (record_as_of merges into it).
// watermark_id: set only when given (a successful fleet-wide run).
const WRITE_JOB_SQL = `INSERT INTO insight.job_state (job_name, watermark_id, last_run_id, last_run_started_at, last_run_finished_at, last_run_status, last_run_stats, updated_at)
     VALUES ($1, coalesce($6::bigint, 0), $2, $3, now(), $4, $5::jsonb, now())
     ON CONFLICT (job_name) DO UPDATE SET watermark_id = coalesce($6::bigint, job_state.watermark_id), last_run_id = EXCLUDED.last_run_id,
       last_run_started_at = EXCLUDED.last_run_started_at, last_run_finished_at = now(), last_run_status = EXCLUDED.last_run_status,
       last_run_stats = (EXCLUDED.last_run_stats - 'as_of_by_system')
         || jsonb_build_object('as_of_by_system', coalesce(job_state.last_run_stats -> 'as_of_by_system', '{}'::jsonb)),
       updated_at = now()`;
async function write_job(t, { run_id, started_at, status, stats, watermark_id = null }) {
  await t.none(WRITE_JOB_SQL, [JOB, run_id, started_at, status, JSON.stringify(stats), watermark_id]);
}

// One system: compute, then reconcile its ge_cv rows. Returns counts and the rows.
async function findings_system(t, system_id, { today, replay }) {
  const ctx = build_context(await load_inputs(t, system_id), today);
  const last = ctx.days.length ? ctx.days[ctx.days.length - 1].day : null;
  const out = { system_id, last_day: last, evaluated: true, inserted: 0, updated: 0, deleted: 0, unchanged: 0, drift: [], rows: [] };
  if (!replay && (!last || dnum(last) < dnum(today) - (STALE_DAYS - 1))) { out.evaluated = false; return out; }
  const rows = as_cv_rows(replay_system(ctx, cv_finding_rules));
  out.rows = rows;
  await record_as_of(t, system_id, today);
  const stored = new Map((await t.any(STORED_SQL, [system_id])).map((r) => [keyOf(r), r]));
  const want = new Map(rows.map((r) => [keyOf(r), r]));

  const { del, ups, drift } = reconcile(system_id, stored, want, { replay, last_day: last });
  out.drift = drift;
  for (const s of del) {
    await t.none("DELETE FROM insight.findings WHERE system_id = $1 AND finding_key = $2 AND opened_at = $3 AND source = 'ge_cv'",
      [system_id, s.finding_key, s.opened_at]);
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

const changes = (t) => t.inserted + t.updated + t.deleted;

async function run_findings(db, { mode, replay = false, systems = null, today, run_id = null, log = () => {} }) {
  if (!["rehearse", "apply"].includes(mode)) throw new Error(`bad mode ${mode}`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) throw new Error(`bad today ${today}`);
  const started_at = new Date();
  return db.task(async (conn) => {
    const { got } = await conn.one("SELECT pg_try_advisory_lock(hashtext($1)) AS got", [LOCK_KEY]);
    if (!got) return { skipped: "another GE CV insight run holds the lock" };
    try {
      const pre = await preflight(conn, { mode });
      const list = systems || (await all_systems(conn));
      log(`preflight: user=${pre.user} schema_version=${pre.schema_version}; ${list.length} systems (${list.join(", ")}); as of ${today}; ${replay ? "REPLAY (full history)" : "default (fresh systems, resolved history kept)"}`);

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
          const others_before = await t.one(OTHERS_SQL);
          log(`before (inside the transaction): ${JSON.stringify(before)}`);
          const cat = await sync_catalog(t);
          log(`catalog (cv_*): ${cat.changed} rows inserted/updated${cat.extra.length ? `; not in the registry: ${cat.extra.join(", ")}` : ""}`);
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
          await t.none("DELETE FROM insight.findings WHERE source = 'ge_cv' AND system_id = ANY($1)", [list]);
          let drift = 0;
          for (const [i, off] of INCREMENTAL_STEPS.entries()) {
            const p = await pass(t, `incremental ${i + 1}/${INCREMENTAL_STEPS.length}`, { today: dstr(dnum(today) + off), replay: i === 0 });
            drift += p.totals.drift;
          }
          const fp4 = await t.one(FINGERPRINT_SQL);
          const others_after = await t.one(OTHERS_SQL);
          Object.assign(checks, { incremental_drift: drift, incremental_same: fp1.md5 === fp4.md5,
            others_unchanged: JSON.stringify(others_before) === JSON.stringify(others_after) });
          log(`checks: ${JSON.stringify(checks)}`);
          log("verify-findings on the rehearsed (uncommitted) rows:");
          const v = await run_verify(t, { today, as_of_by_system: await read_as_of(t), log: (m) => log(`  ${m}`) });
          const ok = v.ok && !checks.pass2_changes && checks.pass2_same && (!replay || (!checks.default_changes && !checks.default_drift && checks.default_same))
            && !checks.incremental_drift && checks.incremental_same && checks.others_unchanged;
          const rows = p1.results.flatMap((r) => r.rows);
          throw Object.assign(new Error("ROLLBACK (rehearsal)"), { rehearsal: { before, pass1: p1.totals, checks, verify_ok: v.ok, ok, rows } });
        }).catch((e) => {
          if (e.rehearsal) return { rolled_back: true, ...e.rehearsal };
          throw e;
        });
      }

      // apply
      const r = await findings_step(conn, { replay, systems, list, today, run_id, started_at, log });
      return { stats: r.stats, after: r.after, rows: r.rows };
    } finally {
      await conn.one("SELECT pg_advisory_unlock(hashtext($1)) AS ok", [LOCK_KEY]);
    }
  });
}

// ------------------------------------------------- lock-free core (CV-5)
// The caller holds LOCK_KEY and has run preflight(conn, { mode: "apply" }):
// run_findings above (the CLI) or the CV stage (stage.js, plan §12.2).
//
// The cv_* catalog, one transaction per system, then (fleet-wide runs
// only) the job state. The derive watermark is read first: derive can't run
// meanwhile (same lock), and preflight has checked it is caught up.
// systems: the selection (null = all); list: the systems to run (default:
// the selection, or all).
async function findings_step(conn, { replay = false, systems = null, list = null, today, run_id = null, started_at = new Date(), log = () => {} }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) throw new Error(`bad today ${today}`);
  const d = await conn.oneOrNone("SELECT watermark_id FROM insight.job_state WHERE job_name = $1", [DERIVE_JOB]);
  const through = d ? Number(d.watermark_id) : null;
  const run_list = list || systems || (await all_systems(conn));
  await conn.tx((t) => sync_catalog(t));
  const results = [];
  try {
    for (const s of run_list) {
      const r = await conn.tx((t) => findings_system(t, s, { today, replay }));
      results.push(r);
      if (r.evaluated) log(`  ${s}: ${r.rows.length} findings; +${r.inserted} ~${r.updated} -${r.deleted}${r.drift.length ? `; drift ${r.drift.length}` : ""} (committed)`);
      for (const d of r.drift.slice(0, 5)) log(`    drift: ${d}`); // review CV5-CORES P3
    }
    const stats = { ...totals(results), today, replay, systems_selected: systems ? systems.length : "all" };
    if (!systems) await conn.tx((t) => write_job(t, { run_id, started_at, status: "ok", stats, watermark_id: through }));
    return { stats, watermark: systems ? null : through, after: await conn.one(COUNTS_SQL), rows: results.flatMap((x) => x.rows),
      drift_detail: results.flatMap((x) => x.drift).slice(0, 10) };
  } catch (e) {
    const stats = { ...totals(results), today, replay, error: e.message, failed_after: results.map((r) => r.system_id) };
    if (!systems) await conn.tx((t) => write_job(t, { run_id, started_at, status: "error", stats })).catch(() => {});
    throw e;
  }
}

module.exports = {
  run_findings, findings_step, write_job, findings_system, preflight, sync_catalog, all_systems, read_as_of, as_cv_rows,
  JOB, WRITE_JOB_SQL, COUNTS_SQL, FINGERPRINT_SQL, OTHERS_SQL, MIN_SCHEMA_VERSION, MIN_SCHEMA_VERSION_APPLY, STALE_DAYS,
};
