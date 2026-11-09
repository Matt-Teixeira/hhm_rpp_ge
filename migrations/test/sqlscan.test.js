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


test("drop-then-create in one file: freshCreates / netDrops for the runner's state checks", () => {
  const up = scanSql(`
    CREATE TABLE insight.k (x int);
    DROP VIEW api.ge_ct_v;
    CREATE VIEW api.ge_ct_v AS SELECT x FROM insight.k;`);
  assert.deepStrictEqual(up.errors, []);
  assert.deepStrictEqual(up.creates.map((c) => c.name), ["insight.k", "api.ge_ct_v"]);
  assert.deepStrictEqual(up.freshCreates.map((c) => c.name), ["insight.k"], "re-created view is exempt from the must-be-absent check");
  assert.deepStrictEqual(up.netDrops, [], "re-created view is not expected to be gone");
  const down = scanSql(`
    DROP VIEW api.ge_ct_v;
    CREATE VIEW api.ge_ct_v AS SELECT 1 AS x;
    DROP TABLE insight.k;`);
  assert.deepStrictEqual(down.netDrops.map((d) => d.name), ["insight.k"]);
  // a create that comes BEFORE a drop of the same object is still fresh
  const odd = scanSql(`CREATE TABLE insight.z (x int); DROP TABLE insight.z;`);
  assert.deepStrictEqual(odd.freshCreates.map((c) => c.name), ["insight.z"]);
  assert.deepStrictEqual(odd.netDrops.map((d) => d.name), ["insight.z"]);
});

test("functions never get the drop/re-create exemption (overloads share a name)", () => {
  // review PHASE3-004 F1: different overloads
  const r = scanSql("DROP FUNCTION insight.f(integer); CREATE FUNCTION insight.f(text) RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;");
  assert.deepStrictEqual(r.errors, []);
  assert.deepStrictEqual(r.freshCreates.map((c) => `${c.name}(${c.args})`), ["insight.f(text)"]);
  assert.deepStrictEqual(r.netDrops.map((d) => `${d.name}(${d.args})`), ["insight.f(integer)"]);
  // same signature: still not exempt (keeps the runner's pre-004 behaviour)
  const same = scanSql("DROP FUNCTION insight.g(integer); CREATE FUNCTION insight.g(integer) RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;");
  assert.strictEqual(same.freshCreates.length, 1);
  assert.strictEqual(same.netDrops.length, 1);
});

test("004 re-creates the api views, creates system_clock, and its down restores them", () => {
  const up = scanSql(fs.readFileSync(path.join(dir, "004_phase3_derive.sql"), "utf8"));
  assert.deepStrictEqual(up.errors, []);
  assert.deepStrictEqual(up.freshCreates.map((c) => c.name), ["insight.system_clock"]);
  assert.deepStrictEqual(up.netDrops, []);
  const down = scanSql(fs.readFileSync(path.join(dir, "004_phase3_derive.down.sql"), "utf8"));
  assert.deepStrictEqual(down.errors, []);
  assert.deepStrictEqual(down.netDrops.map((d) => d.name), ["insight.system_clock"]);
});

test("005 creates finding_catalog, re-creates the findings view, and its down drops the catalog", () => {
  const up = scanSql(fs.readFileSync(path.join(dir, "005_phase4_findings.sql"), "utf8"));
  assert.deepStrictEqual(up.errors, []);
  assert.deepStrictEqual(up.freshCreates.map((c) => c.name), ["insight.finding_catalog"]);
  assert.deepStrictEqual(up.netDrops, []);
  const down = scanSql(fs.readFileSync(path.join(dir, "005_phase4_findings.down.sql"), "utf8"));
  assert.deepStrictEqual(down.errors, []);
  assert.deepStrictEqual(down.netDrops.map((d) => d.name), ["insight.finding_catalog"]);
});

test("006 creates only the three viewer views (no table, grant or drop), and its down drops them", () => {
  const src = fs.readFileSync(path.join(dir, "006_phase6_viewer_views.sql"), "utf8");
  const up = scanSql(src);
  assert.deepStrictEqual(up.errors, []);
  assert.deepStrictEqual(up.freshCreates.map((c) => c.name).sort(), ["api.ge_ct_boots_v", "api.ge_ct_capabilities_v", "api.ge_ct_days_v"]);
  assert.deepStrictEqual(up.creates.map((c) => c.name).sort(), ["api.ge_ct_boots_v", "api.ge_ct_capabilities_v", "api.ge_ct_days_v"]);
  assert.deepStrictEqual(up.drops, []);
  assert.deepStrictEqual(up.statements.map((s) => s.sql.split(/\s+/).slice(0, 2).join(" ")).sort(),
    ["COMMENT ON", "COMMENT ON", "COMMENT ON", "CREATE VIEW", "CREATE VIEW", "CREATE VIEW"]);
  assert.doesNotMatch(src.replace(/--.*$/gm, ""), /\b(GRANT|REVOKE|ALTER|log\.|public\.)/i, "views only, insight.* sources only");
  const down = scanSql(fs.readFileSync(path.join(dir, "006_phase6_viewer_views.down.sql"), "utf8"));
  assert.deepStrictEqual(down.errors, []);
  assert.deepStrictEqual(down.netDrops.map((d) => d.name).sort(), ["api.ge_ct_boots_v", "api.ge_ct_capabilities_v", "api.ge_ct_days_v"]);
  assert.deepStrictEqual(down.creates, []);
});

test("006 days view keeps the findings DAYS_SQL day definition", () => {
  const norm = (s) => s.replace(/\bf\./g, "").replace(/\s+/g, " ");
  const v = norm(fs.readFileSync(path.join(dir, "006_phase6_viewer_views.sql"), "utf8"));
  const { DAYS_SQL } = require("../../insight/findings/load");
  const d = norm(DAYS_SQL);
  // same day key, same local-midnight expression, same tie-break order
  assert.ok(d.includes("host_local::date AS d"));
  assert.ok(v.includes("host_local::date AS local_day"));
  const mid = "host_datetime - (host_local - host_local::date::timestamp)";
  assert.ok(d.includes(mid) && v.includes(mid));
  assert.ok(d.includes("ORDER BY host_local::date, host_local, host_datetime"));
  assert.ok(v.includes("ORDER BY system_id, host_local::date, host_local, host_datetime"));
  assert.ok(d.includes("max(host_datetime) AS last_at") && v.includes("max(host_datetime) AS last_at"));
});

test("006 boots view reads clean like the findings loader (only attrs.clean = true is clean)", () => {
  const v = fs.readFileSync(path.join(dir, "006_phase6_viewer_views.sql"), "utf8").replace(/\s+/g, " ");
  const { load_inputs } = require("../../insight/findings/load");
  assert.ok(load_inputs.toString().includes("clean: e.clean === true"));
  assert.ok(v.includes("((f.attrs ->> 'clean')::boolean IS TRUE) AS clean"));
  assert.ok(v.includes("f.host_local::date AS local_day") && v.includes("WHERE f.metric_key = 'system.boot'"));
});

// ------------------------------------------------------------- 007 (GE CV)
test("runner scope covers api.ge_cv_* (007) and nothing else new in api", () => {
  allow("CREATE VIEW api.ge_cv_x_v AS SELECT * FROM insight.a");
  allow("DROP VIEW api.ge_cv_x_v");
  allow("COMMENT ON VIEW api.ge_cv_x_v IS 'x'");
  allow("CREATE VIEW api.ge_cv_x_v AS SELECT api.ge_cv_fn(a.x) FROM insight.a a");
  refuse("CREATE VIEW api.ge_mr_x_v AS SELECT 1", /outside the allowed scope/);
  refuse("CREATE VIEW api.ge_cvx AS SELECT 1", /outside the allowed scope/);
  refuse("CREATE VIEW api.ge_c_x AS SELECT 1", /outside the allowed scope/);
  refuse("DROP VIEW api.hca_odata", /outside the allowed scope/);
  refuse("CREATE VIEW api.ge_cv_probe AS SELECT api.other_fn(1)", /outside insight\/pg_catalog/);
  const { inScope } = require("../lib/catalog");
  assert.ok(inScope({ schema: "api", name: "ge_cv_daily_v" }));
  assert.ok(inScope({ schema: "api", name: "ge_ct_daily_v" }));
  assert.ok(!inScope({ schema: "api", name: "ge_mr_daily_v" }));
  assert.ok(!inScope({ schema: "api", name: "hca_odata" }));
  assert.ok(!inScope({ schema: "log", name: "ge_cv_syserror" }));
});

test("007 creates only new CV objects (no CT change, no drop), and its down drops exactly them", () => {
  const src = fs.readFileSync(path.join(dir, "007_cv_schema.sql"), "utf8");
  const code = src.replace(/--.*$/gm, "").replace(/'(?:[^']|'')*'/g, "''"); // comments and string literals out
  const up = scanSql(src);
  assert.deepStrictEqual(up.errors, []);
  const created = ["insight.ge_cv_facts_id_seq", "insight.ge_cv_facts", "insight.ge_cv_facts_sys_metric_time_idx", "insight.ge_cv_facts_sys_local_idx",
    "insight.ge_cv_facts_source_idx", "insight.ge_cv_daily", "insight.ge_cv_daily_metric_day_idx", "insight.ge_cv_codes",
    "api.ge_cv_daily_v", "api.ge_cv_capabilities_v", "api.ge_cv_codes_v", "api.ge_cv_findings_v", "api.ge_cv_system_summary_v"];
  assert.deepStrictEqual(up.freshCreates.map((c) => c.name).sort(), [...created].sort());
  assert.deepStrictEqual(up.creates.map((c) => c.name).sort(), [...created].sort(), "nothing re-created");
  assert.deepStrictEqual(up.drops, []);
  // Every statement targets a new ge_cv object: the only ALTER is the sequence's OWNED BY, grants name only new objects.
  for (const s of up.statements) {
    const head = s.sql.replace(/\s+/g, " ");
    if (/^ALTER /i.test(head)) assert.match(head, /^ALTER SEQUENCE insight\.ge_cv_facts_id_seq OWNED BY insight\.ge_cv_facts\.id$/);
    if (/^(GRANT|REVOKE) /i.test(head)) assert.doesNotMatch(head.replace(/insight\.ge_cv_\w+/g, ""), /insight\.|api\./, head);
    if (/^COMMENT ON /i.test(head)) assert.match(head, /^COMMENT ON (TABLE|VIEW|COLUMN) (insight|api)\.ge_cv_/);
  }
  assert.doesNotMatch(code, /\bge_ct_|\blog\.|\bpublic\.|\balert\./, "reads only insight.*; never names a CT object");
  assert.doesNotMatch(code.replace(/^(GRANT|REVOKE)\b[^;]*;/gm, ""), /\b(INSERT|UPDATE|DELETE|TRUNCATE)\b/,
    "no row writes (catalog rows come from the registry at stage start)");
  // Shared tables are referenced only as FK targets / view sources.
  for (const t of ["metric_catalog", "finding_catalog", "findings", "job_state"]) {
    for (const m of code.matchAll(new RegExp(String.raw`[^\n]*\binsight\.${t}\b[^\n]*`, "g"))) {
      assert.match(m[0], /REFERENCES insight\.metric_catalog|JOIN insight\.(metric_catalog|finding_catalog)|FROM insight\.findings/, m[0]);
    }
  }
  const down = scanSql(fs.readFileSync(path.join(dir, "007_cv_schema.down.sql"), "utf8"));
  assert.deepStrictEqual(down.errors, []);
  assert.deepStrictEqual(down.creates, []);
  assert.deepStrictEqual(down.netDrops.map((d) => d.name).sort(),
    ["api.ge_cv_capabilities_v", "api.ge_cv_codes_v", "api.ge_cv_daily_v", "api.ge_cv_findings_v", "api.ge_cv_system_summary_v",
      "insight.ge_cv_codes", "insight.ge_cv_daily", "insight.ge_cv_facts"]);
});

test("007 CV views and tables keep CV rows apart from CT ones", () => {
  const v = fs.readFileSync(path.join(dir, "007_cv_schema.sql"), "utf8").replace(/\s+/g, " ");
  // findings: only source ge_cv, in the findings view and in every summary subquery
  assert.ok(v.includes("JOIN insight.finding_catalog c ON c.finding_key = f.finding_key WHERE f.source = 'ge_cv';"));
  assert.strictEqual((v.match(/FROM insight\.findings f WHERE f\.(system_id = s\.system_id AND f\.)?source = 'ge_cv'/g) || []).length, 3);
  assert.doesNotMatch(v, /source = 'ge_ct'/);
  // facts and daily accept only cv.* metric keys; code labels join cv.error only
  assert.ok(v.includes("CONSTRAINT ge_cv_facts_cv_metric CHECK (metric_key LIKE 'cv.%')"));
  assert.ok(v.includes("CONSTRAINT ge_cv_daily_cv_metric CHECK (metric_key LIKE 'cv.%')"));
  assert.ok(v.includes("LEFT JOIN insight.ge_cv_codes k ON d.metric_key = 'cv.error' AND k.errorcode::text = d.dim"));
  // natural key = the source row identity proven unique (plan §6) + metric
  assert.ok(v.includes("CONSTRAINT ge_cv_facts_natural_key UNIQUE (system_id, host_datetime, sequencenumber, metric_key)"));
});
