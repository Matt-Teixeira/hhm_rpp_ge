"use strict";
// node --test migrations/test   (no DB needed)
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { scanSql, splitStatements } = require("../lib/sqlscan");

const dir = path.join(__dirname, "..");
const files = fs.readdirSync(dir).filter((f) => /^\d{3}_.*\.sql$/.test(f));

test("all migration files pass the scan", () => {
  assert.ok(files.length >= 4, "expected up+down files");
  for (const f of files) {
    const r = scanSql(fs.readFileSync(path.join(dir, f), "utf8"), { filename: f });
    assert.deepStrictEqual(r.errors, [], f);
    assert.ok(r.statements.length > 0, f);
  }
});

test("001 declares the objects it creates; 001 down drops them", () => {
  const up = scanSql(fs.readFileSync(path.join(dir, "001_insight_schema.sql"), "utf8"));
  const names = up.creates.map((c) => c.name);
  for (const n of ["insight", "insight.schema_migrations", "insight.ge_ct_facts", "insight.ge_ct_facts_2026_11",
    "insight.ge_ct_facts_natural_key".replace("_natural_key", ""), "insight.findings_one_open_idx", "insight.ensure_ge_ct_facts_partitions"]) {
    assert.ok(names.includes(n), `missing create ${n}`);
  }
  const down = scanSql(fs.readFileSync(path.join(dir, "001_insight_schema.down.sql"), "utf8"));
  assert.ok(down.drops.some((d) => d.kind === "schema" && d.name === "insight"));
});

test("splitter respects quotes, dollar bodies and comments", () => {
  const s = splitStatements(`
    -- a; comment
    CREATE TABLE insight.a (x text DEFAULT 'a;b'); /* c; d */
    CREATE FUNCTION insight.f() RETURNS int LANGUAGE plpgsql AS $x$ BEGIN RETURN 1; END $x$;
    COMMENT ON TABLE insight.a IS 'it''s; fine';`);
  assert.strictEqual(s.length, 3);
});

const refuse = (sql, re) => {
  const r = scanSql(sql);
  assert.ok(!r.ok, `should refuse: ${sql}`);
  if (re) assert.match(r.errors.join("\n"), re);
};
const allow = (sql) => {
  const r = scanSql(sql);
  assert.deepStrictEqual(r.errors, [], sql);
};

test("refuses writes outside insight / api.ge_ct_*", () => {
  refuse("DELETE FROM log.ge_ct_gesys WHERE id = 1", /outside the allowed scope/);
  refuse("UPDATE public.systems SET id = id", /outside/);
  refuse("TRUNCATE log.ge_ct_gesys", /outside/);
  refuse("TRUNCATE insight.a, log.ge_ct_gesys", /outside/);
  refuse("DROP TABLE alert.detections", /outside/);
  refuse("DROP TABLE insight.a, public.systems", /outside/);
  refuse("ALTER TABLE log.ge_ct_gesys ADD COLUMN x int", /outside/);
  refuse("INSERT INTO public.systems (id) VALUES ('x')", /outside/);
  refuse("DROP VIEW api.hca_odata", /outside/);
  refuse("CREATE OR REPLACE VIEW api.request_history AS SELECT 1", /outside/);
  refuse("CREATE SCHEMA other", /only schema "insight"/);
  refuse("DROP SCHEMA log", /only "insight"/);
  refuse("CREATE INDEX x ON log.ge_ct_gesys (epoch)", /outside/);
  refuse("GRANT SELECT ON log.ge_ct_gesys TO public", /outside/);
  refuse("GRANT SELECT ON ALL TABLES IN SCHEMA log TO x", /only "insight"/);
  refuse("GRANT avantehs_admin TO someone", /not allowed/);
  refuse("GRANT SELECT ON insight.a, log.ge_ct_gesys TO r", /outside/);
  refuse("REVOKE ALL ON insight.a, public.systems FROM r", /outside/);
  refuse("GRANT USAGE ON SCHEMA insight, log TO r", /only "insight"/);
  refuse("COMMENT ON TABLE log.ge_ct_gesys IS 'x'", /outside/);
});

test("refuses unqualified names, CASCADE, FKs to protected tables", () => {
  refuse("CREATE TABLE findings (x int)", /schema-qualified/);
  refuse("DELETE FROM ge_ct_gesys", /schema-qualified/);
  refuse("DROP SCHEMA insight CASCADE", /CASCADE/);
  refuse("DROP TABLE insight.a CASCADE", /CASCADE/);
  refuse("TRUNCATE insight.a CASCADE", /CASCADE/);
  refuse("CREATE TABLE insight.a (s text REFERENCES public.systems (id))", /REFERENCES target/);
  refuse("ALTER TABLE insight.a ADD FOREIGN KEY (s) REFERENCES public.systems (id)", /REFERENCES target/);
  refuse("CREATE TABLE insight.p PARTITION OF log.ge_ct_gesys FOR VALUES FROM ('2020-01-01') TO ('2020-02-01')", /PARTITION OF target/);
  refuse("ALTER TABLE insight.a SET SCHEMA public", /SET SCHEMA/);
});

test("refuses transaction control, session changes and unknown statements", () => {
  refuse("COMMIT", /transaction control/);
  refuse("BEGIN", /transaction control/);
  refuse("ROLLBACK", /transaction control/);
  refuse("END", /transaction control/);
  refuse("SET search_path = public", /SET\/RESET/);
  refuse("RESET ROLE", /SET\/RESET/);
  refuse("SELECT pg_terminate_backend(123)", /forbidden/);
  refuse("SELECT 1", /not allowed/);
  refuse("WITH x AS (DELETE FROM log.ge_ct_gesys RETURNING 1) SELECT 1", /not allowed/);
  refuse("DO $$ BEGIN DELETE FROM log.ge_ct_gesys; END $$", /not allowed/);
  refuse("VACUUM log.ge_ct_gesys", /not allowed/);
  refuse("COPY log.ge_ct_gesys TO PROGRAM 'x'", /forbidden|not allowed/);
  refuse("CREATE EXTENSION dblink", /forbidden|not allowed/);
  refuse("CREATE INDEX CONCURRENTLY x ON insight.a (b)", /CONCURRENTLY/);
  refuse("CREATE INDEX ON insight.a (b)", /must name the index/);
  refuse("ALTER ROLE avantehs_admin SUPERUSER", /not allowed/);
  refuse("LOCK TABLE log.ge_ct_gesys", /not allowed/);
  refuse("\\i other.sql", /meta-command|not recognised/);
});

test("scans function bodies, including dynamic SQL", () => {
  refuse(`CREATE FUNCTION insight.f() RETURNS void LANGUAGE plpgsql AS $$ BEGIN DELETE FROM log.ge_ct_gesys; END $$`, /function body: DELETE FROM/);
  refuse(`CREATE FUNCTION insight.f() RETURNS void LANGUAGE plpgsql AS $$ BEGIN EXECUTE format('DROP TABLE log.%I', 'x'); END $$`, /function body: DROP TABLE/);
  refuse(`CREATE FUNCTION insight.f(q text) RETURNS void LANGUAGE plpgsql AS $$ BEGIN EXECUTE q; END $$`, /dynamic EXECUTE/);
  refuse(`CREATE FUNCTION insight.f() RETURNS void LANGUAGE plpgsql AS $$ BEGIN COMMIT; END $$`, /COMMIT/);
  refuse(`CREATE FUNCTION insight.f() RETURNS void LANGUAGE sql SECURITY DEFINER AS $$ SELECT 1 $$`, /SECURITY DEFINER/);
  refuse(`CREATE FUNCTION public.f() RETURNS void LANGUAGE sql AS $$ SELECT 1 $$`, /outside/);
  refuse(`CREATE FUNCTION insight.f() RETURNS void LANGUAGE plpgsql AS $$ BEGIN UPDATE public.systems SET x = 1; END $$`, /function body: UPDATE/);
  allow(`CREATE FUNCTION insight.f() RETURNS void LANGUAGE plpgsql AS $$ BEGIN
           INSERT INTO insight.a (x) VALUES (1) ON CONFLICT (x) DO UPDATE SET x = excluded.x;
           EXECUTE format('CREATE TABLE insight.%I PARTITION OF insight.p FOR VALUES FROM (%L) TO (%L)', 'p1', 1, 2);
           PERFORM 1 FROM insight.a FOR UPDATE;
         END $$`);
});

test("allows the expected insight / api.ge_ct_* forms", () => {
  allow("CREATE SCHEMA insight");
  allow("CREATE TABLE insight.a (x text PRIMARY KEY, y text REFERENCES insight.b (y) ON DELETE CASCADE)");
  allow("CREATE UNIQUE INDEX a_idx ON insight.a (x) WHERE x IS NOT NULL");
  allow("CREATE VIEW api.ge_ct_x_v AS SELECT * FROM insight.a");
  allow("DROP VIEW api.ge_ct_x_v");
  allow("DROP SCHEMA insight");
  allow("DELETE FROM insight.schema_migrations WHERE version = 2");
  allow("UPDATE insight.job_state SET watermark_id = 0");
  allow("ALTER SEQUENCE insight.s OWNED BY insight.t.id");
  allow("COMMENT ON COLUMN insight.a.x IS 'x'");
  allow("GRANT SELECT ON api.ge_ct_x_v TO some_reader");
  allow("GRANT SELECT, INSERT, UPDATE, DELETE ON insight.a, insight.b TO insight_writer");
  allow("REVOKE ALL ON insight.a, insight.b FROM insight_writer");
  allow("GRANT USAGE, SELECT ON SEQUENCE insight.s TO insight_writer");
  allow("GRANT USAGE ON SCHEMA insight TO insight_writer");
});

// Review F1 (Codex 2026-11-03): calls that run later, outside the migration.
test("refuses side-effecting or out-of-scope calls in views, defaults and bodies", () => {
  refuse("CREATE VIEW api.ge_ct_probe AS SELECT nextval('public.external_seq')", /only insight\.\* sequences/);
  refuse("CREATE VIEW api.ge_ct_probe AS SELECT public.write_to_log()", /outside insight\/pg_catalog/);
  refuse("CREATE VIEW api.ge_ct_probe AS SELECT x FROM insight.a WHERE log.fn(x)", /outside insight\/pg_catalog/);
  refuse("CREATE TABLE insight.t (x int DEFAULT public.fn())", /outside insight\/pg_catalog/);
  refuse("CREATE TABLE insight.t (x bigint DEFAULT nextval('log.some_seq'))", /only insight\.\* sequences/);
  refuse("CREATE VIEW api.ge_ct_probe AS SELECT setval('insight.s', 1)", /side-effecting/);
  refuse("CREATE VIEW api.ge_ct_probe AS SELECT pg_catalog.pg_advisory_lock(1)", /side-effecting/);
  refuse("CREATE VIEW api.ge_ct_probe AS SELECT nextval(some_var)", /literal sequence name/);
  refuse(`CREATE FUNCTION insight.f() RETURNS void LANGUAGE plpgsql AS $$ BEGIN PERFORM public.write_to_log(); END $$`, /outside insight\/pg_catalog/);
  refuse(`CREATE FUNCTION insight.f() RETURNS void LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_notify('c', 'x'); END $$`, /side-effecting/);
});

test("still allows in-scope calls and plain built-ins", () => {
  allow("CREATE TABLE insight.t (id bigint NOT NULL DEFAULT nextval('insight.t_id_seq'), at timestamptz DEFAULT now())");
  allow("CREATE VIEW api.ge_ct_x_v AS SELECT count(*), max(a.x), coalesce(a.y, 0), array_position(ARRAY['a','b']::text[], a.z) FROM insight.a a");
  allow("CREATE VIEW api.ge_ct_x_v AS SELECT pg_catalog.lower(a.z) FROM insight.a a");
  allow(`CREATE FUNCTION insight.f() RETURNS int LANGUAGE plpgsql AS $$ BEGIN RETURN insight.g(1); END $$`);
  allow("COMMENT ON FUNCTION insight.ensure_ge_ct_facts_partitions(timestamptz, timestamptz) IS 'x'");
  allow("CREATE TABLE insight.c (k text REFERENCES insight.metric_catalog (metric_key))");
});

