#!/usr/bin/env node
"use strict";
// One-off cleanup of duplicate rows in log.ge_ct_gesys
// (PLAN-CT-INSIGHTS.md §11.6; destructive-operation rules in §10).
//
// A duplicate is a row that is an EXACT copy of an earlier row: every
// column except id and capture_datetime is equal (NULLs equal). The
// earliest (capture_datetime, id) is kept. Rows referenced by
// alert.detections (row_id) are never deleted, so no detection loses its
// source row.
//
// Steps, each a separate command; nothing destructive without --apply:
//   preview                         read-only counts + the exact SQL
//   archive --cutoff <ISO> [--apply]  copy duplicates (captured before cutoff)
//                                   into a NEW archive_log table. Does not touch log.*
//   delete  --table <archive_log.x> [--partition <log.ge_ct_gesys_YYYY_MM>] [--apply]
//                                   per partition, in its own transaction:
//                                   re-verify, DELETE by primary key, check
//                                   rowCount == expected, else ROLLBACK
//   verify  --table <archive_log.x> read-only post-checks
//   restore-sql --table <archive_log.x>
//                                   read-only: print the exact restore statement
//                                   and how many rows it would put back
// Without --apply, archive/delete run inside BEGIN ... ROLLBACK.
//
// Concurrency (review F3): new alert.detections references are re-checked
// AFTER the delete, inside the same transaction, just before COMMIT. That
// narrows the race with a concurrent detection insert to the commit itself;
// fully closing it would need a lock on alert.detections, which this tool
// deliberately doesn't take (not our table). Run it between alert-processor
// runs. The 2026-11-03 run was verified afterwards: 0 detections pointed at
// deleted rows.
//
// Restore (review F4): use `restore-sql`. It restores only rows that were
// deleted (NOT referenced_by_detection: the kept rows are still live) and
// is safe to re-run (ON CONFLICT DO NOTHING on the primary key).

const fs = require("fs");
const path = require("path");
const readline = require("readline");

const REPO = path.resolve(__dirname, "..");
require("dotenv").config({ path: path.join(REPO, ".env") });
const pgp = require("pg-promise")({ noWarnings: true });

const ALL_COLS = ["id", "system_id", "epoch", "record_number_concurrent", "misc_param_1", "month", "day", "host_date",
  "host_time", "year", "message_number", "misc_param_2", "type", "data_1", "num_1", "date_2", "host", "ermes_number",
  "exception_class", "severity", "file", "line_number", "scan_type", "warning", "end_msg", "message", "sr", "en",
  "host_datetime", "status", "capture_datetime"];
const CONTENT = ALL_COLS.filter((c) => c !== "id" && c !== "capture_datetime");
const row = (alias) => `ROW(${CONTENT.map((c) => `${alias}.${c}`).join(", ")})`;
const WINDOW = `PARTITION BY ${CONTENT.join(", ")} ORDER BY capture_datetime, id`;

// Rows to remove, with their keeper. $1 = cutoff (only rows captured before it).
const DUPS_SQL = `
  SELECT id, capture_datetime, tableoid::regclass::text AS src_partition,
         first_value(id) OVER w AS keep_id,
         first_value(capture_datetime) OVER w AS keep_capture_datetime,
         row_number() OVER w AS rn
  FROM log.ge_ct_gesys
  WHERE capture_datetime < $1
  WINDOW w AS (${WINDOW})`;

// IN (subquery) so Postgres hashes the referenced ids once (hashed SubPlan)
const REFERENCED = (alias) =>
  `(${alias}.id::text IN (SELECT d.row_id FROM alert.detections d WHERE d.pg_table = 'log.ge_ct_gesys' AND d.row_id IS NOT NULL))`;

const RESTORE_SQL = (t) => `
    INSERT INTO log.ge_ct_gesys (${ALL_COLS.join(", ")})
    SELECT ${ALL_COLS.map((c) => `a.${c}`).join(", ")}
    FROM ${t} a
    WHERE NOT a.referenced_by_detection
    ON CONFLICT DO NOTHING`;

const sql = {
  preview: `
    WITH k AS (${DUPS_SQL})
    SELECT k.src_partition, g.system_id, count(*)::int AS dups,
           count(*) FILTER (WHERE ${REFERENCED("k")})::int AS referenced_by_detection
    FROM k JOIN log.ge_ct_gesys g ON g.id = k.id AND g.capture_datetime = k.capture_datetime
    WHERE k.rn > 1
    GROUP BY 1, 2 ORDER BY 1, 2`,
  create: (t) => `
    CREATE TABLE ${t} (
      LIKE log.ge_ct_gesys,
      src_partition           text        NOT NULL,
      keep_id                 bigint      NOT NULL,
      keep_capture_datetime   timestamptz NOT NULL,
      referenced_by_detection boolean     NOT NULL,
      archived_at             timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (id, capture_datetime)
    )`,
  fill: (t) => `
    INSERT INTO ${t} (${ALL_COLS.join(", ")}, src_partition, keep_id, keep_capture_datetime, referenced_by_detection)
    SELECT ${ALL_COLS.map((c) => `g.${c}`).join(", ")}, k.src_partition, k.keep_id, k.keep_capture_datetime, ${REFERENCED("g")}
    FROM (${DUPS_SQL}) k
    JOIN log.ge_ct_gesys g ON g.id = k.id AND g.capture_datetime = k.capture_datetime
    WHERE k.rn > 1`,
  // Pre-delete checks for one partition ($1 = src_partition). Each must return 0.
  checks: (t) => ({
    archived_row_changed_or_missing: `
      SELECT count(*)::int AS n FROM ${t} a
      LEFT JOIN log.ge_ct_gesys g ON g.id = a.id AND g.capture_datetime = a.capture_datetime
      WHERE a.src_partition = $1 AND NOT a.referenced_by_detection
        AND (g.id IS NULL OR ${row("g")} IS DISTINCT FROM ${row("a")})`,
    keeper_missing_or_different: `
      SELECT count(*)::int AS n FROM ${t} a
      LEFT JOIN log.ge_ct_gesys k ON k.id = a.keep_id AND k.capture_datetime = a.keep_capture_datetime
      WHERE a.src_partition = $1 AND NOT a.referenced_by_detection
        AND (k.id IS NULL OR ${row("k")} IS DISTINCT FROM ${row("a")})`,
    keeper_is_itself_archived: `
      SELECT count(*)::int AS n FROM ${t} a
      JOIN ${t} b ON b.id = a.keep_id AND b.capture_datetime = a.keep_capture_datetime
      WHERE a.src_partition = $1`,
    now_referenced_by_detection: `
      SELECT count(*)::int AS n FROM ${t} a
      WHERE a.src_partition = $1 AND NOT a.referenced_by_detection AND ${REFERENCED("a")}`,
  }),
  expected: (t) => `SELECT count(*)::int AS n FROM ${t} WHERE src_partition = $1 AND NOT referenced_by_detection`,
  del: (t, partition) => `
    DELETE FROM ${partition} g
    USING ${t} a
    WHERE a.src_partition = $1
      AND NOT a.referenced_by_detection
      AND g.id = a.id
      AND g.capture_datetime = a.capture_datetime`,
};

// ------------------------------------------------------------------ util
const out = (...s) => console.log(...s);
const hr = () => out("-".repeat(72));
const fail = (m) => Object.assign(new Error(m), { safeguard: true });
const ARCHIVE_RX = /^archive_log\.ge_ct_gesys_dups_\d{8}$/;
const PART_RX = /^log\.ge_ct_gesys_\d{4}_\d{2}$/;

function args(argv) {
  const a = { cmd: argv[0], apply: false };
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === "--apply") a.apply = true;
    else if (argv[i] === "--cutoff") a.cutoff = argv[++i];
    else if (argv[i] === "--table") a.table = argv[++i];
    else if (argv[i] === "--partition") a.partition = argv[++i];
    else throw fail(`unknown argument ${argv[i]}`);
  }
  if (!["preview", "archive", "delete", "verify", "restore-sql"].includes(a.cmd)) throw fail("usage: dedupe_ge_ct_gesys.js preview | archive --cutoff ISO [--apply] | delete --table T [--partition P] [--apply] | verify --table T | restore-sql --table T");
  if (a.apply && !["archive", "delete"].includes(a.cmd)) throw fail("--apply only for archive/delete");
  if (a.cmd === "archive") {
    if (!a.cutoff || Number.isNaN(Date.parse(a.cutoff))) throw fail("archive needs --cutoff <ISO timestamp>");
    const d = new Date(a.cutoff);
    a.table = `archive_log.ge_ct_gesys_dups_${d.toISOString().slice(0, 10).replace(/-/g, "")}`;
  }
  if (["delete", "verify", "restore-sql"].includes(a.cmd) && !ARCHIVE_RX.test(a.table || "")) throw fail("--table must be archive_log.ge_ct_gesys_dups_YYYYMMDD");
  if (a.partition && !PART_RX.test(a.partition)) throw fail("--partition must be log.ge_ct_gesys_YYYY_MM");
  return a;
}

function connect(statementTimeoutMs, readOnly) {
  return pgp({
    host: process.env.PG_HOST, port: process.env.PG_PORT || 5432, database: process.env.PG_DB,
    user: process.env.PG_USER, password: process.env.PG_PW, max: 1,
    ssl: { require: true, cert: fs.readFileSync(path.resolve(REPO, process.env.PG_SSL_PATH)), rejectUnauthorized: true },
    application_name: "ge_ct_gesys_dedupe",
    options: `-c lock_timeout=5000 -c statement_timeout=${statementTimeoutMs} -c idle_in_transaction_session_timeout=300000` +
      (readOnly ? " -c default_transaction_read_only=on" : ""),
  });
}

async function confirm(db, a) {
  const t = await db.one("SELECT current_database() AS db, current_user AS usr, inet_server_addr()::text AS addr");
  const mode = a.apply ? "APPLY (will COMMIT)" : "DRY RUN (BEGIN ... ROLLBACK)";
  hr();
  out(`target: database=${t.db} host=${process.env.PG_HOST} (${t.addr}) user=${t.usr}`);
  out(`step:   ${a.cmd} ${a.table || ""} ${a.partition || ""} — ${mode}`);
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  const it = rl[Symbol.asyncIterator]();
  const ask = async (q) => {
    process.stdout.write(q);
    const { value, done } = await it.next();
    if (done) throw fail("no input: aborted");
    if (!process.stdin.isTTY) out(value);
    return value.trim();
  };
  try {
    if ((await ask("Type the database name to continue: ")) !== t.db) throw fail("database name mismatch: aborted");
    if (a.apply && (await ask("This COMMITS. Type APPLY to continue: ")) !== "APPLY") throw fail("not confirmed: aborted");
  } finally {
    rl.close();
  }
}

// ---------------------------------------------------------------- steps
async function preview() {
  const db = connect(900000, true);
  try {
    const cutoff = new Date().toISOString();
    out(`preview (read-only), cutoff = now (${cutoff}); archive will use its own --cutoff`);
    const rows = await db.any(sql.preview, [cutoff]);
    const total = await db.one("SELECT count(*)::int AS n FROM log.ge_ct_gesys WHERE capture_datetime < $1", [cutoff]);
    const byPart = {}, bySys = {};
    let dups = 0, refd = 0;
    for (const r of rows) {
      byPart[r.src_partition] = byPart[r.src_partition] || { dups: 0, referenced: 0 };
      byPart[r.src_partition].dups += r.dups; byPart[r.src_partition].referenced += r.referenced_by_detection;
      bySys[r.system_id] = (bySys[r.system_id] || 0) + r.dups;
      dups += r.dups; refd += r.referenced_by_detection;
    }
    hr();
    out("by partition (exact duplicates | of which referenced by alert.detections → kept | to delete)");
    for (const [p, v] of Object.entries(byPart)) out(`  ${p.padEnd(26)} ${String(v.dups).padStart(7)} | ${String(v.referenced).padStart(4)} | ${String(v.dups - v.referenced).padStart(7)}`);
    out(`  ${"TOTAL".padEnd(26)} ${String(dups).padStart(7)} | ${String(refd).padStart(4)} | ${String(dups - refd).padStart(7)}   of ${total.n} rows (${(100 * dups / total.n).toFixed(2)}%)`);
    out(`by system: ${Object.entries(bySys).sort((x, y) => y[1] - x[1]).map(([s, n]) => `${s} ${n}`).join(", ")}`);
    hr();
    const T = "archive_log.ge_ct_gesys_dups_<YYYYMMDD>";
    out("EXACT STATEMENTS (archive step, one transaction):");
    out(sql.create(T).trim() + ";\n");
    out(sql.fill(T).trim().replace("$1", "'<cutoff>'") + ";");
    hr();
    out("EXACT STATEMENTS (delete step, one transaction PER partition, $1 = the partition name):");
    for (const [k, q] of Object.entries(sql.checks(T))) out(`-- pre-check ${k} (must be 0)\n${q.trim()};\n`);
    out(`-- expected rowCount\n${sql.expected(T).trim()};\n`);
    out(`${sql.del(T, "<log.ge_ct_gesys_YYYY_MM>").trim()};\n-- COMMIT only if rowCount = expected, else ROLLBACK`);
  } finally {
    await db.$pool.end();
  }
}

async function archive(a) {
  const db = connect(1800000, false);
  try {
    if ((await db.one("SELECT to_regclass($1) IS NOT NULL AS x", [a.table])).x) throw fail(`${a.table} already exists`);
    if (new Date(a.cutoff) > new Date()) throw fail("cutoff is in the future");
    await confirm(db, a);
    await db.task(async (c) => {
      await c.none("BEGIN");
      try {
        await c.none(sql.create(a.table));
        const t0 = Date.now();
        const r = await c.result(sql.fill(a.table), [a.cutoff]);
        const s = await c.one(`SELECT count(*)::int n, count(*) FILTER (WHERE referenced_by_detection)::int refd, count(DISTINCT src_partition)::int parts FROM ${a.table}`);
        out(`archived ${r.rowCount} rows in ${Date.now() - t0} ms (${s.refd} referenced by detections → will be kept; ${s.parts} partitions)`);
        if (r.rowCount !== s.n) throw fail("archive count mismatch");
        await c.none(a.apply ? "COMMIT" : "ROLLBACK");
        out(a.apply ? `COMMIT: ${a.table} created. log.* untouched.` : "ROLLBACK (dry run): nothing persisted.");
      } catch (e) {
        await c.none("ROLLBACK").catch(() => {});
        throw e;
      }
    });
  } finally {
    await db.$pool.end();
  }
}

async function del(a) {
  const db = connect(300000, false);
  try {
    if (!(await db.one("SELECT to_regclass($1) IS NOT NULL AS x", [a.table])).x) throw fail(`${a.table} does not exist (run archive --apply first)`);
    const live = (await db.any(`SELECT inhrelid::regclass::text AS p FROM pg_inherits WHERE inhparent = 'log.ge_ct_gesys'::regclass`)).map((r) => r.p);
    let parts = (await db.any(`SELECT DISTINCT src_partition AS p FROM ${a.table} ORDER BY 1`)).map((r) => r.p);
    if (a.partition) parts = parts.filter((p) => p === a.partition);
    if (!parts.length) throw fail("no partitions to process");
    for (const p of parts) if (!live.includes(p) || !PART_RX.test(p)) throw fail(`unexpected partition ${p}`);
    out(`partitions: ${parts.join(", ")}`);
    await confirm(db, a);
    let total = 0;
    for (const p of parts) {
      await db.task(async (c) => {
        await c.none("BEGIN");
        try {
          for (const [k, q] of Object.entries(sql.checks(a.table))) {
            const { n } = await c.one(q, [p]);
            if (n !== 0) throw fail(`${p}: pre-check ${k} = ${n} (must be 0)`);
          }
          const { n: expected } = await c.one(sql.expected(a.table), [p]);
          const t0 = Date.now();
          const r = await c.result(sql.del(a.table, p), [p]);
          if (r.rowCount !== expected) throw fail(`${p}: deleted ${r.rowCount}, expected ${expected}`);
          // F3: re-check after the delete, just before COMMIT
          const { n: late } = await c.one(sql.checks(a.table).now_referenced_by_detection, [p]);
          if (late !== 0) throw fail(`${p}: ${late} deleted row(s) became referenced by alert.detections during the delete`);
          await c.none(a.apply ? "COMMIT" : "ROLLBACK");
          total += r.rowCount;
          out(`  ${p}: pre-checks 0/0/0/0, deleted ${r.rowCount} = expected, post-check 0, ${Date.now() - t0} ms → ${a.apply ? "COMMIT" : "ROLLBACK (dry run)"}`);
        } catch (e) {
          await c.none("ROLLBACK").catch(() => {});
          throw e;
        }
      });
    }
    out(`${a.apply ? "deleted" : "would delete"} ${total} rows`);
  } finally {
    await db.$pool.end();
  }
}

async function restore_sql(a) {
  const db = connect(900000, true);
  try {
    const r = await db.one(`
      SELECT count(*) FILTER (WHERE NOT referenced_by_detection)::int AS to_restore,
             count(*) FILTER (WHERE referenced_by_detection)::int AS kept_live_skipped,
             count(*) FILTER (WHERE NOT referenced_by_detection AND EXISTS (
               SELECT 1 FROM log.ge_ct_gesys g WHERE g.id = a.id AND g.capture_datetime = a.capture_datetime))::int AS already_live
      FROM ${a.table} a`);
    out(`read-only check: ${r.to_restore} rows would be restored; ${r.kept_live_skipped} kept rows skipped (still live); ${r.already_live} already present (ON CONFLICT skips them)`);
    hr();
    out("RESTORE STATEMENT (run in one transaction, after review/approval):");
    out(RESTORE_SQL(a.table).trim() + ";");
  } finally {
    await db.$pool.end();
  }
}

async function verify(a) {
  const db = connect(900000, true);
  try {
    const r = await db.one(`
      SELECT count(*)::int AS archived,
             count(*) FILTER (WHERE referenced_by_detection)::int AS kept_referenced,
             count(*) FILTER (WHERE NOT referenced_by_detection AND EXISTS (
               SELECT 1 FROM log.ge_ct_gesys g WHERE g.id = a.id AND g.capture_datetime = a.capture_datetime))::int AS still_in_log,
             count(*) FILTER (WHERE NOT EXISTS (
               SELECT 1 FROM log.ge_ct_gesys k WHERE k.id = a.keep_id AND k.capture_datetime = a.keep_capture_datetime))::int AS keeper_missing
      FROM ${a.table} a`);
    out(r);
    if (r.keeper_missing) throw fail("some keepers are missing from log.ge_ct_gesys");
  } finally {
    await db.$pool.end();
  }
}

(async () => {
  const a = args(process.argv.slice(2));
  if (a.cmd === "preview") await preview();
  if (a.cmd === "archive") await archive(a);
  if (a.cmd === "delete") await del(a);
  if (a.cmd === "verify") await verify(a);
  if (a.cmd === "restore-sql") await restore_sql(a);
})()
  .catch((e) => {
    hr();
    console.error(e.safeguard ? `ABORTED: ${e.message}` : `ERROR: ${e.stack}`);
    process.exitCode = 1;
  })
  .finally(() => pgp.end());
