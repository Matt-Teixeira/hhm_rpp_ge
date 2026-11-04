#!/usr/bin/env node
"use strict";
// Guarded migration runner for the insight schema (PLAN-CT-INSIGHTS.md §10).
//
//   node migrations/run.js status                 show target + applied/pending (read-only)
//   node migrations/run.js scan                   static SQL scan only (no DB)
//   node migrations/run.js up   [--to N] [--apply]
//   node migrations/run.js down  --to N  [--apply]   revert versions > N (N=0: all)
//   node migrations/run.js roundtrip              up all pending, then down them, verify the
//                                                 catalog is identical to before; always rolls back
//   options: --statement-timeout <ms> (default 60000)
//
// Safeguards, in order:
//   1. Static scan of every migration file (up and down). Whitelisted
//      statement forms only; writes/DDL outside insight.* and api.ge_ct_*
//      are refused, as are transaction control, SET, CASCADE, unqualified
//      names, FKs to protected tables (lib/sqlscan.js).
//   2. Target confirmation: prints database/host/user; operator types the
//      database name (and APPLY for --apply).
//   3. Expected state: schema_migrations checksums match the files, applied
//      versions are contiguous, objects to be created don't exist yet /
//      objects to be dropped do exist.
//   4. Session limits: lock_timeout 5s, statement_timeout, idle-in-tx
//      timeout, search_path pinned to pg_catalog, advisory lock.
//   5. Dry run by default: everything runs in one transaction that is
//      rolled back. --apply commits.
//   6. In-transaction post-checks before COMMIT/ROLLBACK: catalog
//      fingerprint of every object outside insight/api.ge_ct_* unchanged;
//      no locks stronger than AccessShare on protected relations; declared
//      objects exist (up) / are gone (down).
//   7. After ROLLBACK: verify nothing persisted. After COMMIT: re-verify
//      from a fresh connection and check insight.schema_migrations.

const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const readline = require("readline");
const { execFileSync } = require("child_process");

const REPO = path.resolve(__dirname, "..");
require("dotenv").config({ path: path.join(REPO, ".env") });
const pgp = require("pg-promise")({ noWarnings: true });
const { scanSql } = require("./lib/sqlscan");
const cat = require("./lib/catalog");

const MIG_DIR = __dirname;
const ADVISORY_KEY = "insight_schema_migrations";

// ------------------------------------------------------------------ args
function parseArgs(argv) {
  const a = { cmd: argv[0], apply: false, to: null, statementTimeout: 60000 };
  for (let i = 1; i < argv.length; i++) {
    const v = argv[i];
    if (v === "--apply") a.apply = true;
    else if (v === "--to") a.to = parseInt(argv[++i], 10);
    else if (v === "--statement-timeout") a.statementTimeout = parseInt(argv[++i], 10);
    else throw new Error(`unknown argument: ${v}`);
  }
  if (!["status", "scan", "up", "down", "roundtrip"].includes(a.cmd)) throw new Error("usage: run.js status|scan|up|down|roundtrip [--to N] [--apply]");
  if (a.cmd === "down" && (a.to === null || Number.isNaN(a.to))) throw new Error("down requires --to N (versions > N are reverted; 0 = all)");
  if (a.apply && !["up", "down"].includes(a.cmd)) throw new Error("--apply only applies to up/down");
  if (!(a.statementTimeout > 0)) throw new Error("bad --statement-timeout");
  return a;
}

// --------------------------------------------------------------- output
const out = (...s) => console.log(...s);
const hr = () => out("-".repeat(72));
const fail = (msg) => { const e = new Error(msg); e.safeguard = true; return e; };

// ----------------------------------------------------------- migrations
function sha256(s) {
  return crypto.createHash("sha256").update(s).digest("hex");
}

function loadMigrations() {
  const files = fs.readdirSync(MIG_DIR).filter((f) => /^\d{3}_[a-z0-9_]+(\.down)?\.sql$/.test(f));
  const byVer = new Map();
  for (const f of files) {
    const m = /^(\d{3})_([a-z0-9_]+?)(\.down)?\.sql$/.exec(f);
    const v = parseInt(m[1], 10);
    const e = byVer.get(v) || { version: v, name: m[2] };
    if (e.name !== m[2]) throw fail(`version ${m[1]} has two names: ${e.name} / ${m[2]}`);
    e[m[3] ? "downFile" : "upFile"] = f;
    byVer.set(v, e);
  }
  const migs = [...byVer.values()].sort((a, b) => a.version - b.version);
  migs.forEach((m, i) => {
    if (m.version !== i + 1) throw fail(`migration versions must be contiguous from 001 (found ${m.version} at position ${i + 1})`);
    if (!m.upFile || !m.downFile) throw fail(`migration ${m.version} needs both ${m.version}_${m.name}.sql and .down.sql`);
    m.upSql = fs.readFileSync(path.join(MIG_DIR, m.upFile), "utf8");
    m.downSql = fs.readFileSync(path.join(MIG_DIR, m.downFile), "utf8");
    m.checksum = sha256(m.upSql);
    m.downChecksum = sha256(m.downSql);
  });
  return migs;
}

function scanAll(migs) {
  const errors = [];
  for (const m of migs) {
    m.upScan = scanSql(m.upSql, { filename: m.upFile });
    m.downScan = scanSql(m.downSql, { filename: m.downFile });
    errors.push(...m.upScan.errors, ...m.downScan.errors);
  }
  return errors;
}

// -------------------------------------------------------------- database
function connect(statementTimeout) {
  const sslPath = process.env.PG_SSL_PATH ? path.resolve(REPO, process.env.PG_SSL_PATH) : null;
  if (!process.env.PG_HOST || !process.env.PG_DB || !process.env.PG_USER) throw fail("PG_HOST / PG_DB / PG_USER not set (.env)");
  return pgp({
    host: process.env.PG_HOST,
    port: process.env.PG_PORT || 5432,
    database: process.env.PG_DB,
    user: process.env.PG_USER,
    password: process.env.PG_PW,
    ssl: sslPath ? { require: true, cert: fs.readFileSync(sslPath), rejectUnauthorized: true } : undefined,
    application_name: "insight_migrate",
    max: 1,
    options: [
      "-c lock_timeout=5000",
      `-c statement_timeout=${statementTimeout}`,
      "-c idle_in_transaction_session_timeout=300000",
      "-c search_path=pg_catalog,pg_temp",
    ].join(" "),
  });
}

async function target(conn) {
  return conn.one(`SELECT current_database() AS db, current_user AS usr, inet_server_addr()::text AS addr,
                          inet_server_port() AS port, current_setting('server_version') AS version,
                          current_setting('lock_timeout') AS lock_timeout, current_setting('statement_timeout') AS statement_timeout,
                          current_setting('search_path') AS search_path, now() AS now`);
}

async function readState(conn, migs) {
  const st = await conn.one(`SELECT to_regnamespace('insight') IS NOT NULL AS has_schema,
                                    to_regclass('insight.schema_migrations') IS NOT NULL AS has_table`);
  if (st.has_schema && !st.has_table) throw fail("schema insight exists but insight.schema_migrations does not: unknown state, refusing");
  const rows = st.has_table ? await conn.any("SELECT * FROM insight.schema_migrations ORDER BY version") : [];
  rows.forEach((r, i) => {
    if (r.version !== i + 1) throw fail(`insight.schema_migrations is not contiguous (row ${i + 1} is version ${r.version})`);
    const m = migs.find((x) => x.version === r.version);
    if (!m) throw fail(`version ${r.version} is applied in the DB but has no file here`);
    if (m.name !== r.name) throw fail(`version ${r.version}: DB name ${r.name} != file name ${m.name}`);
    if (m.checksum !== r.checksum) throw fail(`version ${r.version}: ${m.upFile} changed since it was applied (checksum mismatch). Write a new migration instead.`);
    if (m.downChecksum !== r.down_checksum) throw fail(`version ${r.version}: ${m.downFile} changed since it was applied (checksum mismatch)`);
  });
  return { applied: rows.length, rows };
}

async function objectExists(conn, o) {
  if (o.kind === "schema") return (await conn.one("SELECT to_regnamespace($1) IS NOT NULL AS x", [o.name])).x;
  if (o.kind === "relation") return (await conn.one("SELECT to_regclass($1) IS NOT NULL AS x", [o.name])).x;
  if (o.kind === "type") return (await conn.one("SELECT to_regtype($1) IS NOT NULL AS x", [o.name])).x;
  if (o.kind === "function") {
    const [s, n] = o.name.split(".");
    return (await conn.one(`SELECT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
                                           WHERE ns.nspname = $1 AND p.proname = $2) AS x`, [s, n])).x;
  }
  throw new Error(`unknown object kind ${o.kind}`);
}

// --------------------------------------------------------------- prompts
function makePrompter() {
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  const it = rl[Symbol.asyncIterator]();
  return {
    async ask(q) {
      process.stdout.write(q);
      const { value, done } = await it.next();
      if (done) throw fail("no input: aborted");
      if (!process.stdin.isTTY) out(value); // echo piped input so the log shows what was confirmed
      return value.trim();
    },
    close: () => rl.close(),
  };
}

function gitCommit() {
  try {
    const head = execFileSync("git", ["-C", REPO, "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
    const dirty = execFileSync("git", ["-C", REPO, "status", "--porcelain", "--", "migrations"], { encoding: "utf8" }).trim();
    return dirty ? `${head}+uncommitted-migrations` : head;
  } catch {
    return null;
  }
}

function fmtDiff(d, limit = 15) {
  const lines = [];
  for (const [label, arr] of [["+", d.added], ["-", d.removed], ["~", d.changed]]) {
    for (const k of arr.slice(0, limit)) lines.push(`      ${label} ${k}`);
    if (arr.length > limit) lines.push(`      ${label} ... ${arr.length - limit} more`);
  }
  return lines.join("\n");
}

// ------------------------------------------------------------------ main
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const migs = loadMigrations();

  // 1. static scan (before touching the DB)
  hr();
  out(`[1] static SQL scan: ${migs.map((m) => `${m.upFile}, ${m.downFile}`).join(", ")}`);
  const scanErrors = scanAll(migs);
  if (scanErrors.length) {
    scanErrors.forEach((e) => out(`    REFUSED ${e}`));
    throw fail(`static scan refused ${scanErrors.length} statement(s)`);
  }
  for (const m of migs) {
    out(`    ok  ${m.upFile}: ${m.upScan.statements.length} statements, creates ${m.upScan.creates.length} objects; ` +
        `${m.downFile}: ${m.downScan.statements.length} statements  sha256 ${m.checksum.slice(0, 12)}/${m.downChecksum.slice(0, 12)}`);
  }
  if (args.cmd === "scan") return 0;

  const db = connect(args.statementTimeout);
  let prompter = null;
  try {
    // 2. target confirmation
    const t = await target(db);
    hr();
    out("[2] target");
    out(`    database : ${t.db}`);
    out(`    host     : ${process.env.PG_HOST} (${t.addr}:${t.port})`);
    out(`    user     : ${t.usr}`);
    out(`    server   : PostgreSQL ${t.version}`);
    out(`    session  : lock_timeout=${t.lock_timeout} statement_timeout=${t.statement_timeout} search_path=${t.search_path}`);
    const mode = args.cmd === "status" ? "STATUS (read-only)" : args.apply ? "APPLY (will COMMIT)" : "DRY RUN (BEGIN ... ROLLBACK)";
    out(`    mode     : ${args.cmd} — ${mode}`);

    // 3. expected state (read-only)
    const state = await db.tx({ mode: new pgp.txMode.TransactionMode({ readOnly: true }) }, (c) => readState(c, migs));
    hr();
    out(`[3] expected state: ${state.applied} of ${migs.length} migrations applied`);
    for (const m of migs) {
      const r = state.rows.find((x) => x.version === m.version);
      out(`    ${String(m.version).padStart(3, "0")} ${m.name.padEnd(22)} ${r ? `applied ${r.applied_at.toISOString()} by ${r.applied_by} (${r.git_commit || "?"}), checksum ok` : "pending"}`);
    }
    if (args.cmd === "status") return 0;

    let ups = [], downs = [];
    if (args.cmd === "up" || args.cmd === "roundtrip") {
      const to = args.cmd === "up" && args.to !== null ? args.to : migs.length;
      ups = migs.filter((m) => m.version > state.applied && m.version <= to);
    }
    if (args.cmd === "down") downs = migs.filter((m) => m.version <= state.applied && m.version > args.to).reverse();
    if (args.cmd === "roundtrip") downs = [...ups].reverse();
    if (!ups.length && !downs.length) {
      out("    nothing to do");
      return 0;
    }
    out(`    plan: ${[...ups.map((m) => `up ${m.version}`), ...downs.map((m) => `down ${m.version}`)].join(" -> ")}`);

    // expected-state object checks (against the current committed state)
    const missing = [], present = [];
    for (const m of ups) for (const o of m.upScan.freshCreates) if (await objectExists(db, o)) present.push(`${m.upFile}: ${o.kind} ${o.name} already exists`);
    if (args.cmd === "down") {
      for (const m of downs) for (const o of m.downScan.drops) if (!(await objectExists(db, o))) missing.push(`${m.downFile}: ${o.kind} ${o.name} does not exist`);
    }
    if (present.length || missing.length) {
      [...present, ...missing].forEach((x) => out(`    FAIL ${x}`));
      throw fail("expected-state pre-check failed");
    }
    out(`    ok  ${ups.reduce((n, m) => n + m.upScan.freshCreates.length, 0)} objects to create are absent` +
        (args.cmd === "down" ? `; ${downs.reduce((n, m) => n + m.downScan.drops.length, 0)} objects to drop are present` : ""));

    // confirmation
    hr();
    prompter = makePrompter();
    const typed = await prompter.ask(`Type the database name to continue (${mode}): `);
    if (typed !== t.db) throw fail(`typed "${typed}" != "${t.db}": aborted`);
    if (args.apply) {
      const typed2 = await prompter.ask(`This will COMMIT ${ups.length + downs.length} migration step(s) to "${t.db}". Type APPLY to continue: `);
      if (typed2 !== "APPLY") throw fail("not confirmed: aborted");
    }
    prompter.close();
    prompter = null;

    // 4-6. one transaction
    const commit = args.apply === true;
    const git = gitCommit();
    let pre;
    await db.task(async (c) => {
      await c.none("BEGIN");
      try {
        hr();
        out(`[4] BEGIN; pg_advisory_xact_lock('${ADVISORY_KEY}')`);
        await c.one("SELECT pg_advisory_xact_lock(hashtext($1)::bigint) AS l", [ADVISORY_KEY]);
        const again = await readState(c, migs);
        if (again.applied !== state.applied) throw fail("schema_migrations changed while confirming: aborted");
        pre = await cat.snapshot(c);
        const preProt = cat.protectedOf(pre);
        out(`    catalog fingerprint taken: ${pre.size} objects (${preProt.size} protected)`);
        // The fingerprint itself (pg_get_viewdef/partkeydef) takes AccessShare
        // locks on what it inspects. Record them so the lock check below only
        // reports locks taken by the migration statements.
        const lockKey = (l) => `${l.schema}.${l.name}:${l.mode}`;
        const baseLocks = new Set((await cat.foreignLocks(c)).map(lockKey));
        out(`    baseline: ${baseLocks.size} AccessShare locks on protected relations held by the fingerprint query itself`);
        const checkLocks = async (when) => {
          const added = (await cat.foreignLocks(c)).filter((l) => !baseLocks.has(lockKey(l)));
          out(`    locks taken on protected relations by the migration statements (${when}): ${added.length ? added.map(lockKey).join(", ") : "none"}`);
          if (added.some((l) => l.mode !== "AccessShareLock")) throw fail("migration takes locks stronger than AccessShareLock on protected relations");
        };

        hr();
        out("[5] executing");
        const run = async (m, dir) => {
          const scan = dir === "up" ? m.upScan : m.downScan;
          const file = dir === "up" ? m.upFile : m.downFile;
          out(`    ${dir.toUpperCase()} ${file}`);
          const t0 = Date.now();
          for (const s of scan.statements) {
            const s0 = Date.now();
            try {
              await c.result(s.sql);
            } catch (e) {
              throw fail(`${file} line ${s.line}: ${e.message}\n      statement: ${s.sql.split("\n")[0].slice(0, 100)}`);
            }
            const head = s.sql.replace(/\s+/g, " ").slice(0, 78);
            const ms = Date.now() - s0;
            if (ms > 200 || !/PARTITION OF/.test(head)) out(`      ${String(ms).padStart(5)} ms  L${String(s.line).padEnd(4)} ${head}`);
          }
          const nparts = scan.statements.filter((s) => /PARTITION OF/.test(s.sql)).length;
          if (nparts) out(`      (+ ${nparts} partition statements, each < 200 ms)`);
          if (dir === "up") {
            await c.none(`INSERT INTO insight.schema_migrations (version, name, checksum, down_checksum, git_commit, runner_host)
                          VALUES ($1, $2, $3, $4, $5, $6)`, [m.version, m.name, m.checksum, m.downChecksum, git, os.hostname()]);
            out(`      recorded version ${m.version} in insight.schema_migrations`);
          } else if ((await c.one("SELECT to_regclass('insight.schema_migrations') IS NOT NULL AS x")).x) {
            const r = await c.result("DELETE FROM insight.schema_migrations WHERE version = $1", [m.version]);
            if (r.rowCount !== 1) throw fail(`expected to delete 1 schema_migrations row for ${m.version}, deleted ${r.rowCount}`);
            out(`      removed version ${m.version} from insight.schema_migrations`);
          } else out("      insight.schema_migrations dropped with the schema");
          out(`      ${file}: ${Date.now() - t0} ms`);
        };

        let mid = null;
        for (const m of ups) await run(m, "up");
        if (args.cmd === "roundtrip") {
          await checkLocks("after up");
          mid = await cat.snapshot(c);
          const d = cat.diff(cat.protectedOf(pre), cat.protectedOf(mid));
          if (!d.same) throw fail(`protected objects changed after up:\n${fmtDiff(d)}`);
          const sd = cat.diff(cat.scopedOf(pre), cat.scopedOf(mid));
          out(`    after up: protected unchanged; in-scope +${sd.added.length} -${sd.removed.length} ~${sd.changed.length}`);
        }
        for (const m of downs) await run(m, "down");
        await checkLocks(args.cmd === "roundtrip" ? "after down" : "all steps");

        // 6. in-transaction post-checks
        hr();
        out("[6] post-checks (inside the transaction)");
        const post = await cat.snapshot(c);
        const d = cat.diff(preProt, cat.protectedOf(post));
        if (!d.same) throw fail(`protected objects changed:\n${fmtDiff(d)}`);
        out(`    ok  protected objects unchanged (${preProt.size} fingerprints: log.*, public.*, alert.*, api.* except ge_ct_*, ...)`);
        const sd = cat.diff(cat.scopedOf(pre), cat.scopedOf(post));
        out(`    in-scope changes (insight.*, api.ge_ct_*): +${sd.added.length} -${sd.removed.length} ~${sd.changed.length}`);
        if (sd.added.length) out(fmtDiff({ added: sd.added, removed: [], changed: [] }, 12));
        if (args.cmd !== "roundtrip") {
          for (const m of ups) for (const o of m.upScan.creates) if (!(await objectExists(c, o))) throw fail(`${o.kind} ${o.name} missing after ${m.upFile}`);
          for (const m of downs) for (const o of m.downScan.netDrops) if (await objectExists(c, o)) throw fail(`${o.kind} ${o.name} still present after ${m.downFile}`);
          out("    ok  declared objects " + (ups.length ? "created" : "dropped"));
        } else {
          const full = cat.diff(cat.hashes(pre), cat.hashes(post));
          if (!full.same) throw fail(`down did not restore the pre-migration catalog:\n${fmtDiff(full)}`);
          out(`    ok  down restored the catalog exactly (${pre.size} objects identical, incl. insight/api)`);
        }

        hr();
        if (commit) {
          await c.none("COMMIT");
          out("[7] COMMIT");
        } else {
          await c.none("ROLLBACK");
          out("[7] ROLLBACK (dry run)");
        }
      } catch (e) {
        await c.none("ROLLBACK").catch(() => {});
        out("    ROLLBACK (error)");
        throw e;
      }
    });

    // 7. after the transaction, from a fresh connection
    const fresh = connect(args.statementTimeout);
    try {
      const after = await fresh.tx({ mode: new pgp.txMode.TransactionMode({ readOnly: true }) }, async (c) => ({
        snap: await cat.snapshot(c),
        state: await readState(c, migs),
      }));
      const dp = cat.diff(cat.protectedOf(pre), cat.protectedOf(after.snap));
      if (!dp.same) throw fail(`protected objects differ after ${commit ? "COMMIT" : "ROLLBACK"} (concurrent DDL by another session?):\n${fmtDiff(dp)}`);
      if (commit) {
        const expect = args.cmd === "up" ? state.applied + ups.length : args.to;
        if (after.state.applied !== expect) throw fail(`schema_migrations shows ${after.state.applied} applied, expected ${expect}`);
        out(`    ok  fresh connection: protected objects unchanged; ${after.state.applied} migration(s) recorded with matching checksums`);
      } else {
        const full = cat.diff(cat.hashes(pre), cat.hashes(after.snap));
        if (!full.same) throw fail(`dry run left changes behind:\n${fmtDiff(full)}`);
        out(`    ok  fresh connection: catalog identical to before (${pre.size} objects); nothing persisted`);
      }
    } finally {
      await fresh.$pool.end();
    }
    hr();
    out(commit ? "APPLIED." : "DRY RUN OK. Nothing was committed. Re-run with --apply to commit.");
    return 0;
  } finally {
    if (prompter) prompter.close();
    await db.$pool.end();
  }
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((e) => {
    hr();
    console.error(e.safeguard ? `ABORTED: ${e.message}` : `ERROR: ${e.stack || e.message}`);
    process.exitCode = 1;
  })
  .finally(() => pgp.end());
