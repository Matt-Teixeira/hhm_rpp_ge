"use strict";
// node insight/test/load.test.js   (no DB needed)
const test = require("node:test");
const assert = require("node:assert");
const { dedupe_facts, upsert_statements, catalog_statement, natural_key, CHUNK } = require("../load");
const { rules } = require("../rules/ge_ct");

const fact = (o = {}) => ({
  system_id: "SME1", epoch: 1793497918, record_number_concurrent: 0, metric_key: "env.plenum_temp",
  host_datetime: new Date("2026-11-01T06:51:58Z"), host_local: "2026-11-01T01:51:58",
  value_num: 26.24, value_text: "Center Sensor", exam_no: null, attrs: { left: 25.5 },
  source_id: 100, source_capture_datetime: new Date("2026-11-01T07:18:33Z"), rule_version: 1, ...o,
});

test("dedupe keeps the first fact per natural key and counts collisions", () => {
  const { unique, collisions } = dedupe_facts([fact({ source_id: 1 }), fact({ source_id: 2, value_num: 26.5 }), fact({ metric_key: "error.ermes", source_id: 3 })]);
  assert.strictEqual(collisions, 1);
  assert.deepStrictEqual(unique.map((f) => f.source_id), [1, 3]);
  // host_datetime as Date or ISO string gives the same key
  assert.strictEqual(natural_key(fact()), natural_key(fact({ host_datetime: "2026-11-01T06:51:58.000Z" })));
});

test("upsert SQL: version-gated ON CONFLICT, SQL NULL attrs, typed casts, chunking", () => {
  const [q] = upsert_statements([fact(), fact({ record_number_concurrent: 1, attrs: null, value_num: null })]);
  // wrapped in the touched-days CTE (pending.js): the insert is the CTE body
  assert.match(q, /^\s*WITH up AS \(insert into "insight"\."ge_ct_facts"/i);
  assert.match(q, /ON CONFLICT ON CONSTRAINT ge_ct_facts_natural_key DO UPDATE SET/);
  assert.match(q, /WHERE EXCLUDED\.rule_version > ge_ct_facts\.rule_version\s*RETURNING system_id, host_datetime, host_local\)/);
  assert.match(q, /'\{"left":25\.5\}'::jsonb/);
  assert.match(q, /null::jsonb/);
  assert.ok(!/'null'::jsonb/.test(q), "absent attrs must be SQL NULL, not JSON null");
  assert.match(q, /'2026-11-01T01:51:58'::timestamp/);
  const many = Array.from({ length: CHUNK * 2 + 1 }, (_, i) => fact({ record_number_concurrent: i }));
  assert.strictEqual(upsert_statements(many).length, 3);
  assert.deepStrictEqual(upsert_statements([]), []);
});

test("catalog statement covers every rule and only updates on change", () => {
  const q = catalog_statement(rules);
  for (const r of rules) assert.ok(q.includes(`'${r.key}'`), r.key);
  assert.match(q, /ON CONFLICT \(metric_key\) DO UPDATE SET/);
  assert.match(q, /IS DISTINCT FROM/);
});
