"use strict";
// node --test migrations/test   (no DB needed)
// 008: api.ge_ct_findings_v gets a source = 'ge_ct' filter (PLAN-CV-INSIGHTS.md §10.5 C3).
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { scanSql } = require("../lib/sqlscan");

const dir = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(dir, f), "utf8");
// the view's text from its CREATE VIEW to the end of the statement, whitespace collapsed
const view_of = (src) => {
  const m = src.match(/CREATE VIEW api\.ge_ct_findings_v AS([\s\S]*?);/);
  assert.ok(m, "CREATE VIEW api.ge_ct_findings_v");
  return m[1].replace(/\s+/g, " ").trim();
};
const comment_of = (src) => src.match(/COMMENT ON VIEW api\.ge_ct_findings_v IS\s*('(?:[^']|'')*');/)[1];

test("008 re-creates only api.ge_ct_findings_v: 005's columns, plus WHERE f.source = 'ge_ct'", () => {
  const src = read("008_ct_findings_view_source.sql");
  const up = scanSql(src);
  assert.deepStrictEqual(up.errors, []);
  assert.deepStrictEqual(up.creates.map((c) => c.name), ["api.ge_ct_findings_v"]);
  assert.deepStrictEqual(up.freshCreates, [], "dropped first in the same file");
  assert.deepStrictEqual(up.drops.map((d) => d.name), ["api.ge_ct_findings_v"]);
  assert.deepStrictEqual(up.netDrops, []);
  assert.deepStrictEqual(up.statements.map((s) => s.sql.replace(/\s+/g, " ").split(" ").slice(0, 3).join(" ")),
    ["DROP VIEW api.ge_ct_findings_v", "CREATE VIEW api.ge_ct_findings_v", "COMMENT ON VIEW"]);
  const v005 = view_of(read("005_phase4_findings.sql"));
  assert.strictEqual(view_of(src), `${v005} WHERE f.source = 'ge_ct'`);
  const code = src.replace(/--.*$/gm, "").replace(/'(?:[^']|'')*'/g, "''");
  assert.doesNotMatch(code, /\b(INSERT|UPDATE|DELETE|TRUNCATE|GRANT|REVOKE|ALTER)\b/);
});

test("008 down restores 005's view and comment exactly", () => {
  const src = read("008_ct_findings_view_source.down.sql");
  const down = scanSql(src);
  assert.deepStrictEqual(down.errors, []);
  assert.deepStrictEqual(down.creates.map((c) => c.name), ["api.ge_ct_findings_v"]);
  assert.deepStrictEqual(down.netDrops, []);
  const s005 = read("005_phase4_findings.sql");
  assert.strictEqual(view_of(src), view_of(s005));
  assert.strictEqual(comment_of(src), comment_of(s005));
});
