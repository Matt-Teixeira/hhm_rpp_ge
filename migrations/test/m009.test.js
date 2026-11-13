"use strict";
// node --test migrations/test   (no DB needed)
// 009: GE MRI schema (PLAN-MRI-INSIGHTS.md §6). New insight objects only.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { scanSql } = require("../lib/sqlscan");

const dir = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(dir, f), "utf8");
const UP = read("009_mri_schema.sql");
const DOWN = read("009_mri_schema.down.sql");
const flat = (s) => s.replace(/\s+/g, " ");
const code_of = (src) => src.replace(/--.*$/gm, "").replace(/'(?:[^']|'')*'/g, "''"); // comments and string literals out

// Monthly partition names and bounds, 2025-05 .. 2028-12.
const MONTHS = [];
for (let y = 2025, m = 5; y < 2029; m === 12 ? (y++, m = 1) : m++) MONTHS.push([y, m]);
const pad = (m) => String(m).padStart(2, "0");
const next = ([y, m]) => (m === 12 ? [y + 1, 1] : [y, m + 1]);

const TABLES = ["insight.ge_mri_facts", "insight.ge_mri_daily", "insight.ge_mri_codes"];
const CREATED = ["insight.ge_mri_facts_id_seq", "insight.ge_mri_facts", "insight.ge_mri_facts_sys_metric_local_idx", "insight.ge_mri_facts_source_idx",
  ...MONTHS.map(([y, m]) => `insight.ge_mri_facts_${y}_${pad(m)}`),
  "insight.ge_mri_daily", "insight.ge_mri_daily_metric_day_idx", "insight.ge_mri_codes"];

test("009 creates exactly its new MRI objects (no drop, no re-create, nothing outside insight.ge_mri_*)", () => {
  const up = scanSql(UP, { filename: "009_mri_schema.sql" });
  assert.deepStrictEqual(up.errors, []);
  assert.strictEqual(CREATED.length, 51);
  assert.deepStrictEqual(up.freshCreates.map((c) => c.name).sort(), [...CREATED].sort());
  assert.deepStrictEqual(up.creates.map((c) => c.name).sort(), [...CREATED].sort(), "nothing re-created");
  assert.deepStrictEqual(up.drops, []);
  for (const s of up.statements) {
    const head = flat(s.sql);
    if (/^ALTER /i.test(head)) assert.match(head, /^ALTER SEQUENCE insight\.ge_mri_facts_id_seq OWNED BY insight\.ge_mri_facts\.id$/);
    if (/^(GRANT|REVOKE) /i.test(head)) {
      assert.doesNotMatch(head.replace(/insight\.ge_mri_\w+/g, ""), /insight\.|api\./, head);
      assert.match(head, / TO insight_writer$/, head);
    }
    if (/^COMMENT ON /i.test(head)) assert.match(head, /^COMMENT ON (TABLE|COLUMN) insight\.ge_mri_/);
    if (/^CREATE /i.test(head)) assert.match(head, /^CREATE (SEQUENCE|TABLE|INDEX \w+ ON) insight\.ge_mri_/, head);
  }
  const code = code_of(UP);
  assert.doesNotMatch(code, /\bge_ct_|\bge_cv_|\blog\.|\bpublic\.|\balert\.|\bapi\./, "never names a CT, CV, log, public, alert or api object");
  assert.doesNotMatch(code.replace(/^(GRANT|REVOKE)\b[^;]*;/gm, ""), /\b(INSERT|UPDATE|DELETE|TRUNCATE)\b/,
    "no row writes (mri.* catalog rows come from the MRI registry, as CV: §5.3 Q-M9)");
  assert.doesNotMatch(code, /\bCREATE (OR REPLACE )?(VIEW|FUNCTION)\b/, "no views or functions in 009");
  // Shared tables are referenced only as FK targets.
  for (const t of ["metric_catalog", "finding_catalog", "findings", "job_state", "system_capabilities"]) {
    for (const m of code.matchAll(new RegExp(String.raw`[^\n]*\binsight\.${t}\b[^\n]*`, "g"))) {
      assert.match(m[0], /REFERENCES insight\.metric_catalog \(metric_key\)/, m[0]);
    }
  }
});

test("009 facts: monthly partitions on the device wall clock, 2025-05 to 2028-12, contiguous, no default", () => {
  const f = flat(UP);
  assert.ok(f.includes(") PARTITION BY RANGE (host_local);"));
  const parts = [...UP.matchAll(/CREATE TABLE insight\.(ge_mri_facts_\d{4}_\d{2}) PARTITION OF insight\.ge_mri_facts\s+FOR VALUES FROM \('([^']+)'\) TO \('([^']+)'\);/g)];
  assert.strictEqual(parts.length, MONTHS.length);
  parts.forEach((p, i) => {
    const [y, m] = MONTHS[i];
    const [ny, nm] = next(MONTHS[i]);
    assert.strictEqual(p[1], `ge_mri_facts_${y}_${pad(m)}`);
    assert.strictEqual(p[2], `${y}-${pad(m)}-01 00:00:00`, "timestamp bounds: device wall clock, no zone");
    assert.strictEqual(p[3], `${ny}-${pad(nm)}-01 00:00:00`);
  });
  assert.doesNotMatch(f, /\bDEFAULT PARTITION\b|PARTITION OF insight\.ge_mri_facts DEFAULT/);
});

test("009 keys: the CT natural key + metric, host_local tied to epoch, and only mri.* metric keys", () => {
  const f = flat(UP);
  assert.ok(f.includes("CONSTRAINT ge_mri_facts_natural_key UNIQUE (system_id, epoch, record_number_concurrent, metric_key, host_local)"));
  assert.ok(f.includes("PRIMARY KEY (id, host_local)"));
  // host_local is in the key only as the partition column; it is a function of epoch, so the key is the natural key + metric
  assert.ok(f.includes("CONSTRAINT ge_mri_facts_host_local_epoch CHECK (host_local = timestamp '1970-01-01 00:00:00' + epoch * interval '1 second')"));
  // CT (ge_ct.*-style) and CV (cv.*) keys are refused by both tables
  assert.ok(f.includes("CONSTRAINT ge_mri_facts_mri_metric CHECK (metric_key LIKE 'mri.%')"));
  assert.ok(f.includes("CONSTRAINT ge_mri_daily_mri_metric CHECK (metric_key LIKE 'mri.%')"));
  assert.strictEqual((f.match(/LIKE 'mri\.%'/g) || []).length, 2);
  assert.ok(f.includes("PRIMARY KEY (system_id, local_day, metric_key, dim)"));
  assert.ok(f.includes("CHECK (first_at::date = local_day AND last_at::date = local_day)"));
  // ge_mri_codes: the six reviewed groups of PLAN-MRI-INSIGHTS-CODES.md; NULL = not yet reviewed
  assert.ok(f.includes("category text CHECK (category IN ('utilization','reliability','hardware','service','inventory','noise'))"));
  // no message text column anywhere (messages carry host names, AE titles, operator free text)
  assert.doesNotMatch(code_of(UP), /\bmessage\s+text\b|\bsample_message\b/);
});

test("009 grants: DML on the three tables and the sequence to insight_writer only; down revokes exactly them", () => {
  const grants = [...UP.matchAll(/^GRANT [^;]+;/gm)].map((m) => flat(m[0]));
  assert.deepStrictEqual(grants, [
    "GRANT SELECT, INSERT, UPDATE, DELETE ON insight.ge_mri_facts, insight.ge_mri_daily, insight.ge_mri_codes TO insight_writer;",
    "GRANT USAGE, SELECT ON SEQUENCE insight.ge_mri_facts_id_seq TO insight_writer;",
  ]);
  const revokes = [...DOWN.matchAll(/^REVOKE [^;]+;/gm)].map((m) => flat(m[0]));
  assert.deepStrictEqual(revokes.sort(), grants.map((g) => g.replace(/^GRANT/, "REVOKE").replace(/ TO insight_writer;$/, " FROM insight_writer;")).sort());
});

test("009 down drops exactly the three MRI tables (partitions and sequence with them), no CASCADE", () => {
  const down = scanSql(DOWN, { filename: "009_mri_schema.down.sql" });
  assert.deepStrictEqual(down.errors, []);
  assert.deepStrictEqual(down.creates, []);
  assert.deepStrictEqual(down.netDrops.map((d) => d.name).sort(), [...TABLES].sort());
  const code = code_of(DOWN);
  assert.doesNotMatch(code, /\bCASCADE\b/);
  assert.doesNotMatch(code, /\bge_ct_|\bge_cv_|\bmetric_catalog\b|\bfindings\b|\bjob_state\b|\bapi\./);
  // children before the parent they reference (none here, but order kept: codes, daily, facts)
  assert.deepStrictEqual([...DOWN.matchAll(/^DROP TABLE (insight\.\w+);/gm)].map((m) => m[1]), ["insight.ge_mri_codes", "insight.ge_mri_daily", "insight.ge_mri_facts"]);
});

test("001-008 are unchanged: the checksums applied on prod (insight.schema_migrations, read 2026-11-13)", () => {
  const sha = (f) => crypto.createHash("sha256").update(read(f), "utf8").digest("hex");
  const APPLIED = {
    "001_insight_schema": ["b357ecc595ac864a3f1369ae92482f916437b10bdd2e327c6971b10aa6f4aed4", "cff57eac1b9261aae604ce33be77e75b19b2ea889cb13ef0cb7f092080cf4db5"],
    "002_api_views": ["b1aca4af3253463f2d87b314bd196c117c334b672703b26116e327fb6c6a2640", "8601dc5433614e22b18a75b231739a59c6619c2255044841c688d4b02c457947"],
    "003_phase2_writer_and_wallclock": ["98f5fc6c4b25fda65f98a3c6d99e65beb833f2672864ae0a88176f32527525a1", "291b44493fc87c517e64631d3a2ec1f6363d38cea99799f5b91656f04a023e9f"],
    "004_phase3_derive": ["0e4ed5f951f887b582c078e17b22cb0913f86c76b59d84e4793d9115932d7df5", "a486e26a1c7901827d8471895042b25407724ec5fa79e97f4e851056958cc601"],
    "005_phase4_findings": ["a009e418053038d54744ac508b25df8f853c2c7661ee17ef5727c56e35853261", "d3c324a7a51bd4f2d5c9da8054fcffeb01d6e13571dddda78fed8bd7d8a372b6"],
    "006_phase6_viewer_views": ["6ca7b018f76a2d76576c7be63287b39e50b5fdd17d1a3ce4f1e6f080ec6f6260", "61455b76efce56221af359cf461619e2279b948c286b89ed7be069ddecfb70c0"],
    "007_cv_schema": ["8fa7f2b834c5c01072ce8c58fa1bc246d3b8ce6dc8148be3e7e403369d234075", "c6b36d0352c35104de4be190b424c5bd6bb3d03ecc53c15db59c8b15f1e2b5d8"],
    "008_ct_findings_view_source": ["40eeee9af2dc9f1dadbf318058fccc6f7d3fd08e3222d3ec368127a57d58545e", "3896a2638200319b49b975b21a523c89b2cb0177952d1f14f7d27b196ea77a59"],
  };
  for (const [base, [up, down]] of Object.entries(APPLIED)) {
    assert.strictEqual(sha(base + ".sql"), up, base);
    assert.strictEqual(sha(base + ".down.sql"), down, base + " down");
  }
  const versions = fs.readdirSync(dir).filter((f) => /^\d{3}_.*\.sql$/.test(f) && !f.endsWith(".down.sql")).map((f) => f.slice(0, 3)).sort();
  assert.deepStrictEqual(versions, ["001", "002", "003", "004", "005", "006", "007", "008", "009"], "009 is the only new migration");
});

test("runner scope is unchanged by MRI: insight.* allowed, api.ge_mri_* still refused (views come with MRI-6)", () => {
  assert.deepStrictEqual(scanSql("CREATE TABLE insight.ge_mri_x (a int)").errors, []);
  assert.ok(!scanSql("CREATE VIEW api.ge_mri_x_v AS SELECT 1").ok);
  const { inScope } = require("../lib/catalog");
  assert.ok(inScope({ schema: "insight", name: "ge_mri_facts" }));
  assert.ok(!inScope({ schema: "api", name: "ge_mri_daily_v" }));
  assert.ok(!inScope({ schema: "log", name: "ge_mri_gesys" }));
});
