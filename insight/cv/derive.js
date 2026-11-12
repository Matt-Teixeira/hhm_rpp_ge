"use strict";
// GE CV derive (PLAN-CV-INSIGHTS.md §4 CV-3, §9): insight.ge_cv_daily and
// insight.ge_cv_codes from insight.ge_cv_facts. Capabilities is a view
// (api.ge_cv_capabilities_v), so there is nothing to derive for it.
//
// Runs ONLY as insight_writer, under the CV advisory lock shared with the
// extract (load.js LOCK_KEY), so a derive never overlaps a backfill.
//
//   daily: per system, either "full" (delete + rebuild every row of the
//          system) or the device days recorded by the extract in
//          job_state 'ge_cv_derive'.last_run_stats.pending (delete +
//          rebuild those days). Each system is one transaction that also
//          clears its pending days, so a failed run is redone by the next.
//   codes: rebuilt in full (one row per error code of the cv.error facts;
//          about 200 rows). label = the code's most common readable debug
//          text template (numbers and hex masked), from the source rows
//          behind the facts. Internal wording, not a decoding of GE's
//          encoded fields (which are never read).
//
//   rehearse: ONE transaction, rolled back: full rebuild, a second
//             identical pass (contents must be byte-identical), a
//             touched-days pass over each system's last TOUCHED_CHECK_DAYS
//             days (must reproduce the full rebuild), verify on the
//             uncommitted rows.
//   apply   : the pending scope (or --full), codes, then the job's
//             last_run_* fields (the pending map is kept) and, on success,
//             watermark_id = the ge_cv_extract watermark this run covered
//             (CV-5, plan §12.2 item 4: read under the lock, so every row up
//             to it had its days recorded and now derived).
//
// Nothing in the GE CT run loads this file.
const { LOCK_KEY, DERIVE_JOB, JOB: EXTRACT_JOB, MIN_SCHEMA_VERSION } = require("./load");

const LABEL_VERSION = 1;
const LABEL_MAX = 200;
const TOUCHED_CHECK_DAYS = 7;
const PH = "\u0001";

// ---------------------------------------------------------------- pure

// Labels are built from ASCII only: every non-ASCII character (one per
// code point, as PostgreSQL counts characters) becomes '?', so \b, \s and
// the 200-character cut mean the same in JS and in the SQL check
// (review CV3-DERIVE P3). GE's debug text is ASCII today.
const ascii = (d) => String(d ?? "").replace(/[^\x00-\x7F]/gu, "?");

// Debug text -> template: leading quote / dash / space and trailing quote /
// space trimmed; 0x-hex, hex tokens with a digit (4B10, FEC28000) and
// numbers masked as '#'; spaces collapsed. verify_derive.js rebuilds this
// in SQL independently.
function template(d) {
  let s = ascii(d);
  s = s.replace(/^[\s"-]+/, "").replace(/[\s"]+$/, "");
  s = s.replace(/0x[0-9a-fA-F]+/g, PH);
  s = s.replace(/\b(?=[0-9A-F]*[0-9])[0-9A-F]{2,8}\b/g, "#");
  s = s.replace(/-?[0-9]+(\.[0-9]+)?/g, "#");
  s = s.replace(/\s+/g, " ");
  return s.split(PH).join("0x#").slice(0, LABEL_MAX);
}
const readable = (d) => typeof d === "string" && !/^\s*"?\s*-?\s*\(null\)/.test(ascii(d)) && /[A-Za-z]{3}/.test(d);

// Most frequent value; ties -> the smallest in code-unit order (= SQL COLLATE "C").
function mode(counts) {
  let best = null;
  for (const [v, n] of counts) if (best === null || n > best[1] || (n === best[1] && v < best[0])) best = [v, n];
  return best;
}
const bump = (m, k) => { if (k !== null && k !== undefined) m.set(k, (m.get(k) || 0) + 1); };

// rows: { errorcode, system_id, host_datetime, subsystem, sourcefile, debugtext } (one per cv.error fact)
function build_codes(rows) {
  const by = new Map();
  for (const r of rows) {
    let c = by.get(r.errorcode);
    if (!c) by.set(r.errorcode, (c = { n: 0, systems: new Set(), first: null, last: null, sub: new Map(), sf: new Map(), tpl: new Map() }));
    c.n++;
    c.systems.add(r.system_id);
    const t = new Date(r.host_datetime);
    if (!c.first || t < c.first) c.first = t;
    if (!c.last || t > c.last) c.last = t;
    bump(c.sub, r.subsystem);
    bump(c.sf, r.sourcefile);
    if (readable(r.debugtext)) bump(c.tpl, template(r.debugtext));
  }
  return [...by].sort((a, b) => a[0] - b[0]).map(([errorcode, c]) => {
    const label = mode(c.tpl);
    const sf = mode(c.sf);
    return {
      errorcode, subsystem: mode(c.sub)[0], label: label ? label[0] : null, label_share: label ? label[1] / c.n : null,
      sourcefile: sf ? sf[0] : null, n: c.n, systems: c.systems.size, first_seen: c.first, last_seen: c.last, rule_version: LABEL_VERSION,
    };
  });
}

// ----------------------------------------------------------------- SQL

const DAILY_SELECT = `
  SELECT f.system_id, f.host_local::date AS local_day, f.metric_key, f.dim, count(*) AS n,
         sum(f.value_num) AS value_sum, min(f.value_num) AS value_min, max(f.value_num) AS value_max,
         (array_agg(f.value_num ORDER BY f.host_datetime DESC, f.id DESC))[1] AS value_last,
         min(f.host_datetime) AS first_at, max(f.host_datetime) AS last_at
  FROM insight.ge_cv_facts f`;
const DAILY_COLS = "system_id, local_day, metric_key, dim, n, value_sum, value_min, value_max, value_last, first_at, last_at";

const DAILY_FULL = [
  "DELETE FROM insight.ge_cv_daily WHERE system_id = $1",
  `INSERT INTO insight.ge_cv_daily (${DAILY_COLS}) ${DAILY_SELECT} WHERE f.system_id = $1 GROUP BY 1, 2, 3, 4`,
];
// Days as a range join, so the (system_id, host_local) index is used.
const DAILY_DAYS = [
  "DELETE FROM insight.ge_cv_daily WHERE system_id = $1 AND local_day = ANY($2::date[])",
  `INSERT INTO insight.ge_cv_daily (${DAILY_COLS}) ${DAILY_SELECT}
   JOIN unnest($2::date[]) AS d(day) ON f.host_local >= d.day AND f.host_local < d.day + 1
   WHERE f.system_id = $1 GROUP BY 1, 2, 3, 4`,
];

// LEFT JOIN: a fact whose source row is gone (log retention) still counts; its text is unknown.
const CODES_ROWS_SQL = `
  SELECT f.errorcode, f.system_id, f.host_datetime, f.subsystem, f.attrs->>'sourcefile' AS sourcefile, s.debugtext
  FROM insight.ge_cv_facts f
  LEFT JOIN log.ge_cv_syserror s ON s.id = f.source_id AND s.capture_datetime = f.source_capture_datetime
  WHERE f.metric_key = 'cv.error'`;

const SYSTEMS_SQL = `SELECT system_id FROM insight.ge_cv_facts UNION SELECT system_id FROM insight.ge_cv_daily ORDER BY 1`;

// Content fingerprint (updated_at excluded).
const FINGERPRINT_SQL = `SELECT
  (SELECT md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) FROM (SELECT ${DAILY_COLS} FROM insight.ge_cv_daily) x) AS daily,
  (SELECT md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) FROM (SELECT errorcode, subsystem, label, label_share, sourcefile, n, systems, first_seen, last_seen, rule_version FROM insight.ge_cv_codes) x) AS codes,
  (SELECT count(*) FROM insight.ge_cv_daily)::int AS daily_rows,
  (SELECT count(*) FROM insight.ge_cv_codes)::int AS code_rows`;

// ----------------------------------------------------------------- DB

async function preflight(c) {
  const who = await c.one(`SELECT current_user AS u, (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS su,
                                  has_table_privilege('log.ge_cv_syserror', 'SELECT') AS can_read`);
  if (who.u !== process.env.INSIGHT_PG_USER || who.su) throw new Error(`refusing: connected as ${who.u}, expected the limited ${process.env.INSIGHT_PG_USER}`);
  const v = await c.one("SELECT coalesce(max(version), 0) AS v FROM insight.schema_migrations");
  if (v.v < MIN_SCHEMA_VERSION) throw new Error(`insight schema version ${v.v} < ${MIN_SCHEMA_VERSION}: apply migration 007 first`);
  if (!who.can_read) throw new Error(`${who.u} has no SELECT on log.ge_cv_syserror (plan §7.4 C2): grant it first`);
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
  const codes = build_codes(await t.any(CODES_ROWS_SQL));
  await t.none("DELETE FROM insight.ge_cv_codes");
  if (codes.length) {
    const cs = new pgp.helpers.ColumnSet(["errorcode", "subsystem", "label", "label_share", "sourcefile", "n", "systems",
      { name: "first_seen", cast: "timestamptz" }, { name: "last_seen", cast: "timestamptz" }, "rule_version"],
    { table: new pgp.helpers.TableName({ table: "ge_cv_codes", schema: "insight" }) });
    await t.none(pgp.helpers.insert(codes.map((c) => ({ ...c, first_seen: c.first_seen.toISOString(), last_seen: c.last_seen.toISOString() })), cs));
  }
  return { codes: codes.length, unlabeled: codes.filter((c) => !c.label).length };
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

// One system: derive its scope and clear its pending entry, in one transaction.
async function derive_system_tx(conn, system_id, { full }) {
  return conn.tx(async (t) => {
    const pending = await read_pending(t, { lock: true });
    const scope = full ? "full" : pending[system_id];
    if (!scope) return { system_id, scope: "none" };
    const r = await derive_daily(t, system_id, scope);
    // Clear the system's days and, in the same transaction, mark the code
    // labels as owed: they are cleared only when rebuild_codes commits, so a
    // run that stops in between is finished by the next one (review CV3-DERIVE P2).
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

// ------------------------------------------------- lock-free core (CV-5)
// The caller holds LOCK_KEY: run_derive below (the CLI) or the CV stage
// (stage.js, plan §12.2). No lock and no preflight here.
//
// The pending days (or every system with full), one transaction per system,
// then the code labels if owed, then the job's last run. The extract
// watermark is read first: the extract can't run meanwhile (same lock), so
// once every pending system is derived, derive covers it.
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
    if (!got) return { skipped: "another GE CV insight run holds the lock" };
    try {
      const pre = await preflight(conn);
      const systems = (await conn.any(SYSTEMS_SQL)).map((r) => r.system_id);
      log(`preflight: user=${pre.user} schema_version=${pre.schema_version}; systems ${systems.join(", ") || "none"}`);

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
            const days = (await t.any(`SELECT DISTINCT local_day::text AS d FROM insight.ge_cv_daily WHERE system_id = $1 ORDER BY 1 DESC LIMIT $2`, [s, TOUCHED_CHECK_DAYS])).map((r) => r.d);
            if (!days.length) continue;
            await t.none("DELETE FROM insight.ge_cv_daily WHERE system_id = $1 AND local_day = ANY($2::date[])", [s, days]);
            touched.push(await derive_daily(t, s, days));
          }
          const p3 = await t.one(FINGERPRINT_SQL);
          const verified = verify ? await verify(t) : null;
          throw Object.assign(new Error("ROLLBACK (rehearsal)"), { rehearsal: {
            systems, pending_before, first: { daily: p1.daily, codes: p1.codes, fp: p1.fp },
            second_pass_identical: JSON.stringify(p1.fp) === JSON.stringify(p2.fp),
            touched_days_identical: JSON.stringify(p1.fp) === JSON.stringify(p3), touched, verified, preflight: pre,
          } });
        }).catch((e) => {
          if (e.rehearsal) return { rolled_back: true, ...e.rehearsal };
          throw e;
        });
      }

      // apply
      const r = await derive_step(conn, pgp, { full, run_id, started_at, rebuild });
      return { stats: r.stats, preflight: pre, pending_after: r.pending_after };
    } finally {
      await conn.one("SELECT pg_advisory_unlock(hashtext($1)) AS ok", [LOCK_KEY]);
    }
  });
}

module.exports = {
  run_derive, derive_step, write_last_run, derive_daily, rebuild_codes, build_codes, template, readable, ascii, mode, read_pending, codes_owed,
  DAILY_FULL, DAILY_DAYS, CODES_ROWS_SQL, FINGERPRINT_SQL, SYSTEMS_SQL, LABEL_VERSION, LABEL_MAX, TOUCHED_CHECK_DAYS,
};
