#!/usr/bin/env node
"use strict";
// Build GE CV rule fixtures from real prod rows (READ-ONLY connection).
//   node insight/cv/tools/build_fixtures.js
// Labels come from the independent SQL (reconcile_sql.js COND / RELAY),
// not from rules.js, so the fixture test checks the rules rather than
// echoing them. Per label, up to PER_LABEL rows with distinct (code,
// debug-text template). Label "cv.error" = counted, no named metric; it
// includes look-alikes from named codes (e.g. backout "released", the PIB
// rack reset, collision sensor) that must NOT give a named fact.
//
// Only the columns the rules read are kept (errorcode, subsystem,
// debugtext, sourcefile, repeatcount, sourceline): no system, time or id.
// IPv4 addresses in debug text are masked. GE's encoded fields are never
// selected. Nothing in the GE CT run loads this file.
const fs = require("fs");
const path = require("path");
const { COND, RELAY } = require("../reconcile_sql");

const OUT = path.join(__dirname, "..", "__fixtures__");
const PER_LABEL = 8;
const LOOKALIKE_CODES = [1050297, 1050024, 1050167, 1050305, 1050178, 1050015, 1050102, 2800176, 2800036, 2800175, 1200014, 1200019];

const named = Object.entries(COND).filter(([k]) => k !== "cv.error");
const LABEL_SQL = `CASE
  WHEN coalesce(${RELAY}, false) THEN 'ignore.rta_relay'
${named.map(([k, c]) => `  WHEN coalesce(${c}, false) THEN '${k}'`).join("\n")}
  ELSE 'cv.error'
END`;

const SQL = `
WITH r AS (
  SELECT errorcode, btrim(subsystem) AS subsystem, debugtext, sourcefile, repeatcount, sourceline, ${LABEL_SQL} AS label,
         regexp_replace(coalesce(debugtext, ''), '[0-9A-Fa-f]+', '#', 'g') AS tmpl, id
  FROM log.ge_cv_syserror
), d AS (
  SELECT DISTINCT ON (label, errorcode, tmpl) label, errorcode, subsystem, debugtext, sourcefile, repeatcount, sourceline, id,
         count(*) OVER (PARTITION BY label, errorcode, tmpl) AS seen
  FROM r
  ORDER BY label, errorcode, tmpl, id
), ranked AS (
  SELECT d.*, row_number() OVER (PARTITION BY label ORDER BY
           (label = 'cv.error' AND errorcode = ANY($1)) DESC, seen DESC, errorcode, id) AS k
  FROM d
)
SELECT label, errorcode, subsystem, debugtext, sourcefile, repeatcount, sourceline, seen::int
FROM ranked WHERE k <= CASE WHEN label = 'cv.error' THEN $2 * 3 ELSE $2 END
ORDER BY label, k`;

const mask = (s) => (s === null ? null : String(s).replace(/(?<![\d.])(\d{1,3}\.){3}\d{1,3}(?![\d.])/g, "0.0.0.0"));

async function build(db) {
  if ((await db.one("SHOW default_transaction_read_only")).default_transaction_read_only !== "on") throw new Error("not read-only");
  const rows = await db.any(SQL, [LOOKALIKE_CODES, PER_LABEL]);
  const by = {};
  for (const r of rows) (by[r.label] ||= []).push({ templates_seen: r.seen, errorcode: r.errorcode, subsystem: r.subsystem, debugtext: mask(r.debugtext), sourcefile: r.sourcefile, repeatcount: r.repeatcount, sourceline: r.sourceline });
  fs.mkdirSync(OUT, { recursive: true });
  for (const f of fs.readdirSync(OUT)) if (f.endsWith(".json")) fs.unlinkSync(path.join(OUT, f));
  for (const [label, list] of Object.entries(by)) fs.writeFileSync(path.join(OUT, `${label}.json`), JSON.stringify(list, null, 1) + "\n");
  return Object.fromEntries(Object.entries(by).map(([k, v]) => [k, v.length]));
}

if (require.main === module) {
  const { connect } = require("../../db");
  const db = connect("readonly", { applicationName: "insight_cv_fixtures" });
  build(db).then((n) => console.log(n)).catch((e) => { console.error(e.message); process.exitCode = 2; }).finally(() => db.$pool.end());
}

module.exports = { build, SQL, LOOKALIKE_CODES };
