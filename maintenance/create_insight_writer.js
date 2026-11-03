#!/usr/bin/env node
"use strict";
// Create the limited login `insight_writer` (PLAN-CT-INSIGHTS.md §10, §12).
//
// Run ON THE PRODUCTION SERVER (vm-debian), from the repo root, as the
// operator:
//   node maintenance/create_insight_writer.js            # dry run (BEGIN ... ROLLBACK)
//   node maintenance/create_insight_writer.js --apply    # commit, then write .env
//
// What the role can do: LOGIN; SELECT on log.ge_ct_gesys, public.systems,
// public.sites. Its insight.* rights come from migration 003 (versioned
// with the schema). Nothing else: no superuser/createdb/createrole/
// replication/bypassrls, and the script refuses to commit if the role
// would hold any write/DDL privilege outside insight (including via PUBLIC).
// Read-only grants PUBLIC already has (e.g. pg_stat_statements) are listed.
//
// Secret handling: the password is generated here, sent to the server
// only as a SCRAM-SHA-256 verifier (never plaintext, so statement logging
// can't capture it), and written only to this checkout's .env as
// INSIGHT_PG_USER / INSIGHT_PG_PW. It is never printed.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const readline = require("readline");

const REPO = path.resolve(__dirname, "..");
const ENV_PATH = path.join(REPO, ".env");
require("dotenv").config({ path: ENV_PATH });
const pgp = require("pg-promise")({ noWarnings: true });

const ROLE = "insight_writer";
const SOURCE_TABLES = ["log.ge_ct_gesys", "public.systems", "public.sites"];

const out = (...s) => console.log(...s);
const hr = () => out("-".repeat(72));
const fail = (m) => Object.assign(new Error(m), { safeguard: true });

const { scramVerifier } = require("./lib/scram");

function connect(user, password) {
  return pgp({
    host: process.env.PG_HOST, port: process.env.PG_PORT || 5432, database: process.env.PG_DB,
    user, password, max: 1, application_name: "create_insight_writer",
    ssl: { require: true, cert: fs.readFileSync(path.resolve(REPO, process.env.PG_SSL_PATH)), rejectUnauthorized: true },
    options: "-c lock_timeout=5000 -c statement_timeout=60000",
  });
}

// Every privilege the role holds outside insight that isn't the expected
// SELECT on the three source tables. Must be empty.
const UNEXPECTED_PRIVS_SQL = `
  WITH rels AS (
    SELECT c.oid, n.nspname, c.relname, c.relkind
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r','p','v','m','f','S')
      AND n.nspname NOT IN ('pg_catalog','information_schema','insight') AND n.nspname !~ '^pg_(toast|temp)'
  ), privs AS (
    SELECT r.nspname || '.' || r.relname AS obj, p.priv
    FROM rels r
    CROSS JOIN unnest(CASE WHEN r.relkind = 'S' THEN ARRAY['USAGE','UPDATE']
                           ELSE ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'] END) AS p(priv)
    WHERE CASE WHEN r.relkind = 'S' THEN has_sequence_privilege($1, r.oid, p.priv)
               ELSE has_table_privilege($1, r.oid, p.priv) END
  )
  SELECT obj, priv FROM privs
  WHERE NOT (priv = 'SELECT' AND obj = ANY($2::text[]))
  UNION ALL
  SELECT 'schema ' || nspname, 'CREATE' FROM pg_namespace
  WHERE has_schema_privilege($1, oid, 'CREATE') AND nspname NOT IN ('pg_catalog','information_schema') AND nspname !~ '^pg_(toast|temp)'
  ORDER BY 1, 2`;

async function main() {
  const apply = process.argv.includes("--apply");
  const extra = process.argv.slice(2).filter((a) => a !== "--apply");
  if (extra.length) throw fail(`unknown argument(s): ${extra.join(" ")}`);

  const envText = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, "utf8") : "";
  if (/^\s*INSIGHT_PG_(USER|PW)\s*=/m.test(envText)) throw fail(".env already has INSIGHT_PG_USER/INSIGHT_PG_PW: refusing (role already set up?)");

  const db = connect(process.env.PG_USER, process.env.PG_PW);
  try {
    const t = await db.one(`SELECT current_database() AS db, current_user AS usr, inet_server_addr()::text AS addr,
                                   r.rolcreaterole, EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1) AS role_exists
                            FROM pg_roles r WHERE r.rolname = current_user`, [ROLE]);
    hr();
    out(`target : database=${t.db} host=${process.env.PG_HOST} (${t.addr}) user=${t.usr}`);
    out(`action : create role ${ROLE} — ${apply ? "APPLY (will COMMIT, then write .env)" : "DRY RUN (BEGIN ... ROLLBACK)"}`);
    if (t.role_exists) throw fail(`role ${ROLE} already exists`);
    if (!t.rolcreaterole) throw fail(`${t.usr} lacks CREATEROLE`);
    for (const tbl of SOURCE_TABLES) {
      if (!(await db.one("SELECT to_regclass($1) IS NOT NULL AS x", [tbl])).x) throw fail(`${tbl} not found`);
    }

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
      if (apply && (await ask("This creates a login. Type APPLY to continue: ")) !== "APPLY") throw fail("not confirmed: aborted");
    } finally {
      rl.close();
    }

    const password = crypto.randomBytes(30).toString("base64url"); // 40 chars, URL/.env safe
    const verifier = scramVerifier(password);
    const db_ident = pgp.as.name(t.db);
    const statements = [
      [`CREATE ROLE ${ROLE} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT CONNECTION LIMIT 5 PASSWORD $1`, [verifier]],
      [`ALTER ROLE ${ROLE} SET statement_timeout = '5min'`],
      [`ALTER ROLE ${ROLE} SET lock_timeout = '5s'`],
      [`ALTER ROLE ${ROLE} SET idle_in_transaction_session_timeout = '5min'`],
      [`GRANT CONNECT ON DATABASE ${db_ident} TO ${ROLE}`],
      [`GRANT USAGE ON SCHEMA log, public TO ${ROLE}`],
      [`GRANT SELECT ON ${SOURCE_TABLES.join(", ")} TO ${ROLE}`],
    ];
    await db.task(async (c) => {
      await c.none("BEGIN");
      try {
        hr();
        for (const [q, v] of statements) {
          await c.none(q, v);
          out(`  ok  ${q.replace("$1", "'SCRAM-SHA-256$4096:<generated verifier>'")}`);
        }
        const extra = await c.any(UNEXPECTED_PRIVS_SQL, [ROLE, SOURCE_TABLES]);
        // Reads granted to PUBLIC (e.g. pg_stat_statements views) don't threaten
        // "write only to insight"; any write/DDL privilege does.
        const reads = extra.filter((b) => b.priv === "SELECT");
        const bad = extra.filter((b) => b.priv !== "SELECT");
        if (reads.length) out(`  info read-only grants inherited outside the source tables (PUBLIC): ${reads.map((b) => b.obj).join(", ")}`);
        if (bad.length) {
          bad.slice(0, 20).forEach((b) => out(`  UNEXPECTED ${b.priv} on ${b.obj}`));
          throw fail(`${ROLE} would hold ${bad.length} write/DDL privilege(s) outside insight (e.g. via PUBLIC): not committing`);
        }
        const ok = await c.one(`SELECT bool_and(has_table_privilege($1, t, 'SELECT')) AS sel FROM unnest($2::text[]) t`, [ROLE, SOURCE_TABLES]);
        if (!ok.sel) throw fail("SELECT on source tables not effective");
        out("  ok  privilege check: SELECT on the 3 source tables; no write/DDL privilege anywhere outside insight (checked every table, view, sequence and schema)");
        await c.none(apply ? "COMMIT" : "ROLLBACK");
        out(apply ? "  COMMIT" : "  ROLLBACK (dry run): nothing persisted");
      } catch (e) {
        await c.none("ROLLBACK").catch(() => {});
        throw e;
      }
    });
    if (!apply) {
      hr();
      out("DRY RUN OK. Re-run with --apply to create the login and write .env.");
      return;
    }

    // Prove the credential works and is read-only outside insight, as the new role itself.
    const w = connect(ROLE, password);
    try {
      const r = await w.one(`SELECT current_user AS usr, (SELECT count(*) FROM (SELECT 1 FROM log.ge_ct_gesys LIMIT 1) x)::int AS can_read,
                                    current_setting('statement_timeout') AS st`);
      out(`  ok  logged in as ${r.usr}; read log.ge_ct_gesys: ${r.can_read === 1 ? "yes" : "no rows"}; statement_timeout=${r.st}`);
    } finally {
      await w.$pool.end();
    }
    const sep = envText.length && !envText.endsWith("\n") ? "\n" : "";
    fs.appendFileSync(ENV_PATH, `${sep}\n# insight pipeline login (created ${new Date().toISOString()} by maintenance/create_insight_writer.js)\nINSIGHT_PG_USER="${ROLE}"\nINSIGHT_PG_PW="${password}"\n`);
    hr();
    out(`APPLIED. INSIGHT_PG_USER / INSIGHT_PG_PW appended to ${ENV_PATH} (password not shown).`);
    out("Next: apply migration 003 (grants insight.* rights): node migrations/run.js up --apply");
  } finally {
    await db.$pool.end();
  }
}

main()
  .catch((e) => {
    hr();
    console.error(e.safeguard ? `ABORTED: ${e.message}` : `ERROR: ${e.stack || e.message}`);
    process.exitCode = 1;
  })
  .finally(() => pgp.end());
