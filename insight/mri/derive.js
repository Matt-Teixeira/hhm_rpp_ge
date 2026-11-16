"use strict";
// GE MRI derive (PLAN-MRI-INSIGHTS.md §4 MRI-3, §8): insight.ge_mri_daily
// and insight.ge_mri_codes from insight.ge_mri_facts, modelled on
// insight/cv/derive.js. Capabilities, inventory, sessions and the
// restart mark on process deaths are queries (derived_sql.js), not tables.
//
// Runs ONLY as insight_writer, under the MRI advisory lock shared with the
// extract (load.js LOCK_KEY), so a derive never overlaps a backfill.
//
//   daily: per system, either "full" (delete + rebuild every row of the
//          system) or the device days recorded by the extract in
//          job_state 'ge_mri_derive'.last_run_stats.pending (delete +
//          rebuild those days). Each system is one transaction that also
//          clears its pending days and marks the codes as owed
//          (codes_pending), so a failed run is redone by the next.
//          first_at / last_at are device wall-clock times (host_local).
//   codes: rebuilt in full (one row per message code of the mri.error
//          facts; about 830 rows): n, systems, first / last seen (device
//          time), the most common process, the reviewed category
//          (codes_reviewed.js; NULL for the long tail and new codes), and
//          the label = the most common masked template (labels.js) with
//          its share, from the source rows behind the facts. Labels are
//          stored ONLY for the reviewed (categorized) codes, whose
//          templates were read in MRI-2a; a long-tail or new code gets no
//          label until a review categorizes it, so unread source text is
//          never stored (review MRI3-DERIVE P2-2).
//
//   rehearse: ONE transaction, rolled back: full rebuild, a second
//             identical pass, a touched-days pass over each system's last
//             TOUCHED_CHECK_DAYS days (must reproduce the full rebuild),
//             verify on the uncommitted rows.
//   apply   : the pending scope (or --full), codes if owed, then the job's
//             last_run_* fields and, on success, watermark_id = the
//             ge_mri_extract watermark this run covered.
//
// Nothing in the GE CT or CV run loads this file.
const { LOCK_KEY, DERIVE_JOB, JOB: EXTRACT_JOB, MIN_SCHEMA_VERSION } = require("./load");
const { CODE_CATEGORY } = require("./codes_reviewed");
const { template, host_regex, LABEL_VERSION } = require("./labels");

const TOUCHED_CHECK_DAYS = 7;

// ---------------------------------------------------------------- pure

// Most frequent value; ties -> the smallest in code-unit order (= SQL COLLATE "C").
function mode(counts) {
  let best = null;
  for (const [v, n] of counts) if (best === null || n > best[1] || (n === best[1] && v < best[0])) best = [v, n];
  return best;
}
const bump = (m, k) => { if (k !== null && k !== undefined) m.set(k, (m.get(k) || 0) + 1); };

// rows: { message_number, system_id, host_local, proc, message } (one per
// mri.error fact); hosts: every host name seen in the source.
function build_codes(rows, hosts, category = CODE_CATEGORY) {
  const re = host_regex(hosts);
  const by = new Map();
  for (const r of rows) {
    let c = by.get(r.message_number);
    if (!c) by.set(r.message_number, (c = { n: 0, systems: new Set(), first: null, last: null, proc: new Map(), tpl: new Map() }));
    c.n++;
    c.systems.add(r.system_id);
    const t = String(r.host_local);
    if (c.first === null || t < c.first) c.first = t;
    if (c.last === null || t > c.last) c.last = t;
    bump(c.proc, r.proc);
    const tp = template(r.message, re);
    if (tp) bump(c.tpl, tp);
  }
  return [...by].sort((a, b) => a[0] - b[0]).map(([message_number, c]) => {
    const cat = category.get(message_number) ?? null;
    const label = cat === null ? null : mode(c.tpl); // review MRI3-DERIVE P2-2: no label for an unreviewed code
    const proc = mode(c.proc);
    return {
      message_number, process: proc ? proc[0] : "", category: cat,
      label: label ? label[0] : null, label_share: label ? label[1] / c.n : null,
      n: c.n, systems: c.systems.size, first_seen: c.first, last_seen: c.last, rule_version: LABEL_VERSION,
    };
  });
}

// ----------------------------------------------------------------- SQL

const DAILY_SELECT = `
  SELECT f.system_id, f.host_local::date AS local_day, f.metric_key, f.dim, count(*) AS n,
         sum(f.value_num) AS value_sum, min(f.value_num) AS value_min, max(f.value_num) AS value_max,
         (array_agg(f.value_num ORDER BY f.host_local DESC, f.record_number_concurrent DESC, f.id DESC))[1] AS value_last,
         min(f.host_local) AS first_at, max(f.host_local) AS last_at
  FROM insight.ge_mri_facts f`;
const DAILY_COLS = "system_id, local_day, metric_key, dim, n, value_sum, value_min, value_max, value_last, first_at, last_at";

const DAILY_FULL = [
  "DELETE FROM insight.ge_mri_daily WHERE system_id = $1",
  `INSERT INTO insight.ge_mri_daily (${DAILY_COLS}) ${DAILY_SELECT} WHERE f.system_id = $1 GROUP BY 1, 2, 3, 4`,
];
// Days as a range join, so the (system_id, metric_key, host_local) index and partition pruning apply.
const DAILY_DAYS = [
  "DELETE FROM insight.ge_mri_daily WHERE system_id = $1 AND local_day = ANY($2::date[])",
  `INSERT INTO insight.ge_mri_daily (${DAILY_COLS}) ${DAILY_SELECT}
   JOIN unnest($2::date[]) AS d(day) ON f.host_local >= d.day AND f.host_local < d.day + 1
   WHERE f.system_id = $1 GROUP BY 1, 2, 3, 4`,
];

// LEFT JOIN: a fact whose source row is gone (log retention) still counts; its text is unknown.
const CODES_ROWS_SQL = `
  SELECT f.message_number, f.system_id, to_char(f.host_local, 'YYYY-MM-DD"T"HH24:MI:SS') AS host_local, f.attrs->>'proc' AS proc, s.message
  FROM insight.ge_mri_facts f
  LEFT JOIN log.ge_mri_gesys s ON s.id = f.source_id AND s.capture_datetime = f.source_capture_datetime
  WHERE f.metric_key = 'mri.error'`;
const HOSTS_SQL = `SELECT DISTINCT split_part(type, E'\\t', 1) AS host FROM log.ge_mri_gesys WHERE type LIKE E'%\\t%'`;

const SYSTEMS_SQL = `SELECT system_id FROM insight.ge_mri_facts UNION SELECT system_id FROM insight.ge_mri_daily ORDER BY 1`;

// Content fingerprint (updated_at excluded).
const CODES_COLS = "message_number, process, category, label, label_share, n, systems, first_seen, last_seen, rule_version";
const FINGERPRINT_SQL = `SELECT
  (SELECT md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) FROM (SELECT ${DAILY_COLS} FROM insight.ge_mri_daily) x) AS daily,
  (SELECT md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) FROM (SELECT ${CODES_COLS} FROM insight.ge_mri_codes) x) AS codes,
  (SELECT count(*) FROM insight.ge_mri_daily)::int AS daily_rows,
  (SELECT count(*) FROM insight.ge_mri_codes)::int AS code_rows`;

// ----------------------------------------------------------------- DB

async function preflight(c) {
  const who = await c.one(`SELECT current_user AS u, (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS su,
                                  CASE WHEN has_schema_privilege('log', 'USAGE') THEN has_table_privilege('log.ge_mri_gesys', 'SELECT') ELSE false END AS can_read`);
  if (who.u !== process.env.INSIGHT_PG_USER || who.su) throw new Error(`refusing: connected as ${who.u}, expected the limited ${process.env.INSIGHT_PG_USER}`);
  const v = await c.one("SELECT coalesce(max(version), 0) AS v FROM insight.schema_migrations");
  if (v.v < MIN_SCHEMA_VERSION) throw new Error(`insight schema version ${v.v} < ${MIN_SCHEMA_VERSION}: apply migration 009 first`);
  if (!who.can_read) throw new Error(`${who.u} has no SELECT on log.ge_mri_gesys (plan §6.4 C2-MRI): grant it first`);
  return { user: who.u, schema_version: v.v };
}

async function derive_daily(t, system_id, scope) {
  const [del, ins] = scope === "full" ? DAILY_FULL : DAILY_DAYS;
  const p = scope === "full" ? [system_id] : [system_id, scope];
  const deleted = (await t.result(del, p)).rowCount;
  const inserted = (await t.result(ins, p)).rowCount;
  return { system_id, scope: scope === "full" ? "full" : scope.length, deleted, inserted };
}

async function rebuild_codes(t, pgp) {
  const hosts = (await t.any(HOSTS_SQL)).map((r) => r.host);
  const codes = build_codes(await t.any(CODES_ROWS_SQL), hosts);
  await t.none("DELETE FROM insight.ge_mri_codes");
  if (codes.length) {
    const cs = new pgp.helpers.ColumnSet(["message_number", "process", "category", "label", "label_share", "n", "systems",
      { name: "first_seen", cast: "timestamp" }, { name: "last_seen", cast: "timestamp" }, "rule_version"],
    { table: new pgp.helpers.TableName({ table: "ge_mri_codes", schema: "insight" }) });
    for (let i = 0; i < codes.length; i += 1000) await t.none(pgp.helpers.insert(codes.slice(i, i + 1000), cs));
  }
  return { codes: codes.length, unlabeled: codes.filter((c) => !c.label).length, uncategorized: codes.filter((c) => !c.category).length };
}

async function codes_owed(t) {
  const row = await t.oneOrNone("SELECT last_run_stats->'codes_pending' AS c FROM insight.job_state WHERE job_name = $1", [DERIVE_JOB]);
  return !!(row && row.c === true);
}

// The code rebuild and the clearing of its marker, in one transaction.
async function rebuild_codes_tx(conn, pgp, rebuild = rebuild_codes) {
  return conn.tx(async (t) => {
    const r = await rebuild(t, pgp);
    await t.none(`UPDATE insight.job_state SET last_run_stats = last_run_stats - 'codes_pending', updated_at = now() WHERE job_name = $1`, [DERIVE_JOB]);
    return r;
  });
}

async function read_pending(t, { lock = false } = {}) {
  const row = await t.oneOrNone(`SELECT last_run_stats FROM insight.job_state WHERE job_name = $1${lock ? " FOR UPDATE" : ""}`, [DERIVE_JOB]);
  return (row && row.last_run_stats && row.last_run_stats.pending) || {};
}

// One system: derive its scope, clear its pending entry and mark the codes
// as owed, in one transaction (as CV review CV3-DERIVE P2).
async function derive_system_tx(conn, system_id, { full }) {
  return conn.tx(async (t) => {
    const pending = await read_pending(t, { lock: true });
    const scope = full ? "full" : pending[system_id];
    if (!scope) return { system_id, scope: "none" };
    const r = await derive_daily(t, system_id, scope);
    await t.none(
      `INSERT INTO insight.job_state (job_name, last_run_stats) VALUES ($1, '{}'::jsonb) ON CONFLICT (job_name) DO NOTHING;
       UPDATE insight.job_state SET last_run_stats = jsonb_set(coalesce(last_run_stats, '{}'::jsonb) #- ARRAY['pending', $2::text], '{codes_pending}', 'true'),
              updated_at = now() WHERE job_name = $1`, [DERIVE_JOB, system_id]);
    return r;
  });
}

// watermark_id: set only on success (null keeps the old one).
async function write_last_run(c, { run_id, started_at, status, stats, watermark_id = null }) {
  await c.none(
    `INSERT INTO insight.job_state (job_name, last_run_stats) VALUES ($1, '{}'::jsonb) ON CONFLICT (job_name) DO NOTHING;
     UPDATE insight.job_state SET last_run_id = $2, last_run_started_at = $3, last_run_finished_at = now(), last_run_status = $4,
            last_run_stats = coalesce(last_run_stats, '{}'::jsonb) || jsonb_build_object('last', $5::jsonb),
            watermark_id = coalesce($6::bigint, watermark_id), updated_at = now()
     WHERE job_name = $1`,
    [DERIVE_JOB, run_id, started_at, status, JSON.stringify(stats), watermark_id]
  );
}

// Lock-free core (the caller holds LOCK_KEY: run_derive, or MRI-5's stage).
async function derive_step(conn, pgp, { full = false, run_id = null, started_at = new Date(), rebuild = rebuild_codes }) {
  const ex = await conn.oneOrNone("SELECT watermark_id FROM insight.job_state WHERE job_name = $1", [EXTRACT_JOB]);
  const through = ex ? Number(ex.watermark_id) : null;
  const pending = await read_pending(conn);
  const scope = full ? (await conn.any(SYSTEMS_SQL)).map((r) => r.system_id) : Object.keys(pending).sort();
  const daily = [];
  try {
    for (const s of scope) daily.push(await derive_system_tx(conn, s, { full }));
    const owed = scope.length > 0 || (await codes_owed(conn));
    const codes = owed ? await rebuild_codes_tx(conn, pgp, rebuild) : { skipped: "nothing pending" };
    const stats = { full, systems: scope.length, daily, codes };
    await conn.tx((t) => write_last_run(t, { run_id, started_at, status: "ok", stats, watermark_id: through }));
    return { stats, watermark: through, pending_after: await read_pending(conn) };
  } catch (e) {
    await conn.tx((t) => write_last_run(t, { run_id, started_at, status: "error", stats: { full, daily, error: e.message } })).catch(() => {});
    throw e;
  }
}

async function run_derive(db, pgp, { mode, full = false, run_id = null, verify = null, log = () => {}, rebuild = rebuild_codes }) {
  if (!["rehearse", "apply"].includes(mode)) throw new Error(`bad mode ${mode}`);
  const started_at = new Date();
  return db.task(async (conn) => {
    const { got } = await conn.one("SELECT pg_try_advisory_lock(hashtext($1)) AS got", [LOCK_KEY]);
    if (!got) return { skipped: "another GE MRI insight run holds the lock" };
    try {
      const pre = await preflight(conn);
      const systems = (await conn.any(SYSTEMS_SQL)).map((r) => r.system_id);
      log(`preflight: user=${pre.user} schema_version=${pre.schema_version}; ${systems.length} systems`);

      if (mode === "rehearse") {
        return await conn.tx(async (t) => {
          const pending_before = await read_pending(t);
          const pass = async () => {
            const daily = [];
            for (const s of systems) daily.push(await derive_daily(t, s, "full"));
            const codes = await rebuild_codes(t, pgp);
            return { daily, codes, fp: await t.one(FINGERPRINT_SQL) };
          };
          const p1 = await pass();
          const p2 = await pass();
          // touched-days path: each system's last N days, deleted and rebuilt by day, must equal the full rebuild
          const touched = [];
          for (const s of systems) {
            const days = (await t.any(`SELECT DISTINCT local_day::text AS d FROM insight.ge_mri_daily WHERE system_id = $1 ORDER BY 1 DESC LIMIT $2`, [s, TOUCHED_CHECK_DAYS])).map((r) => r.d);
            if (!days.length) continue;
            await t.none("DELETE FROM insight.ge_mri_daily WHERE system_id = $1 AND local_day = ANY($2::date[])", [s, days]);
            touched.push(await derive_daily(t, s, days));
          }
          const p3 = await t.one(FINGERPRINT_SQL);
          const verified = verify ? await verify(t) : null;
          throw Object.assign(new Error("ROLLBACK (rehearsal)"), { rehearsal: {
            systems, pending_systems_before: Object.keys(pending_before).length, first: { codes: p1.codes, fp: p1.fp },
            daily_rows_by_system: Object.fromEntries(p1.daily.map((d) => [d.system_id, d.inserted])),
            second_pass_identical: JSON.stringify(p1.fp) === JSON.stringify(p2.fp),
            touched_days_identical: JSON.stringify(p1.fp) === JSON.stringify(p3), verified, preflight: pre,
          } });
        }).catch((e) => {
          if (e.rehearsal) return { rolled_back: true, ...e.rehearsal };
          throw e;
        });
      }

      const r = await derive_step(conn, pgp, { full, run_id, started_at, rebuild });
      return { stats: r.stats, preflight: pre, pending_after: r.pending_after };
    } finally {
      await conn.one("SELECT pg_advisory_unlock(hashtext($1)) AS ok", [LOCK_KEY]);
    }
  });
}

module.exports = {
  run_derive, derive_step, write_last_run, derive_daily, rebuild_codes, rebuild_codes_tx, build_codes, mode, read_pending, codes_owed,
  DAILY_FULL, DAILY_DAYS, DAILY_COLS, CODES_ROWS_SQL, HOSTS_SQL, FINGERPRINT_SQL, SYSTEMS_SQL, TOUCHED_CHECK_DAYS,
};
