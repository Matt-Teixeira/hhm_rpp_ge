"use strict";
// Write path for facts (PLAN-CT-INSIGHTS.md §6, §10, §12).
//
// Runs ONLY as insight_writer (db.connect("writer")). One shared advisory
// lock with the future ge_ct stage, so a backfill and the stage never
// overlap. Per batch, one transaction: upsert facts + advance the
// watermark, so a crash can never skip rows.
//
// Upsert: ON CONFLICT (natural key) DO UPDATE ... WHERE the new rule
// version is higher. A re-run of the same version changes nothing; a fixed
// rule (version bump) replaces its old facts.
const { pgp } = require("./db");
const { catalog_rows } = require("./rules/engine");
const { stream } = require("./extract");

const JOB = "ge_ct_extract";
const LOCK_KEY = "insight_ge_ct"; // shared with the Phase 5 stage
const MIN_SCHEMA_VERSION = 3;
const CHUNK = 5000;               // rows per INSERT statement
const MAX_FACTS_PER_ROW = 3;      // runaway-rule guard (normal ~0.73)
const PARTITION_WARN_MONTHS = 6;

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

function upsert_statements(facts) {
  const out = [];
  for (let i = 0; i < facts.length; i += CHUNK) {
    out.push(pgp.helpers.insert(facts.slice(i, i + CHUNK), FACT_CS) + UPSERT_SUFFIX);
  }
  return out;
}

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

// mode "rehearse": everything in ONE transaction, rolled back (max_batches).
// mode "apply": one transaction per batch, watermark advanced with the facts.
async function run_extract(db, { rules, mode, from_id = null, to_id = null, max_batches = null, run_id, log = () => {} }) {
  if (!["rehearse", "apply"].includes(mode)) throw new Error(`bad mode ${mode}`);
  const started_at = new Date();
  const stats = { mode, rows: 0, facts: 0, upserted: 0, collisions: 0, batches: 0, skipped: {}, rule_errors: 0 };
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

      const process_batch = async (c, { rows, built, last_id }) => {
        if (built.facts.length > rows.length * MAX_FACTS_PER_ROW) {
          throw new Error(`runaway guard: ${built.facts.length} facts from ${rows.length} rows (> ${MAX_FACTS_PER_ROW}/row)`);
        }
        const { unique, collisions } = dedupe_facts(built.facts);
        let upserted = 0;
        for (const q of upsert_statements(unique)) upserted += (await c.result(q)).rowCount;
        stats.batches++; stats.rows += rows.length; stats.facts += unique.length; stats.upserted += upserted;
        stats.collisions += collisions; stats.rule_errors += built.errors.length;
        for (const [k, v] of Object.entries(built.skipped)) stats.skipped[k] = (stats.skipped[k] || 0) + v;
        const last = rows[rows.length - 1];
        return { last_id, last_capture: last.capture_datetime };
      };

      if (mode === "rehearse") {
        return await conn.tx(async (t) => {
          await t.none(catalog_statement(rules));
          let n = 0;
          const STOP = new Error("rehearsal batch limit");
          try {
            await stream(t, { from_id: start, to_id: end, rules, on_batch: async (b) => {
              await process_batch(t, b);
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
      let watermark = start;
      let watermark_capture = job ? job.watermark_capture_datetime : null;
      try {
        await stream(conn, { from_id: start, to_id: end, rules, on_batch: async (b) => {
          await conn.tx(async (t) => {
            const r = await process_batch(t, b);
            await write_job(t, { watermark_id: r.last_id, watermark_capture_datetime: r.last_capture, run_id, started_at, status: "ok", stats });
            watermark = r.last_id;
            watermark_capture = r.last_capture;
          });
          log(`  batch ${stats.batches}: watermark ${watermark}, ${stats.rows} rows, ${stats.facts} facts`);
        } });
      } catch (e) {
        // the failed batch rolled back; record the error, keep the last committed watermark
        stats.error = e.message;
        await conn.tx((t) => write_job(t, { watermark_id: watermark, watermark_capture_datetime: watermark_capture, run_id, started_at, status: "error", stats })).catch(() => {});
        throw e;
      }
      return { watermark, stats, preflight: pre };
    } finally {
      await conn.one("SELECT pg_advisory_unlock(hashtext($1)) AS ok", [LOCK_KEY]);
    }
  });
}

module.exports = { run_extract, dedupe_facts, upsert_statements, catalog_statement, natural_key, preflight, JOB, LOCK_KEY, MAX_FACTS_PER_ROW, CHUNK };
