#!/usr/bin/env node
"use strict";
// Build fixtures for the derived-fact rules from real prod facts
// (READ-ONLY connection).
//   node insight/tools/build_derived_fixtures.js
// Tube cases: every tube.mas_total / service.calibration / tube.identity
// fact of the §13.1 systems (+ one system without a reset). Boot cases: the
// boot inputs of a few windows (restart loop, daily cycling, PET/CT app
// restarts). Expected boots come from the independent SQL in
// derive/verify_sql.js run over ALL facts, not from the JS rules.
// Only metric, times, value and step/verdict/process text are kept: no
// hostnames, exam numbers or raw messages.
const fs = require("fs");
const path = require("path");
const { connect, pgp } = require("../db");
const { BOOTS_SQL } = require("../derive/verify_sql");

const OUT = path.join(__dirname, "..", "rules", "__fixtures__", "ge_ct_derived");

const TUBE_SYSTEMS = ["SME15218", "SME16618", "SME21864", "SME21873", "SME21859"];
const TUBE_METRICS = ["tube.mas_total", "service.calibration", "tube.identity"];
const BOOT_METRICS = ["system.sw_init_complete", "process.restart", "system.shutdown"];
// [system, window start, window end, context days before start (fractional ok)]
const BOOT_WINDOWS = [
  ["SME18531", "2026-09-11T12:00:00Z", "2026-09-12T05:30:00Z", 2],     // restart loop starts 09-12 05:11
  ["SME18531", "2026-09-14T09:30:00Z", "2026-09-16T00:00:00Z", 0.01],  // loop ends 09-14 09:45, then normal boots
  ["SME14521", "2026-07-01T00:00:00Z", "2026-07-15T00:00:00Z", 7],     // daily cycling
  ["SME01429", "2026-06-01T00:00:00Z", "2026-06-15T00:00:00Z", 21],  // inits without shutdown
  ["SME21873", "2026-09-01T00:00:00Z", "2026-09-15T00:00:00Z", 7],
];

const FACTS_SQL = `
  SELECT metric_key AS m, host_datetime AS t, to_char(host_local, 'YYYY-MM-DD"T"HH24:MI:SS') AS l,
         value_num AS v, CASE WHEN metric_key = 'tube.identity' THEN value_text
                              WHEN metric_key IN ('service.calibration', 'process.restart') THEN value_text END AS x,
         epoch AS e, record_number_concurrent AS r
  FROM insight.ge_ct_facts
  WHERE system_id = $1 AND metric_key = ANY($2) AND host_datetime >= $3 AND host_datetime < $4
    AND NOT (metric_key = 'tube.identity' AND value_text = 'type')
  ORDER BY host_datetime, epoch, record_number_concurrent`;

const compact = (rows) => rows.map((f) => ({ ...f, t: f.t.toISOString(), v: f.v === null ? undefined : f.v, x: f.x === null ? undefined : f.x }));

(async () => {
  const db = connect("readonly", { statementTimeoutMs: 600000, applicationName: "insight_fixtures" });
  try {
    if ((await db.one("SHOW default_transaction_read_only")).default_transaction_read_only !== "on") throw new Error("not read-only");
    fs.mkdirSync(OUT, { recursive: true });
    const tube = {};
    for (const s of TUBE_SYSTEMS) tube[s] = compact(await db.any(FACTS_SQL, [s, TUBE_METRICS, "2000-01-01", "2100-01-01"]));
    fs.writeFileSync(path.join(OUT, "tube.json"), JSON.stringify(tube) + "\n");
    console.log(`tube.json: ${Object.entries(tube).map(([s, f]) => `${s}=${f.length}`).join(" ")}`);

    const boots = [];
    for (const [s, from, to, ctxDays] of BOOT_WINDOWS) {
      const ctx = new Date(Date.parse(from) - ctxDays * 86400000).toISOString();
      const facts = compact(await db.any(FACTS_SQL, [s, BOOT_METRICS, ctx, to]));
      const expected = (await db.any(BOOTS_SQL, [s]))
        .filter((b) => b.t >= new Date(from) && b.t < new Date(to))
        .map((b) => ({ t: b.t.toISOString(), e: b.epoch, r: b.rnc, clean: b.clean }));
      boots.push({ system_id: s, window: [from, to], context_from: ctx, facts, expected });
      console.log(`boots ${s} ${from.slice(0, 10)}..${to.slice(0, 10)}: ${facts.length} facts, ${expected.length} expected boots (${expected.filter((b) => !b.clean).length} unclean)`);
    }
    fs.writeFileSync(path.join(OUT, "boots.json"), JSON.stringify(boots) + "\n");
  } finally {
    await db.$pool.end();
    pgp.end();
  }
})().catch((e) => { console.error(`ERROR: ${e.message}`); process.exitCode = 1; });
