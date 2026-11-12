"use strict";
// node insight/test/cv_scope.test.js   (no DB needed)
// C1 (PLAN-CV-INSIGHTS.md §7.4): the three CT verifiers count only CT catalog
// rows. GE CV writes cv.* rows to insight.metric_catalog and cv_* rows to
// insight.finding_catalog; the CT checks must ignore those and still fail on a
// wrong CT catalog.
//
// The fake DB below holds the catalog tables in memory and applies every
// filter it finds in the verifier's own SQL: `<column> NOT LIKE '<pattern>'`
// with PostgreSQL's LIKE rules (% any run, _ one character, backslash
// escapes), and `left(<column>, n) <> '<prefix>'`. So a filter that is
// missing, or one that also drops a CT key such as 'cvx_...' or 'cva', fails
// here as it would in PostgreSQL.
//
// No filter may contain a backslash: how PostgreSQL reads a backslash in a
// string literal depends on standard_conforming_strings (review CV-C1 P2).
//
// CT code must not load insight/cv (cv.test.js "isolation"), so the CV rows
// here are copies of the CV registry's keys (as of 2026-11-10); cv.test.js
// checks the real CV registries against these filters.
const test = require("node:test");
const assert = require("node:assert");
const { rules } = require("../rules/ge_ct");
const { derived_rules, DERIVED_KEYS } = require("../rules/ge_ct_derived");
const { catalog_rows: metric_catalog_rows } = require("../rules/engine");
const { catalog_rows: finding_catalog_rows } = require("../findings/rules");
const facts = require("../verify_facts");
const derive_verify = require("../derive/verify");
const findings_verify = require("../findings/verify");

// ------------------------------------------------------------------ fake DB
function like_re(pat) {
  let re = "";
  for (let i = 0; i < pat.length; i++) {
    const c = pat[i];
    if (c === "\\") re += pat[++i].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    else if (c === "%") re += ".*";
    else if (c === "_") re += ".";
    else re += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`, "s");
}
const lit = (x) => x.replace(/''/g, "'");
// every exclusion on col in a piece of SQL, as "drop this key?" predicates
function excluded_by(sql, col) {
  const like = [...sql.matchAll(new RegExp(`\\b${col} NOT LIKE '((?:[^']|'')*)'`, "g"))].map((m) => like_re(lit(m[1])));
  const left = [...sql.matchAll(new RegExp(`\\bleft\\(${col}, (\\d+)\\) <> '((?:[^']|'')*)'`, "g"))].map((m) => ({ n: Number(m[1]), p: lit(m[2]) }));
  return [...like.map((re) => (k) => re.test(k)), ...left.map(({ n, p }) => (k) => k.slice(0, n) === p)];
}
const keep = (rows, sql, col) => rows.filter((r) => excluded_by(sql, col).every((drop) => !drop(r[col])));

function fake_db({ metric = [], finding = [] }) {
  return {
    async one(sql, p) {
      if (sql === facts.CATALOG_SQL) {
        const rows = keep(metric, sql, "metric_key");
        return { n: rows.length, derived: rows.filter((r) => p[0].includes(r.metric_key)).length };
      }
      if (sql === derive_verify.INVARIANTS_SQL) {
        // two subselects: the catalog count (with its filter) and the derived-key count
        const cat_sql = sql.match(/\(SELECT count\(\*\) FROM insight\.metric_catalog[^)]*\)::int AS catalog/)[0];
        return { offset_breaks: 0, catalog: keep(metric, cat_sql, "metric_key").length,
          derived_in_catalog: metric.filter((r) => p[1].includes(r.metric_key)).length };
      }
      throw new Error(`unexpected one(): ${sql.slice(0, 80)}`);
    },
    async any(sql) {
      if (sql === findings_verify.CATALOG_SQL) return keep(finding, sql, "finding_key");
      if (/insight\.metric_catalog|insight\.finding_catalog/.test(sql)) throw new Error(`unexpected catalog read: ${sql.slice(0, 80)}`);
      return []; // facts, the reconcile SQL, findings SQL, last data day: empty
    },
  };
}

const CT_METRIC = [...metric_catalog_rows(rules), ...metric_catalog_rows(derived_rules)];
const CV_METRIC = ["cv.error", "cv.detector_com_error", "cv.positioner_collision", "cv.anticollision_error", "cv.table_encoder_failure",
  "cv.pib_com_loss", "cv.emergency_backout", "cv.dose_export_rejected", "cv.worklist_query_failed"].map((metric_key) => ({ metric_key }));
const CT_FINDING = finding_catalog_rows();
const CV_FINDING = ["cv_error_storm", "cv_detector_com_errors", "cv_anticollision_burst", "cv_table_encoder_fault", "cv_pib_com_loss"]
  .map((finding_key) => ({ finding_key, label: `GE CV ${finding_key}`, description: "CV", category: "reliability", default_severity: "medium",
    rule_version: 1, customer_visible: false }));
const quiet = () => {};

const run_facts = async (metric) => (await facts.verify_facts(fake_db({ metric }), 100)).ok;
const run_invariants = async (metric) => (await derive_verify.check_invariants(fake_db({ metric }))).ok;
const run_findings = async (finding) => {
  const r = await findings_verify.run_verify(fake_db({ finding }), { today: "2026-11-10", rows: [], log: quiet });
  return r.results.find((x) => x.name === "catalog = registry").ok;
};

// ------------------------------------------------------------------ tests
test("fake LIKE follows PostgreSQL: % and _ are wildcards, \\_ is a literal underscore", () => {
  assert.ok(like_re("cv.%").test("cv.error") && !like_re("cv.%").test("cvx.error") && !like_re("cv.%").test("cv_error"));
  assert.ok(like_re("cv\\_%").test("cv_error_storm"));
  assert.ok(!like_re("cv\\_%").test("cvx_error"), "escaped: only a real underscore");
  assert.ok(like_re("cv_%").test("cvx_error"), "unescaped _ would match any character");
  // the prefix form drops exactly the cv_ keys
  const drop = excluded_by("WHERE left(finding_key, 3) <> 'cv_'", "finding_key")[0];
  assert.ok(drop("cv_error_storm") && !drop("cva") && !drop("cvx_error") && !drop("cv") && !drop("tube_replaced"));
});

test("C1: the three CT verifiers declare CV_AWARE (the GE CV --apply interlock reads it)", () => {
  for (const m of [facts, derive_verify, findings_verify]) assert.strictEqual(m.CV_AWARE, true);
});

test("the filters, as the SQL text sees them", () => {
  assert.match(facts.CATALOG_SQL, /FROM insight\.metric_catalog\s+WHERE metric_key NOT LIKE 'cv\.%'/);
  assert.match(derive_verify.INVARIANTS_SQL, /\(SELECT count\(\*\) FROM insight\.metric_catalog WHERE metric_key NOT LIKE 'cv\.%'\)::int AS catalog/);
  assert.ok(findings_verify.CATALOG_SQL.endsWith("FROM insight.finding_catalog WHERE left(finding_key, 3) <> 'cv_'"));
  // no backslash anywhere: the result can't depend on standard_conforming_strings (review CV-C1 P2)
  for (const s of [facts.CATALOG_SQL, derive_verify.INVARIANTS_SQL, findings_verify.CATALOG_SQL]) assert.ok(!s.includes("\\"), s.slice(0, 60));
  // no CT key starts with "cv", so the filters can never drop a CT row
  assert.ok(!CT_METRIC.some((r) => /^cv/.test(r.metric_key)) && !CT_FINDING.some((r) => /^cv/.test(r.finding_key)));
});

test("verify_facts: CT catalog passes with or without cv.* rows; a wrong CT catalog fails", async () => {
  assert.strictEqual(await run_facts(CT_METRIC), true);
  assert.strictEqual(await run_facts([...CT_METRIC, ...CV_METRIC]), true);
  // before derive has run: per-row rules only, still exact
  const per_row = CT_METRIC.filter((r) => !DERIVED_KEYS.includes(r.metric_key));
  assert.strictEqual(await run_facts([...per_row, ...CV_METRIC]), true);
  // wrong CT catalog, with CV rows present
  assert.strictEqual(await run_facts([...CT_METRIC.slice(1), ...CV_METRIC]), false, "a CT row missing");
  assert.strictEqual(await run_facts([...CT_METRIC, { metric_key: "tube.extra_metric" }, ...CV_METRIC]), false, "an extra CT row");
  assert.strictEqual(await run_facts([...CT_METRIC, { metric_key: "cvx.not_cv" }]), false, "cvx.* is not CV");
  assert.strictEqual(await run_facts([...per_row.slice(1), CT_METRIC.find((r) => r.metric_key === DERIVED_KEYS[0]), ...CV_METRIC]), false, "one derived row only");
});

test("verify-derive invariants: CT catalog passes with or without cv.* rows; a wrong CT catalog fails", async () => {
  assert.strictEqual(await run_invariants(CT_METRIC), true);
  assert.strictEqual(await run_invariants([...CT_METRIC, ...CV_METRIC]), true);
  assert.strictEqual(await run_invariants([...CT_METRIC.slice(1), ...CV_METRIC]), false, "a CT row missing");
  assert.strictEqual(await run_invariants([...CT_METRIC, { metric_key: "tube.extra_metric" }, ...CV_METRIC]), false, "an extra CT row");
  assert.strictEqual(await run_invariants([...CT_METRIC.filter((r) => r.metric_key !== DERIVED_KEYS[0]), ...CV_METRIC]), false, "a derived row missing");
  const out = await derive_verify.check_invariants(fake_db({ metric: [...CT_METRIC, ...CV_METRIC] }));
  assert.match(out.lines[1], new RegExp(`catalog rows: ${CT_METRIC.length} \\(expected ${CT_METRIC.length}:`));
});

test("verify-findings catalog = registry: passes with or without cv_* rows; a wrong CT row fails", async () => {
  assert.strictEqual(await run_findings(CT_FINDING), true);
  assert.strictEqual(await run_findings([...CT_FINDING, ...CV_FINDING]), true);
  const relabel = CT_FINDING.map((r, i) => (i === 0 ? { ...r, label: `${r.label} (changed)` } : r));
  assert.strictEqual(await run_findings([...relabel, ...CV_FINDING]), false, "a CT row differs");
  assert.strictEqual(await run_findings([...CT_FINDING.slice(1), ...CV_FINDING]), false, "a CT row missing");
  // a CT-looking key that starts with "cv" but not "cv_" is still CT: an unescaped 'cv_%' would hide it
  const cvx = { ...CT_FINDING[0], finding_key: "cvx_unknown" };
  assert.strictEqual(await run_findings([...CT_FINDING, cvx, ...CV_FINDING]), false, "cvx_* is not CV");
});

test("unchanged when no CV rows exist: the same CT inputs give the same results as the filter-free count", async () => {
  // the pre-C1 statements (no filter) on CT-only data agree with the C1 statements
  const old_facts = facts.CATALOG_SQL.replace(/\s+WHERE metric_key NOT LIKE 'cv\.%'/, "");
  assert.notStrictEqual(old_facts, facts.CATALOG_SQL);
  for (const metric of [CT_METRIC, CT_METRIC.slice(1)]) {
    assert.deepStrictEqual(keep(metric, old_facts, "metric_key"), keep(metric, facts.CATALOG_SQL, "metric_key"));
  }
  // and with CV rows the pre-C1 count is what failed
  assert.strictEqual(keep([...CT_METRIC, ...CV_METRIC], old_facts, "metric_key").length, CT_METRIC.length + CV_METRIC.length);
});
