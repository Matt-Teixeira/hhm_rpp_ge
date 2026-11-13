"use strict";
// GE MRI write path for facts (PLAN-MRI-INSIGHTS.md §4 MRI-2, §6.4, §6.6),
// modelled on insight/cv/load.js.
//
// Runs ONLY as insight_writer. Its own advisory lock. Per batch, one
// transaction: the natural-key conflict check, upsert facts, advance the
// ge_mri_extract watermark, record the touched device days for MRI-3
// derive (job_state 'ge_mri_derive' last_run_stats.pending), so a crash can
// never skip rows or lose a day.
//
// Upsert on ge_mri_facts_natural_key (the gesys natural key + metric +
// host_local, which the table CHECK ties to epoch): DO UPDATE only when the
// rule version is higher, so a re-run of the same version, or a re-sent
// copy of a record, changes nothing. The source columns keep the first row
// that gave the record.
//
// A conflict (one key, two different records: plan §6.6) refuses the batch:
// nothing of it is written and the watermark stays.
//
// Interlocks:
//   C1-MRI  before --apply, the three CT verifiers must ignore mri.* /
//           mri_ catalog rows: each exports MRI_AWARE = true once that CT
//           change is made (plan §6.4);
//   C2-MRI  insight_writer must be able to SELECT log.ge_mri_gesys;
//   schema  migration 009 applied.
// The rehearsal (one transaction, rolled back) needs only C2-MRI and 009.
//
// Nothing in the GE CT or CV run loads this file.
const { pgp } = require("../db");
const { catalog_statement } = require("../load");
const { rules, MAX_FACTS_PER_ROW, validate } = require("./rules");
const { stream, build_facts, ROW_COLUMNS } = require("./extract");
const { REVIEWED_CODES } = require("./codes_reviewed");
const { identity_sql, host_local_sql } = require("./reconcile_sql");

const JOB = "ge_mri_extract";
const DERIVE_JOB = "ge_mri_derive";
const LOCK_KEY = "insight_ge_mri";
const MIN_SCHEMA_VERSION = 9;
const CHUNK = 5000;
const PENDING_FULL_DAYS = 31; // more pending days than this -> "full" rebuild of the system
const PARTITION_WARN_MONTHS = 18; // plan §6.6: a migration adds months before 2028-06
// Late commits (as CT §15.2 item 3): rows at or below the watermark,
// captured within this of the watermark's capture time, whose record has no facts yet.
const LATE_WINDOW_S = 2 * 3600;
const CT_VERIFIERS = ["../verify_facts", "../derive/verify", "../findings/verify"];

const toJsonb = (c) => (c.value === null || c.value === undefined ? null : JSON.stringify(c.value));
const FACT_CS = new pgp.helpers.ColumnSet(
  [
    "system_id", "epoch", "record_number_concurrent", "metric_key", { name: "host_local", cast: "timestamp" },
    { name: "host_datetime", cast: "timestamptz" }, "message_number", "dim", "value_num", "value_text",
    { name: "attrs", init: toJsonb, cast: "jsonb" }, "source_id", { name: "source_capture_datetime", cast: "timestamptz" }, "rule_version",
  ],
  { table: new pgp.helpers.TableName({ table: "ge_mri_facts", schema: "insight" }) }
);
const UPSERT_SUFFIX = `
  ON CONFLICT ON CONSTRAINT ge_mri_facts_natural_key DO UPDATE SET
    host_datetime = EXCLUDED.host_datetime, message_number = EXCLUDED.message_number, dim = EXCLUDED.dim,
    value_num = EXCLUDED.value_num, value_text = EXCLUDED.value_text, attrs = EXCLUDED.attrs,
    rule_version = EXCLUDED.rule_version, extracted_at = now()
  WHERE EXCLUDED.rule_version > ge_mri_facts.rule_version`;

// ---------------------------------------------------------------- pure

const fact_key = (f) => [f.system_id, f.epoch, f.record_number_concurrent, f.metric_key].join("|");

// One INSERT ... ON CONFLICT DO UPDATE can't touch the same row twice.
// build_facts already dedupes records, so this only guards the statement.
function dedupe_facts(facts) {
  const seen = new Set();
  const unique = [];
  let collisions = 0;
  for (const f of facts) {
    const k = fact_key(f);
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
  return { mode, rows: 0, records: 0, duplicates: 0, facts: 0, upserted: 0, collisions: 0, batches: 0, skipped: {}, rule_errors: 0, unreviewed_codes: [] };
}

// known: records of this batch already stored from an earlier copy (they count as duplicates).
function add_batch_stats(stats, rows, built, unique, upserted, collisions, known = 0) {
  stats.batches++; stats.rows += rows.length; stats.records += built.records.length - known; stats.duplicates += built.duplicates + known;
  stats.facts += unique.length; stats.upserted += upserted; stats.collisions += collisions; stats.rule_errors += built.errors.length;
  for (const [k, v] of Object.entries(built.skipped)) if (v) stats.skipped[k] = (stats.skipped[k] || 0) + v;
  stats.unreviewed_codes = [...new Set([...stats.unreviewed_codes, ...unreviewed(built.codes)])].sort((a, b) => a - b);
}

// ----------------------------------------------------------------- DB

// C1-MRI: every CT verifier module must declare it ignores mri.* catalog rows.
function ct_verifiers_not_mri_aware(load = require) {
  return CT_VERIFIERS.filter((m) => load(m).MRI_AWARE !== true);
}

async function preflight(c, { mode }) {
  const who = await c.one(`SELECT current_user AS u, (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS su,
                                  CASE WHEN has_schema_privilege('log', 'USAGE') THEN has_table_privilege('log.ge_mri_gesys', 'SELECT') ELSE false END AS can_read`);
  if (who.u !== process.env.INSIGHT_PG_USER || who.su) throw new Error(`refusing: connected as ${who.u}, expected the limited ${process.env.INSIGHT_PG_USER}`);
  const v = await c.one("SELECT coalesce(max(version), 0) AS v FROM insight.schema_migrations");
  if (v.v < MIN_SCHEMA_VERSION) throw new Error(`insight schema version ${v.v} < ${MIN_SCHEMA_VERSION}: apply migration 009 first`);
  if (!who.can_read) throw new Error(`${who.u} has no SELECT on log.ge_mri_gesys (plan §6.4 C2-MRI): grant it first`);
  if (mode === "apply") {
    const missing = ct_verifiers_not_mri_aware();
    if (missing.length) throw new Error(`refusing --apply: CT verifiers not yet scoped to CT keys (plan §6.4 C1-MRI): ${missing.join(", ")}`);
  }
  const p = await c.one(`SELECT max(c.relname) AS last FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
                         WHERE i.inhparent = 'insight.ge_mri_facts'::regclass`);
  const m = /_(\d{4})_(\d{2})$/.exec(p.last || "");
  const now = new Date();
  const months_left = m ? (Number(m[1]) - now.getUTCFullYear()) * 12 + (Number(m[2]) - (now.getUTCMonth() + 1)) : -1;
  return { user: who.u, schema_version: v.v, last_partition: p.last, months_left, partition_warning: months_left < PARTITION_WARN_MONTHS };
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

// Touched days for MRI-3, in the same transaction as the facts. The derive
// row is created on first use; its own run fields stay NULL until MRI-3.
async function record_derive_pending(t, touched) {
  if (!touched.length) return;
  await t.none(`INSERT INTO insight.job_state (job_name, last_run_stats) VALUES ($1, '{}'::jsonb) ON CONFLICT (job_name) DO NOTHING`, [DERIVE_JOB]);
  const row = await t.one("SELECT last_run_stats FROM insight.job_state WHERE job_name = $1 FOR UPDATE", [DERIVE_JOB]);
  const stats = row.last_run_stats || {};
  stats.pending = merge_pending(stats.pending, touched);
  await t.none("UPDATE insight.job_state SET last_run_stats = $2::jsonb, updated_at = now() WHERE job_name = $1", [DERIVE_JOB, JSON.stringify(stats)]);
}

// Records of this batch whose key already has facts from another source
// row: fetch that row's content and compare (plan §6.6). Uses the facts'
// unique index and the source primary key. Returns the conflicts, and
// `known`: records already stored from an earlier copy (re-sent duplicates).
const EXISTING_SQL = `
  SELECT f.system_id, f.epoch, f.record_number_concurrent, f.source_id::text AS source_id, ${identity_sql("g")} AS ident
  FROM unnest($1::text[], $2::int[], $3::int[], $4::timestamp[], $5::bigint[]) AS k(system_id, epoch, rnc, host_local, id)
  JOIN insight.ge_mri_facts f
    ON f.system_id = k.system_id AND f.epoch = k.epoch AND f.record_number_concurrent = k.rnc
   AND f.host_local = k.host_local AND f.metric_key = 'mri.error' AND f.source_id <> k.id
  JOIN log.ge_mri_gesys g ON g.id = f.source_id AND g.capture_datetime = f.source_capture_datetime`;

async function check_conflicts(t, built) {
  const conflicts = [...built.conflicts];
  let known = 0;
  const recs = built.records;
  if (recs.length) {
    const col = (k) => recs.map((r) => r[k]);
    const rows = await t.any(EXISTING_SQL, [col("system_id"), col("epoch"), col("record_number_concurrent"), col("host_local"), col("id")]);
    const by = new Map(recs.map((r) => [`${r.system_id}|${r.epoch}|${r.record_number_concurrent}`, r]));
    for (const x of rows) {
      const k = `${x.system_id}|${x.epoch}|${x.record_number_concurrent}`;
      const r = by.get(k);
      if (!r) continue;
      if (r.ident !== x.ident) conflicts.push({ key: k, ids: [x.source_id, String(r.id)] });
      else known++;
    }
  }
  return { conflicts, known };
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
  const { conflicts, known } = await check_conflicts(t, built);
  if (conflicts.length) {
    throw new Error(`natural-key conflict (plan §6.6: one key, two different records), nothing of this batch written: ${JSON.stringify(conflicts.slice(0, 5))}`);
  }
  const { unique, collisions } = dedupe_facts(built.facts);
  const { upserted } = await upsert_and_record(t, unique);
  add_batch_stats(stats, rows, built, unique, upserted, collisions, known);
  return { last_capture: rows[rows.length - 1].capture_datetime };
}

const LATE_SQL = `
  SELECT ${ROW_COLUMNS}
  FROM log.ge_mri_gesys g
  WHERE g.id <= $1 AND g.capture_datetime >= $2::timestamptz - make_interval(secs => $3)
    AND NOT EXISTS (SELECT 1 FROM insight.ge_mri_facts f
                    WHERE f.system_id = g.system_id AND f.epoch = g.epoch AND f.record_number_concurrent = g.record_number_concurrent
                      AND f.metric_key = 'mri.error' AND f.host_local = ${host_local_sql("g")})
  ORDER BY g.id`;

// Late-commit re-read: rows below the watermark whose record has no facts
// yet (unstorable rows are re-read too and give none). One transaction.
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
  const r = await conn.tx(async (t) => {
    const { conflicts } = await check_conflicts(t, built);
    if (conflicts.length) throw new Error(`natural-key conflict in late re-read (plan §6.6): ${JSON.stringify(conflicts.slice(0, 5))}`);
    return upsert_and_record(t, unique);
  });
  out.inserted = r.upserted;
  out.systems = [...new Set(r.touched.map((x) => x.system_id))].sort();
  return out;
}

// mode "rehearse": everything in ONE transaction, rolled back; verify runs
//                  on the uncommitted facts (verify(t, end) -> result).
// mode "apply":    one transaction per batch, watermark advanced with the facts.
async function run_extract(db, { mode, from_id = null, to_id = null, max_batches = null, run_id = null, verify = null, log = () => {}, check = validate }) {
  if (!["rehearse", "apply"].includes(mode)) throw new Error(`bad mode ${mode}`);
  // Before any connection or write: an invalid registry must never reach the shared catalog.
  const invalid = check();
  if (invalid.length) throw new Error(`invalid MRI rule registry, nothing written: ${invalid.join("; ")}`);
  const started_at = new Date();
  const stats = new_stats(mode);
  return db.task(async (conn) => {
    const { got } = await conn.one("SELECT pg_try_advisory_lock(hashtext($1)) AS got", [LOCK_KEY]);
    if (!got) return { skipped: "another GE MRI insight run holds the lock", stats };
    try {
      const pre = await preflight(conn, { mode });
      const job = await read_job(conn);
      const start = from_id ?? (job ? Number(job.watermark_id) : 0);
      const end = to_id ?? Number((await conn.one("SELECT coalesce(max(id), 0) AS m FROM log.ge_mri_gesys")).m);
      if (mode === "apply" && from_id !== null && from_id > (job ? Number(job.watermark_id) : 0)) {
        throw new Error(`--from-id ${from_id} is beyond the watermark ${job ? job.watermark_id : 0}: that would leave a gap`);
      }
      log(`preflight: user=${pre.user} schema_version=${pre.schema_version} last_partition=${pre.last_partition} (${pre.months_left} months left${pre.partition_warning ? ": ADD PARTITIONS" : ""}); range id ${start}..${end} (watermark ${job ? job.watermark_id : "none"})`);

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

      const { watermark } = await apply_range(conn, { job, start, end, max_batches, run_id, started_at, stats, log });
      return { watermark, stats, preflight: pre, end };
    } finally {
      await conn.one("SELECT pg_advisory_unlock(hashtext($1)) AS ok", [LOCK_KEY]);
    }
  });
}

// The apply path (lock-free core; the caller holds LOCK_KEY): catalog sync,
// the late-commit re-read, then batches from start to end (at most
// max_batches), each one transaction with its watermark and touched days.
// stats is filled in place. MRI-5's stage will call this as CV's does.
async function apply_range(conn, { job, start, end, max_batches = null, run_id, started_at, stats, log = () => {} }) {
  await conn.tx((t) => t.none(catalog_statement(rules)));
  stats.late = await reread_late(conn, { job });
  let watermark = start;
  let watermark_capture = job ? job.watermark_capture_datetime : null;
  let n = 0;
  const STOP = new Error("batch limit");
  try {
    await stream(conn, { from_id: start, to_id: end, on_batch: async (b) => {
      // counts and watermark stay local until COMMIT succeeded
      const next = JSON.parse(JSON.stringify(stats));
      const r = await conn.tx(async (t) => {
        const out = await process_batch(t, b, next);
        await write_job(t, { watermark_id: b.last_id, watermark_capture_datetime: out.last_capture, run_id, started_at, status: "ok", stats: next });
        return out;
      });
      Object.assign(stats, next);
      watermark = b.last_id;
      watermark_capture = r.last_capture;
      log(`  batch ${stats.batches}: watermark ${watermark}, ${stats.rows} rows, ${stats.records} records, ${stats.facts} facts`);
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

module.exports = {
  run_extract, apply_range, reread_late, write_job, read_job, preflight, check_conflicts, dedupe_facts, upsert_statements, merge_pending,
  ct_verifiers_not_mri_aware, unreviewed, fact_key, JOB, DERIVE_JOB, LOCK_KEY, CHUNK, FACT_CS, UPSERT_SUFFIX, LATE_SQL, EXISTING_SQL,
  LATE_WINDOW_S, PENDING_FULL_DAYS, MIN_SCHEMA_VERSION, PARTITION_WARN_MONTHS,
};
