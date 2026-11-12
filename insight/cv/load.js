"use strict";
// GE CV write path for facts (PLAN-CV-INSIGHTS.md §4 CV-2, §7.4), the CV
// counterpart of insight/load.js.
//
// Runs ONLY as insight_writer. Its own advisory lock (CV and CT write
// different tables and different catalog / job_state rows). Per batch, one
// transaction: upsert facts + advance the ge_cv_extract watermark + record
// the touched device days for CV-3 derive (job_state 'ge_cv_derive'
// last_run_stats.pending), so a crash can never skip rows or lose a day.
//
// Upsert on ge_cv_facts_source_key (source row primary key + metric):
// DO UPDATE only when the rule version is higher, so a re-run of the same
// version changes nothing and a fixed rule (version bump) replaces its facts.
//
// Interlocks before --apply (plan §7.4):
//   C1  the three CT verifiers must ignore cv.* catalog rows: each module
//       exports CV_AWARE = true once that CT change is made;
//   C2  insight_writer must be able to SELECT log.ge_cv_syserror.
// The rehearsal (one transaction, rolled back) needs only C2.
//
// Nothing in the GE CT run loads this file.
const { pgp } = require("../db");
const { catalog_statement } = require("../load");
const { rules, MAX_FACTS_PER_ROW, validate } = require("./rules");
const { stream, build_facts, ROW_COLUMNS } = require("./extract");
const { REVIEWED_CODES } = require("./codes_reviewed");

const JOB = "ge_cv_extract";
const DERIVE_JOB = "ge_cv_derive";
const LOCK_KEY = "insight_ge_cv";
const MIN_SCHEMA_VERSION = 7;
const CHUNK = 5000;
const PENDING_FULL_DAYS = 31; // more pending days than this -> "full" rebuild of the system
// Late commits (as CT §15.2 item 3): rows at or below the watermark,
// captured within this of the watermark's capture time, with no facts yet.
const LATE_WINDOW_S = 2 * 3600;
const CT_VERIFIERS = ["../verify_facts", "../derive/verify", "../findings/verify"];

const toJsonb = (c) => (c.value === null || c.value === undefined ? null : JSON.stringify(c.value));
const FACT_CS = new pgp.helpers.ColumnSet(
  [
    "system_id", { name: "host_datetime", cast: "timestamptz" }, "sequencenumber", "metric_key",
    { name: "host_local", cast: "timestamp" }, "errorcode", "subsystem", "exceptioncategory", "dim",
    "value_num", "value_text", { name: "attrs", init: toJsonb, cast: "jsonb" },
    "source_id", { name: "source_capture_datetime", cast: "timestamptz" }, "rule_version",
  ],
  { table: new pgp.helpers.TableName({ table: "ge_cv_facts", schema: "insight" }) }
);
const UPSERT_SUFFIX = `
  ON CONFLICT ON CONSTRAINT ge_cv_facts_source_key DO UPDATE SET
    system_id = EXCLUDED.system_id, host_datetime = EXCLUDED.host_datetime, sequencenumber = EXCLUDED.sequencenumber,
    host_local = EXCLUDED.host_local, errorcode = EXCLUDED.errorcode, subsystem = EXCLUDED.subsystem,
    exceptioncategory = EXCLUDED.exceptioncategory, dim = EXCLUDED.dim, value_num = EXCLUDED.value_num,
    value_text = EXCLUDED.value_text, attrs = EXCLUDED.attrs, rule_version = EXCLUDED.rule_version, extracted_at = now()
  WHERE EXCLUDED.rule_version > ge_cv_facts.rule_version`;

// ---------------------------------------------------------------- pure

const source_key = (f) => [f.source_id, new Date(f.source_capture_datetime).toISOString(), f.metric_key].join("|");

// One INSERT ... ON CONFLICT DO UPDATE can't touch the same row twice.
function dedupe_facts(facts) {
  const seen = new Set();
  const unique = [];
  let collisions = 0;
  for (const f of facts) {
    const k = source_key(f);
    if (seen.has(k)) { collisions++; continue; }
    seen.add(k);
    unique.push(f);
  }
  return { unique, collisions };
}

// Each statement returns the touched (system_id, device day, n) of the facts
// it inserted or replaced; sum(n) is its row count.
const touched_cte = (insert_sql) => `
  WITH up AS (${insert_sql}
    RETURNING system_id, host_local)
  SELECT system_id, to_char(host_local, 'YYYY-MM-DD') AS day, count(*)::int AS n
  FROM up GROUP BY 1, 2 ORDER BY 1, 2`;

function upsert_statements(facts) {
  const out = [];
  for (let i = 0; i < facts.length; i += CHUNK) out.push(touched_cte(pgp.helpers.insert(facts.slice(i, i + CHUNK), FACT_CS) + UPSERT_SUFFIX));
  return out;
}

// Merge touched days into a pending map { system: [days] | "full" }.
function merge_pending(pending, touched) {
  const out = { ...(pending || {}) };
  for (const { system_id, day } of touched) {
    if (out[system_id] === "full") continue;
    const days = new Set(out[system_id] || []);
    days.add(day);
    out[system_id] = days.size > PENDING_FULL_DAYS ? "full" : [...days].sort();
  }
  return out;
}

const unreviewed = (codes) => [...codes].filter((c) => !REVIEWED_CODES.has(c)).sort((a, b) => a - b);

function new_stats(mode) {
  return { mode, rows: 0, facts: 0, upserted: 0, collisions: 0, batches: 0, ignored: {}, skipped: {}, rule_errors: 0, unreviewed_codes: [] };
}

function add_batch_stats(stats, rows, built, unique, upserted, collisions) {
  stats.batches++; stats.rows += rows.length; stats.facts += unique.length; stats.upserted += upserted;
  stats.collisions += collisions; stats.rule_errors += built.errors.length;
  for (const [k, v] of Object.entries(built.ignored)) stats.ignored[k] = (stats.ignored[k] || 0) + v;
  for (const [k, v] of Object.entries(built.skipped)) if (v) stats.skipped[k] = (stats.skipped[k] || 0) + v;
  stats.unreviewed_codes = [...new Set([...stats.unreviewed_codes, ...unreviewed(built.codes)])].sort((a, b) => a - b);
}

// ----------------------------------------------------------------- DB

// C1: every CT verifier module must declare it ignores cv.* catalog rows.
function ct_verifiers_not_cv_aware(load = require) {
  return CT_VERIFIERS.filter((m) => load(m).CV_AWARE !== true);
}

async function preflight(c, { mode }) {
  const who = await c.one(`SELECT current_user AS u, (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS su,
                                  has_table_privilege('log.ge_cv_syserror', 'SELECT') AS can_read`);
  if (who.u !== process.env.INSIGHT_PG_USER || who.su) throw new Error(`refusing: connected as ${who.u}, expected the limited ${process.env.INSIGHT_PG_USER}`);
  const v = await c.one("SELECT coalesce(max(version), 0) AS v FROM insight.schema_migrations");
  if (v.v < MIN_SCHEMA_VERSION) throw new Error(`insight schema version ${v.v} < ${MIN_SCHEMA_VERSION}: apply migration 007 first`);
  if (!who.can_read) throw new Error(`${who.u} has no SELECT on log.ge_cv_syserror (plan §7.4 C2): grant it first`);
  if (mode === "apply") {
    const missing = ct_verifiers_not_cv_aware();
    if (missing.length) throw new Error(`refusing --apply: CT verifiers not yet scoped to CT keys (plan §7.4 C1): ${missing.join(", ")}`);
  }
  return { user: who.u, schema_version: v.v };
}

async function read_job(c, job = JOB) {
  return c.oneOrNone("SELECT * FROM insight.job_state WHERE job_name = $1", [job]);
}

async function write_job(c, { watermark_id, watermark_capture_datetime, run_id, started_at, status, stats }) {
  await c.none(
    `INSERT INTO insight.job_state (job_name, watermark_id, watermark_capture_datetime, last_run_id, last_run_started_at,
                                    last_run_finished_at, last_run_status, last_run_stats, updated_at)
     VALUES ($1, $2, $3, $4, $5, now(), $6, $7::jsonb, now())
     ON CONFLICT (job_name) DO UPDATE SET watermark_id = EXCLUDED.watermark_id,
       watermark_capture_datetime = EXCLUDED.watermark_capture_datetime, last_run_id = EXCLUDED.last_run_id,
       last_run_started_at = EXCLUDED.last_run_started_at, last_run_finished_at = now(),
       last_run_status = EXCLUDED.last_run_status, last_run_stats = EXCLUDED.last_run_stats, updated_at = now()`,
    [JOB, watermark_id, watermark_capture_datetime, run_id, started_at, status, JSON.stringify(stats)]
  );
}

// Touched days for CV-3, in the same transaction as the facts. The derive
// row is created on first use; its own run fields stay NULL until CV-3.
async function record_derive_pending(t, touched) {
  if (!touched.length) return;
  await t.none(`INSERT INTO insight.job_state (job_name, last_run_stats) VALUES ($1, '{}'::jsonb) ON CONFLICT (job_name) DO NOTHING`, [DERIVE_JOB]);
  const row = await t.one("SELECT last_run_stats FROM insight.job_state WHERE job_name = $1 FOR UPDATE", [DERIVE_JOB]);
  const stats = row.last_run_stats || {};
  stats.pending = merge_pending(stats.pending, touched);
  await t.none("UPDATE insight.job_state SET last_run_stats = $2::jsonb, updated_at = now() WHERE job_name = $1", [DERIVE_JOB, JSON.stringify(stats)]);
}

async function upsert_and_record(t, facts) {
  const touched = [];
  for (const q of upsert_statements(facts)) touched.push(...(await t.any(q)));
  await record_derive_pending(t, touched);
  return { upserted: touched.reduce((n, r) => n + r.n, 0), touched };
}

async function process_batch(t, { rows, built }, stats) {
  if (built.facts.length > rows.length * MAX_FACTS_PER_ROW) {
    throw new Error(`runaway guard: ${built.facts.length} facts from ${rows.length} rows (> ${MAX_FACTS_PER_ROW}/row)`);
  }
  if (built.errors.length) throw new Error(`rule errors in batch: ${JSON.stringify(built.errors.slice(0, 3))}`);
  const { unique, collisions } = dedupe_facts(built.facts);
  const { upserted } = await upsert_and_record(t, unique);
  add_batch_stats(stats, rows, built, unique, upserted, collisions);
  return { last_capture: rows[rows.length - 1].capture_datetime };
}

const LATE_SQL = `
  SELECT ${ROW_COLUMNS}
  FROM log.ge_cv_syserror g
  WHERE g.id <= $1 AND g.capture_datetime >= $2::timestamptz - make_interval(secs => $3)
    AND NOT EXISTS (SELECT 1 FROM insight.ge_cv_facts f WHERE f.source_id = g.id AND f.source_capture_datetime = g.capture_datetime)
  ORDER BY g.id`;

// Late-commit re-read: rows below the watermark that have no facts yet
// (relays are re-read too and give none). One transaction.
async function reread_late(conn, { job }) {
  const out = { rows: 0, facts: 0, inserted: 0, systems: [] };
  if (!job || !job.watermark_capture_datetime) return { ...out, skipped: "no watermark capture time" };
  const rows = await conn.any(LATE_SQL, [job.watermark_id, job.watermark_capture_datetime, LATE_WINDOW_S]);
  out.rows = rows.length;
  if (!rows.length) return out;
  const built = build_facts(rows);
  if (built.errors.length) throw new Error(`rule errors in late re-read: ${JSON.stringify(built.errors.slice(0, 3))}`);
  const { unique } = dedupe_facts(built.facts);
  out.facts = unique.length;
  if (!unique.length) return out;
  const r = await conn.tx((t) => upsert_and_record(t, unique));
  out.inserted = r.upserted;
  out.systems = [...new Set(r.touched.map((x) => x.system_id))].sort();
  return out;
}

// mode "rehearse": everything in ONE transaction, rolled back; verify runs
//                  on the uncommitted facts (verify(t, end) -> result).
// mode "apply":    one transaction per batch, watermark advanced with the facts.
async function run_extract(db, { mode, from_id = null, to_id = null, max_batches = null, run_id = null, verify = null, log = () => {}, check = validate }) {
  if (!["rehearse", "apply"].includes(mode)) throw new Error(`bad mode ${mode}`);
  // Before any connection or write: an invalid registry must never reach the shared catalog (review CV2-EXTRACT P2).
  const invalid = check();
  if (invalid.length) throw new Error(`invalid CV rule registry, nothing written: ${invalid.join("; ")}`);
  const started_at = new Date();
  const stats = new_stats(mode);
  return db.task(async (conn) => {
    const { got } = await conn.one("SELECT pg_try_advisory_lock(hashtext($1)) AS got", [LOCK_KEY]);
    if (!got) return { skipped: "another GE CV insight run holds the lock", stats };
    try {
      const pre = await preflight(conn, { mode });
      const job = await read_job(conn);
      const start = from_id ?? (job ? Number(job.watermark_id) : 0);
      const end = to_id ?? Number((await conn.one("SELECT coalesce(max(id), 0) AS m FROM log.ge_cv_syserror")).m);
      if (mode === "apply" && from_id !== null && from_id > (job ? Number(job.watermark_id) : 0)) {
        throw new Error(`--from-id ${from_id} is beyond the watermark ${job ? job.watermark_id : 0}: that would leave a gap`);
      }
      log(`preflight: user=${pre.user} schema_version=${pre.schema_version}; range id ${start}..${end} (watermark ${job ? job.watermark_id : "none"})`);

      if (mode === "rehearse") {
        return await conn.tx(async (t) => {
          await t.none(catalog_statement(rules));
          let n = 0;
          const STOP = new Error("rehearsal batch limit");
          try {
            await stream(t, { from_id: start, to_id: end, on_batch: async (b) => {
              await process_batch(t, b, stats);
              if (max_batches && ++n >= max_batches) throw STOP;
            } });
          } catch (e) { if (e !== STOP) throw e; }
          const again = { upserted: 0 };
          if (!max_batches) { // idempotency: a second full pass inserts nothing
            await stream(t, { from_id: start, to_id: end, on_batch: async ({ built }) => {
              again.upserted += (await upsert_and_record(t, dedupe_facts(built.facts).unique)).upserted;
            } });
          }
          const verified = verify && !max_batches && start === 0 ? await verify(t, end) : null;
          const pending = await read_job(t, DERIVE_JOB);
          throw Object.assign(new Error("ROLLBACK (rehearsal)"), {
            rehearsal: { stats, second_pass_upserted: again.upserted, verified, pending: pending && pending.last_run_stats.pending, preflight: pre, end },
          });
        }).catch((e) => {
          if (e.rehearsal) return { rolled_back: true, ...e.rehearsal };
          throw e;
        });
      }

      // apply
      const { watermark } = await apply_range(conn, { job, start, end, max_batches, run_id, started_at, stats, log });
      return { watermark, stats, preflight: pre, end };
    } finally {
      await conn.one("SELECT pg_advisory_unlock(hashtext($1)) AS ok", [LOCK_KEY]);
    }
  });
}

// ------------------------------------------------- lock-free cores (CV-5)
// The caller holds LOCK_KEY: run_extract above (the CLI) or the CV stage
// (stage.js, plan §12.2). Neither takes the lock nor runs a preflight.

// The apply path: catalog sync, the late-commit re-read, then batches from
// start to end (at most max_batches), each one transaction with its
// watermark and touched days. stats is filled in place.
async function apply_range(conn, { job, start, end, max_batches = null, run_id, started_at, stats, log = () => {} }) {
  await conn.tx((t) => t.none(catalog_statement(rules)));
  stats.late = await reread_late(conn, { job });
  let watermark = start;
  let watermark_capture = job ? job.watermark_capture_datetime : null;
  let n = 0;
  const STOP = new Error("batch limit");
  try {
    await stream(conn, { from_id: start, to_id: end, on_batch: async (b) => {
      // counts and watermark stay local until COMMIT succeeded (as CT review PHASE5-STAGE F1)
      const next = JSON.parse(JSON.stringify(stats));
      const r = await conn.tx(async (t) => {
        const out = await process_batch(t, b, next);
        await write_job(t, { watermark_id: b.last_id, watermark_capture_datetime: out.last_capture, run_id, started_at, status: "ok", stats: next });
        return out;
      });
      Object.assign(stats, next);
      watermark = b.last_id;
      watermark_capture = r.last_capture;
      log(`  batch ${stats.batches}: watermark ${watermark}, ${stats.rows} rows, ${stats.facts} facts`);
      if (max_batches && ++n >= max_batches) throw STOP;
    } });
  } catch (e) {
    if (e !== STOP) {
      stats.error = e.message;
      await conn.tx((t) => write_job(t, { watermark_id: watermark, watermark_capture_datetime: watermark_capture, run_id, started_at, status: "error", stats })).catch(() => {});
      throw e;
    }
  }
  return { watermark, watermark_capture };
}

// The stage's extract (plan §12.2 item 2.1): from the watermark, at most
// max_batches (default 1, §12.3 Q4) up to to_id (default: the current max
// id). Needs an existing watermark (the backfill made it).
async function extract_step(conn, { run_id, started_at = new Date(), max_batches = 1, to_id = null, log = () => {} }) {
  const invalid = validate();
  if (invalid.length) throw new Error(`invalid CV rule registry, nothing written: ${invalid.join("; ")}`);
  const job = await read_job(conn);
  if (!job) throw new Error("no ge_cv_extract watermark: run `cv/cli.js backfill --apply` first");
  const from = Number(job.watermark_id);
  const max_id = Number((await conn.one("SELECT coalesce(max(id), 0) AS m FROM log.ge_cv_syserror")).m);
  const end = to_id ?? max_id;
  const stats = new_stats("stage");
  const { watermark } = await apply_range(conn, { job, start: from, end, max_batches, run_id, started_at, stats, log });
  return { from, watermark, end, behind_ids: Math.max(0, max_id - watermark), stats };
}

module.exports = {
  run_extract, apply_range, extract_step, reread_late, write_job, dedupe_facts, upsert_statements, merge_pending, source_key, preflight, ct_verifiers_not_cv_aware,
  read_job, unreviewed, JOB, DERIVE_JOB, LOCK_KEY, CHUNK, FACT_CS, LATE_SQL, LATE_WINDOW_S, PENDING_FULL_DAYS, MIN_SCHEMA_VERSION,
};
