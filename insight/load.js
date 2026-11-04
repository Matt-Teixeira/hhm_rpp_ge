"use strict";
// Write path for facts (PLAN-CT-INSIGHTS.md §6, §10, §12).
//
// Runs ONLY as insight_writer (db.connect("writer")). One shared advisory
// lock with the ge_ct stage (insight/index.js), so a backfill and the stage
// never overlap. Per batch, one transaction: upsert facts + advance the
// watermark + record the touched days for derive (pending.js), so a crash
// can never skip rows or lose a touched day.
//
//   run_extract  : the CLI (backfill). Takes the lock itself.
//   extract_step : the stage's step (lock-free; the stage holds the lock):
//                  the late-commit re-read, then at most one new batch.
//
// Upsert: ON CONFLICT (natural key) DO UPDATE ... WHERE the new rule
// version is higher. A re-run of the same version changes nothing; a fixed
// rule (version bump) replaces its old facts.
const { pgp } = require("./db");
const { catalog_rows } = require("./rules/engine");
const { stream, build_facts, ROW_COLUMNS } = require("./extract");
const { touched_cte, record_derive_pending } = require("./pending");

const JOB = "ge_ct_extract";
const LOCK_KEY = "insight_ge_ct"; // shared with the Phase 5 stage
const MIN_SCHEMA_VERSION = 3;
const CHUNK = 5000;               // rows per INSERT statement
const MAX_FACTS_PER_ROW = 3;      // runaway-rule guard (normal ~0.73)
const PARTITION_WARN_MONTHS = 6;
// Late commits (§15.2 item 3, §15.3 Q2): rows at or below the watermark
// whose capture time is within this of the watermark's, and that have no
// facts yet, are read again on every stage run. An overlapping ge_ct run can
// commit rows with ids below a watermark another run already passed.
const LATE_WINDOW_S = 2 * 3600;

const FACTS_TABLE = new pgp.helpers.TableName({ table: "ge_ct_facts", schema: "insight" });
const toJsonb = (c) => (c.value === null || c.value === undefined ? null : JSON.stringify(c.value));
const FACT_CS = new pgp.helpers.ColumnSet(
  [
    "system_id", "epoch", "record_number_concurrent", "metric_key", "host_datetime",
    { name: "host_local", cast: "timestamp" },
    "value_num", "value_text", "exam_no",
    { name: "attrs", init: toJsonb, cast: "jsonb" }, // SQL NULL, not JSON null, when absent
    "source_id", "source_capture_datetime", "rule_version",
  ],
  { table: FACTS_TABLE }
);
const UPSERT_SUFFIX = `
  ON CONFLICT ON CONSTRAINT ge_ct_facts_natural_key DO UPDATE SET
    host_local = EXCLUDED.host_local, value_num = EXCLUDED.value_num, value_text = EXCLUDED.value_text,
    exam_no = EXCLUDED.exam_no, attrs = EXCLUDED.attrs, source_id = EXCLUDED.source_id,
    source_capture_datetime = EXCLUDED.source_capture_datetime, rule_version = EXCLUDED.rule_version,
    extracted_at = now()
  WHERE EXCLUDED.rule_version > ge_ct_facts.rule_version`;

const CATALOG_CS = new pgp.helpers.ColumnSet(
  ["metric_key", "label", "unit", "category", "value_kind", "description", "customer_visible", "model_specific", "rule_version"],
  { table: new pgp.helpers.TableName({ table: "metric_catalog", schema: "insight" }) }
);
const CATALOG_SUFFIX = `
  ON CONFLICT (metric_key) DO UPDATE SET
    label = EXCLUDED.label, unit = EXCLUDED.unit, category = EXCLUDED.category, value_kind = EXCLUDED.value_kind,
    description = EXCLUDED.description, customer_visible = EXCLUDED.customer_visible,
    model_specific = EXCLUDED.model_specific, rule_version = EXCLUDED.rule_version, updated_at = now()
  WHERE (metric_catalog.label, metric_catalog.unit, metric_catalog.category, metric_catalog.value_kind,
         metric_catalog.description, metric_catalog.customer_visible, metric_catalog.model_specific, metric_catalog.rule_version)
    IS DISTINCT FROM
        (EXCLUDED.label, EXCLUDED.unit, EXCLUDED.category, EXCLUDED.value_kind,
         EXCLUDED.description, EXCLUDED.customer_visible, EXCLUDED.model_specific, EXCLUDED.rule_version)`;

// ---------------------------------------------------------------- pure

const natural_key = (f) =>
  [f.system_id, f.epoch, f.record_number_concurrent, f.metric_key, new Date(f.host_datetime).toISOString()].join("|");

// One INSERT ... ON CONFLICT DO UPDATE can't touch the same row twice, so
// keep the first occurrence (lowest source id; batches are id-ordered).
function dedupe_facts(facts) {
  const seen = new Set();
  const unique = [];
  let collisions = 0;
  for (const f of facts) {
    const k = natural_key(f);
    if (seen.has(k)) { collisions++; continue; }
    seen.add(k);
    unique.push(f);
  }
  return { unique, collisions };
}

// Each statement returns the touched (system_id, day, offset_breaks, n) of
// the facts it inserted or replaced (pending.js touched_cte); sum(n) is the
// statement's row count.
function upsert_statements(facts) {
  const out = [];
  for (let i = 0; i < facts.length; i += CHUNK) {
    out.push(touched_cte(pgp.helpers.insert(facts.slice(i, i + CHUNK), FACT_CS) + UPSERT_SUFFIX));
  }
  return out;
}

// Runs the upserts on t; returns { upserted, touched } and records the
// touched days for derive in the same transaction.
async function upsert_and_record(t, facts) {
  const touched = [];
  for (const q of upsert_statements(facts)) touched.push(...(await t.any(q)));
  await record_derive_pending(t, touched);
  return { upserted: touched.reduce((n, r) => n + r.n, 0), touched };
}

// Rows at or below the watermark, captured within LATE_WINDOW_S of the
// watermark's capture time, that produced no facts (index on source_id).
const LATE_SQL = `
  SELECT ${ROW_COLUMNS}
  FROM log.ge_ct_gesys g
  WHERE g.id <= $1 AND g.capture_datetime >= $2::timestamptz - make_interval(secs => $3)
    AND NOT EXISTS (SELECT 1 FROM insight.ge_ct_facts f WHERE f.source_id = g.id)
  ORDER BY g.id`;

function catalog_statement(rules) {
  return pgp.helpers.insert(catalog_rows(rules), CATALOG_CS) + CATALOG_SUFFIX;
}

// ----------------------------------------------------------------- DB

async function preflight(c) {
  const who = await c.one("SELECT current_user AS u, (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS su");
  if (who.u !== process.env.INSIGHT_PG_USER || who.su) throw new Error(`refusing: connected as ${who.u}, expected the limited ${process.env.INSIGHT_PG_USER}`);
  const v = await c.one("SELECT coalesce(max(version), 0) AS v FROM insight.schema_migrations");
  if (v.v < MIN_SCHEMA_VERSION) throw new Error(`insight schema version ${v.v} < ${MIN_SCHEMA_VERSION}: apply migrations first`);
  const p = await c.one(`SELECT max(c.relname) AS last FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
                         WHERE i.inhparent = 'insight.ge_ct_facts'::regclass`);
  const m = /_(\d{4})_(\d{2})$/.exec(p.last || "");
  const now = new Date();
  const monthsLeft = m ? (Number(m[1]) - now.getUTCFullYear()) * 12 + (Number(m[2]) - (now.getUTCMonth() + 1)) : -1;
  return { user: who.u, schema_version: v.v, last_partition: p.last, months_left: monthsLeft, partition_warning: monthsLeft < PARTITION_WARN_MONTHS };
}

async function read_job(c) {
  return c.oneOrNone("SELECT * FROM insight.job_state WHERE job_name = $1", [JOB]);
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

function new_stats(mode) {
  return { mode, rows: 0, facts: 0, upserted: 0, collisions: 0, batches: 0, skipped: {}, rule_errors: 0 };
}

// One batch on transaction c: runaway guard, dedupe, upsert, record touched days.
async function process_batch(c, { rows, built, last_id }, stats) {
  if (built.facts.length > rows.length * MAX_FACTS_PER_ROW) {
    throw new Error(`runaway guard: ${built.facts.length} facts from ${rows.length} rows (> ${MAX_FACTS_PER_ROW}/row)`);
  }
  const { unique, collisions } = dedupe_facts(built.facts);
  const { upserted } = await upsert_and_record(c, unique);
  stats.batches++; stats.rows += rows.length; stats.facts += unique.length; stats.upserted += upserted;
  stats.collisions += collisions; stats.rule_errors += built.errors.length;
  for (const [k, v] of Object.entries(built.skipped)) stats.skipped[k] = (stats.skipped[k] || 0) + v;
  const last = rows[rows.length - 1];
  return { last_id, last_capture: last.capture_datetime };
}

// Lock-free apply core: one transaction per batch (facts + watermark +
// touched days), from `start` to `end`, at most max_batches (null = all).
// On error the failed batch rolls back and the last committed watermark is
// recorded with status 'error'.
async function apply_batches(conn, { rules, start, end, max_batches = null, job, run_id, started_at, stats, log = () => {} }) {
  let watermark = start;
  let watermark_capture = job ? job.watermark_capture_datetime : null;
  let n = 0;
  const STOP = new Error("batch limit");
  try {
    await stream(conn, { from_id: start, to_id: end, rules, on_batch: async (b) => {
      // The batch's counts and watermark are kept local until COMMIT has
      // succeeded: if the commit fails, the error row below must record the
      // last COMMITTED watermark, never this batch's (review PHASE5-STAGE F1).
      const next = JSON.parse(JSON.stringify(stats));
      const r = await conn.tx(async (t) => {
        const out = await process_batch(t, b, next);
        await write_job(t, { watermark_id: out.last_id, watermark_capture_datetime: out.last_capture, run_id, started_at, status: "ok", stats: next });
        return out;
      });
      Object.assign(stats, next);
      watermark = r.last_id;
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

// Late-commit re-read (lock-free). One transaction: the upserts and the
// touched days. A late-committed row's facts are inserted (n > 0); every
// other re-read row either produces no facts or only existing ones (no-op).
async function reread_late(conn, { rules, job }) {
  const out = { rows: 0, facts: 0, inserted: 0, systems: [], rule_errors: 0 };
  if (!job || !job.watermark_capture_datetime) return { ...out, skipped: "no watermark capture time" };
  const rows = await conn.any(LATE_SQL, [job.watermark_id, job.watermark_capture_datetime, LATE_WINDOW_S]);
  out.rows = rows.length;
  if (!rows.length) return out;
  const built = build_facts(rows, rules);
  out.rule_errors = built.errors.length;
  if (built.facts.length > rows.length * MAX_FACTS_PER_ROW) {
    throw new Error(`runaway guard (late re-read): ${built.facts.length} facts from ${rows.length} rows (> ${MAX_FACTS_PER_ROW}/row)`);
  }
  const { unique } = dedupe_facts(built.facts);
  out.facts = unique.length;
  if (!unique.length) return out;
  const r = await conn.tx((t) => upsert_and_record(t, unique));
  out.inserted = r.upserted;
  out.systems = [...new Set(r.touched.map((x) => x.system_id))].sort();
  return out;
}

// mode "rehearse": everything in ONE transaction, rolled back (max_batches).
// mode "apply": one transaction per batch, watermark advanced with the facts.
async function run_extract(db, { rules, mode, from_id = null, to_id = null, max_batches = null, run_id, log = () => {} }) {
  if (!["rehearse", "apply"].includes(mode)) throw new Error(`bad mode ${mode}`);
  const started_at = new Date();
  const stats = new_stats(mode);
  return db.task(async (conn) => {
    const { got } = await conn.one("SELECT pg_try_advisory_lock(hashtext($1)) AS got", [LOCK_KEY]);
    if (!got) return { skipped: "another insight run holds the lock", stats };
    try {
      const pre = await preflight(conn);
      log(`preflight: user=${pre.user} schema_version=${pre.schema_version} last_partition=${pre.last_partition} (${pre.months_left} months left)${pre.partition_warning ? " WARNING: add partitions" : ""}`);
      const job = await read_job(conn);
      const start = from_id ?? (job ? Number(job.watermark_id) : 0);
      const end = to_id ?? Number((await conn.one("SELECT max(id) AS m FROM log.ge_ct_gesys")).m);
      if (mode === "apply" && from_id !== null && job && from_id > Number(job.watermark_id)) {
        throw new Error(`--from-id ${from_id} is beyond the watermark ${job.watermark_id}: that would leave a gap`);
      }
      log(`range: id ${start}..${end} (watermark ${job ? job.watermark_id : "none"})`);

      if (mode === "rehearse") {
        return await conn.tx(async (t) => {
          await t.none(catalog_statement(rules));
          let n = 0;
          const STOP = new Error("rehearsal batch limit");
          try {
            await stream(t, { from_id: start, to_id: end, rules, on_batch: async (b) => {
              await process_batch(t, b, stats);
              if (max_batches && ++n >= max_batches) throw STOP;
            } });
          } catch (e) { if (e !== STOP) throw e; }
          const check = await t.one(`SELECT (SELECT count(*) FROM insight.ge_ct_facts)::int AS facts_visible,
                                            (SELECT count(*) FROM insight.metric_catalog)::int AS catalog_rows`);
          log(`rehearsal inside transaction: ${JSON.stringify({ ...stats, ...check })}`);
          throw Object.assign(new Error("ROLLBACK (rehearsal)"), { rehearsal: { stats, check, preflight: pre } });
        }).catch((e) => {
          if (e.rehearsal) return { rolled_back: true, ...e.rehearsal };
          throw e;
        });
      }

      // apply
      await conn.tx((t) => t.none(catalog_statement(rules)));
      const { watermark } = await apply_batches(conn, { rules, start, end, job, run_id, started_at, stats, log });
      return { watermark, stats, preflight: pre };
    } finally {
      await conn.one("SELECT pg_advisory_unlock(hashtext($1)) AS ok", [LOCK_KEY]);
    }
  });
}

// The stage's extract step (lock-free; the caller holds LOCK_KEY): catalog
// sync, the late-commit re-read, then at most max_batches new batches from
// the watermark (§15.3 Q5: one 50k batch per run; a backlog is caught up
// over several runs). to_id: rehearsal only (cap the range).
async function extract_step(conn, { rules, run_id, started_at = new Date(), max_batches = 1, to_id = null, log = () => {} }) {
  const job = await read_job(conn);
  if (!job) throw new Error("no ge_ct_extract watermark: run `cli.js backfill --apply` first");
  const from = Number(job.watermark_id);
  await conn.tx((t) => t.none(catalog_statement(rules)));
  const late = await reread_late(conn, { rules, job });
  const max_id = Number((await conn.one("SELECT max(id) AS m FROM log.ge_ct_gesys")).m);
  const end = to_id ?? max_id;
  const stats = { ...new_stats("stage"), late };
  const { watermark } = await apply_batches(conn, { rules, start: from, end, max_batches, job, run_id, started_at, stats, log });
  return { from, watermark, end, behind_ids: Math.max(0, max_id - watermark), stats };
}

module.exports = {
  run_extract, extract_step, reread_late, apply_batches, dedupe_facts, upsert_statements, catalog_statement, natural_key, preflight, read_job,
  JOB, LOCK_KEY, MAX_FACTS_PER_ROW, CHUNK, FACT_CS, LATE_SQL, LATE_WINDOW_S,
};
