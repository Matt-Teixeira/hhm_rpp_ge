#!/usr/bin/env node
"use strict";
// Builds the GE CV findings test fixtures (insight/cv/__fixtures__/findings/)
// from a database that holds ge_cv_facts and ge_cv_daily. READ-ONLY.
//   inputs.json   per system, what findings/load.js reads (data days with
//                 their midnight / last instants; daily cells of the series
//                 the rules use: codes, dims and counts only, no debug text)
//   expected.json the findings the independent SQL (findings/verify_sql.js)
//                 derives as of `today`
// The test (test/findings.test.js) replays inputs.json with the JS rules
// and must equal expected.json.
//
//   node insight/cv/tools/build_findings_fixtures.js YYYY-MM-DD
// (or call build(db, today) with any read-only connection.)
// Nothing in the GE CT run loads this file.
const fs = require("fs");
const path = require("path");
const { load_inputs } = require("../findings/load");
const { FINDINGS_SQL } = require("../findings/verify_sql");

const DIR = path.join(__dirname, "..", "__fixtures__", "findings");
const iso = (t) => (t === null || t === undefined ? null : new Date(t).toISOString());

async function build(db, today) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) throw new Error(`bad today ${today}`);
  if ((await db.one("SHOW default_transaction_read_only")).default_transaction_read_only !== "on") throw new Error("not a read-only session");
  const systems = (await db.any("SELECT DISTINCT system_id FROM insight.ge_cv_daily ORDER BY 1")).map((r) => r.system_id);
  const inputs = [];
  for (const s of systems) {
    const x = await load_inputs(db, s);
    inputs.push({ system_id: s, days: x.days.map((d) => ({ day: d.day, start_at: iso(d.start_at), last_at: iso(d.last_at) })),
      daily: x.daily.map((c) => ({ day: c.day, m: c.m, dim: c.dim, n: c.n })).sort((a, b) => (a.day + a.m + a.dim < b.day + b.m + b.dim ? -1 : 1)) });
  }
  const expected = (await db.any(FINDINGS_SQL, [today])).map((r) => ({ ...r, opened_at: iso(r.opened_at), resolved_at: iso(r.resolved_at),
    window_start: iso(r.window_start), window_end: iso(r.window_end), last_evaluated: iso(r.last_evaluated) }));
  return { today, inputs, expected };
}

function write(fx) {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(path.join(DIR, "inputs.json"), JSON.stringify({ today: fx.today, systems: fx.inputs }));
  fs.writeFileSync(path.join(DIR, "expected.json"), JSON.stringify({ today: fx.today, findings: fx.expected }, null, 1) + "\n");
}

async function main() {
  const today = process.argv[2];
  const { connect } = require("../../db");
  const db = connect("readonly", { applicationName: "insight_cv_fixtures" });
  try {
    const fx = await build(db, today);
    write(fx);
    console.log(`${fx.inputs.length} systems, ${fx.expected.length} findings as of ${today} -> ${DIR}`);
  } finally { db.$pool.end(); }
}

if (require.main === module) main().catch((e) => { console.error(`FAILED: ${e.message}`); process.exitCode = 2; });

module.exports = { build, write, DIR };
