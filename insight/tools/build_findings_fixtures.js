#!/usr/bin/env node
"use strict";
// Build fixtures for the findings rules from real prod data (READ-ONLY).
//   node insight/tools/build_findings_fixtures.js
// Systems: the §14.1 cases (named problems, rotor spikes, prep outliers,
// chronic environment, tube replacements, air calibration, a system that
// stopped sending). Inputs are what findings/load.js reads; expected
// findings come from the independent SQL (findings/verify_sql.js) over ALL
// data, not from the JS rules.
// Kept: days, daily counts, times, ermes codes, boot clean flag, replacement
// attrs. Dropped: prep steps the rules don't read (load.js reads no message text).
const fs = require("fs");
const path = require("path");
const { connect, pgp } = require("../db");
const { load_inputs } = require("../findings/load");
const { FINDINGS_SQL } = require("../findings/verify_sql");
const { FAST_CAL_STEPS } = require("../findings/context");

const OUT = path.join(__dirname, "..", "rules", "__fixtures__", "findings");
const TODAY = "2026-11-04";
const SYSTEMS = {
  SME21859: "rotor: chronic, sustained (high) from the start",
  SME18531: "process restart loop 2026-09-12; chronic plenum; humidity",
  SME21867: "chronic system aborts (DAS power supply / DCB errors)",
  SME18536: "isolated rotor spikes (06-15 and 08-10 weeks)",
  SME01430: "rotor spike (07-06 week); chronic plenum; unclean boots; warm-up bypass",
  SME21855: "prep outlier (Cold Tube Warmup daily, Fast Cal rarely)",
  SME01429: "prep outlier; unclean boots",
  SME16618: "prep outlier; tube replacement",
  SME20608: "chronic plenum + PSU",
  SME21873: "four tube resets incl. counter_only; aborts; air calibration overdue",
  SME15218: "two tube replacements; E-off safe states; air calibration overdue",
  SME21849: "air calibration overdue",
  SME00875: "stopped sending 05-28 (open findings keep their state)",
};

const compact = (inp) => ({
  system_id: inp.system_id,
  days: inp.days.map((d) => [d.day, new Date(d.start_at).toISOString(), new Date(d.last_at).toISOString()]),
  daily: inp.daily.filter((c) => c.m !== "prep.tube_temp" || FAST_CAL_STEPS.includes(c.dim)).map((c) => [c.day, c.m, c.dim, c.n])
    .sort((a, b) => (a.join("|") < b.join("|") ? -1 : 1)),
  safe: inp.safe.map((s) => [new Date(s.t).toISOString(), s.day, s.code]),
  boots: inp.boots.map((b) => [new Date(b.t).toISOString(), b.day, b.clean]),
  shutdowns: inp.shutdowns.map((s) => [new Date(s.t).toISOString(), s.day]),
  service_enter: inp.service_enter.map((s) => [new Date(s.t).toISOString(), s.day]),
  abort_codes: inp.abort_codes.map((a) => [a.day, a.code, a.n]).sort((a, b) => (a.join("|") < b.join("|") ? -1 : 1)),
  replacements: inp.replacements.map((r) => ({ ...r, t: new Date(r.t).toISOString() })),
});

(async () => {
  const db = connect("readonly", { statementTimeoutMs: 900000, applicationName: "insight_fixtures" });
  try {
    if ((await db.one("SHOW default_transaction_read_only")).default_transaction_read_only !== "on") throw new Error("not read-only");
    fs.mkdirSync(OUT, { recursive: true });
    const inputs = {};
    for (const s of Object.keys(SYSTEMS)) inputs[s] = compact(await load_inputs(db, s));
    const expected = (await db.any(FINDINGS_SQL, [TODAY])).filter((r) => SYSTEMS[r.system_id]).map((r) => ({
      ...r, opened_at: r.opened_at.toISOString(), resolved_at: r.resolved_at && r.resolved_at.toISOString(),
      window_start: r.window_start.toISOString(), window_end: r.window_end.toISOString(), last_evaluated: r.last_evaluated.toISOString(),
    }));
    fs.writeFileSync(path.join(OUT, "inputs.json"), JSON.stringify({ today: TODAY, systems: SYSTEMS, inputs }));
    fs.writeFileSync(path.join(OUT, "expected.json"), JSON.stringify({ today: TODAY, source: "findings/verify_sql.js FINDINGS_SQL", findings: expected }, null, 0));
    console.log(`wrote ${Object.keys(inputs).length} systems, ${expected.length} expected findings (as of ${TODAY}) to ${OUT}`);
  } finally {
    await db.$pool.end();
    pgp.end();
  }
})().catch((e) => { console.error(e); process.exitCode = 1; });
