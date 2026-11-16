#!/usr/bin/env node
"use strict";
// Builds the GE MRI findings test fixtures (insight/mri/__fixtures__/findings/)
// from a database that holds ge_mri_facts, ge_mri_daily and ge_mri_codes.
// READ-ONLY.
//   inputs.json   per system, what findings/load.js reads, as compact
//                 arrays (expand() turns them back): data days with
//                 their midnight / last instants; daily cells (codes, dims,
//                 counts and scan sums only); restart events and process
//                 deaths (device times, kinds, process names). mri.error
//                 cells are kept only for the codes a rule reads (rule 10's
//                 residual codes and 2256925); the others change no output.
//   expected.json the findings the independent SQL (findings/verify_sql.js)
//                 derives as of `today`, from the whole database.
// The test (test/findings.test.js) replays inputs.json with the JS rules
// and must equal expected.json. No message text, host name, AE title, IP or
// serial is read.
//
//   node insight/mri/tools/build_findings_fixtures.js YYYY-MM-DD
// (or call build(db, today) with any read-only connection.)
// Nothing in the GE CT or CV run loads this file.
const fs = require("fs");
const path = require("path");
const { load_inputs } = require("../findings/load");
const { in_residual, TPS_STARTUP_CODE } = require("../findings/context");
const { FINDINGS_SQL } = require("../findings/verify_sql");

const DIR = path.join(__dirname, "..", "__fixtures__", "findings");
const iso = (t) => (t === null || t === undefined ? null : new Date(t).toISOString());
const keep = (c) => c.m !== "mri.error" || c.dim === TPS_STARTUP_CODE || in_residual(c.dim);

async function build(db, today) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) throw new Error(`bad today ${today}`);
  if ((await db.one("SHOW default_transaction_read_only")).default_transaction_read_only !== "on") throw new Error("not a read-only session");
  const systems = (await db.any("SELECT DISTINCT system_id FROM insight.ge_mri_daily ORDER BY 1")).map((r) => r.system_id);
  const inputs = [];
  for (const s of systems) {
    const x = await load_inputs(db, s);
    inputs.push({
      system_id: s,
      days: x.days.map((d) => [d.day, iso(d.start_at), iso(d.last_at)]),
      daily: x.daily.filter(keep).sort((a, b) => (a.day + a.m + a.dim < b.day + b.m + b.dim ? -1 : 1))
        .map((c) => [c.day, c.m.replace(/^mri\./, ""), c.dim, c.n, ...(c.m.startsWith("mri.scans") ? [Number(c.v)] : [])]),
      events: x.events.map((e) => [e.at, e.kind]),
      deaths: x.deaths.map((e) => [e.at, e.process]),
    });
  }
  const expected = (await db.any(FINDINGS_SQL, [today])).map((r) => ({ ...r, opened_at: iso(r.opened_at), resolved_at: iso(r.resolved_at),
    window_start: iso(r.window_start), window_end: iso(r.window_end), last_evaluated: iso(r.last_evaluated) }));
  return { today, inputs, expected };
}

// The compact form back to load_inputs()'s shape.
function expand(sys) {
  return {
    system_id: sys.system_id,
    days: sys.days.map(([day, start_at, last_at]) => ({ day, start_at, last_at })),
    daily: sys.daily.map(([day, m, dim, n, v]) => ({ day, m: `mri.${m}`, dim, n, v: v === undefined ? null : v })),
    events: sys.events.map(([at, kind]) => ({ at, kind })),
    deaths: sys.deaths.map(([at, process]) => ({ at, process })),
  };
}

function write(fx) {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(path.join(DIR, "inputs.json"), JSON.stringify({ today: fx.today, systems: fx.inputs }));
  fs.writeFileSync(path.join(DIR, "expected.json"), JSON.stringify({ today: fx.today, findings: fx.expected }, null, 1) + "\n");
}

async function main() {
  const today = process.argv[2];
  const { connect } = require("../../db");
  const db = connect("readonly", { applicationName: "insight_mri_fixtures" });
  try {
    const fx = await build(db, today);
    write(fx);
    console.log(`${fx.inputs.length} systems, ${fx.expected.length} findings as of ${today} -> ${DIR}`);
  } finally { db.$pool.end(); }
}

if (require.main === module) main().catch((e) => { console.error(`FAILED: ${e.message}`); process.exitCode = 2; });

module.exports = { build, write, expand, DIR };
