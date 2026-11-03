#!/usr/bin/env node
"use strict";
// Build rule fixtures from real prod rows (READ-ONLY connection).
//   node insight/tools/build_fixtures.js
// Labels come from the SQL classifier below, written independently of the
// JS regexes in rules/ge_ct.js, so the fixture test checks the rules rather
// than echoing them. Rows are scrubbed (tools/scrub.js) before writing.
// Free-text Svc_Notepad lines are excluded except PRODUCT CONFIGURATION.
const fs = require("fs");
const path = require("path");
const { connect, pgp } = require("../db");
const { scrub_row } = require("./scrub");

const OUT = path.join(__dirname, "..", "rules", "__fixtures__", "ge_ct");
const PER_LABEL = 8;

// Independent SQL classifier. Order matters only for the primary label.
const LABEL_SQL = `CASE
  WHEN message ~ 'tube usage data reports a total of' THEN 'tube.mas_total'
  WHEN message ~ 'GE tube has been verified|unrecognized X-Ray tube has been installed|without Smart ID|Current tube type is' THEN 'tube.identity'
  WHEN message ~ 'decelerating to stop unexpectedly' THEN 'tube.rotor_unexpected_stop'
  WHEN message ~ 'without moving to random gantry position' THEN 'tube.rotor_stop_no_random_position'
  WHEN message ~ 'Rotor not at speed' THEN 'tube.rotor_not_at_speed'
  WHEN message ~ 'SGB Slope' THEN 'tube.rotor_sgb_slope'
  WHEN message ~ 'Filament aging saturated' THEN 'tube.filament_aging'
  WHEN message ~ 'Start: Prospective Exam' THEN 'exam.start'
  WHEN message ~ '^\\s*Series: [0-9]+ : Scans:' THEN 'exam.series'
  WHEN message ~ 'System shutdown started from desktop button' THEN 'system.shutdown'
  WHEN message ~ 'START SCAN\\] pushbutton was pressed' THEN 'ui.start_scan_button'
  WHEN message ~ '^\\s*Start Sending: ' THEN 'xfer.dicom_send_start'
  WHEN message ~ '^\\s*Sent: ' THEN 'xfer.dicom_sent'
  WHEN message ~ 'Operator Aborted Scanning' THEN 'scan.abort.operator'
  WHEN exception_class = 'Abort' THEN 'scan.abort.system'
  WHEN exception_class = 'Safe State' THEN 'scan.safe_state'
  WHEN message ~ 'Software Initialization Complete' THEN 'system.sw_init_complete'
  WHEN message ~ 'unexpected termination of .* caused it to be restarted' THEN 'process.restart'
  WHEN message ~ 'System (enter|exit) service mode' THEN 'service.mode'
  WHEN type ~ E'\\tscanUtilsRx' AND message ~ 'Tube temperature (before|after)' THEN 'service.calibration'
  WHEN message ~ 'Optical high speed link dropped packets' THEN 'das.link_errors'
  WHEN type ~ E'\\tdailyPrepRx' AND message ~ 'Tube temperature (before|after)' THEN 'prep.tube_temp'
  WHEN message ~ 'yellow warm up zone' THEN 'op.scan_in_warmup_zone'
  WHEN message ~ 'Tube warm up was skipped' THEN 'op.warmup_skipped'
  WHEN message ~ 'Ctdi.cfg\\) read error' THEN 'compliance.dose_display_disabled'
  WHEN message ~ 'no air ratio calibration was done' THEN 'calibration.air_overdue'
  WHEN message ~ 'CFHC has recovered' AND message ~ 'Plenum' THEN 'env.plenum_recovered'
  WHEN message ~ 'Plenum' AND message ~ 'Temperature Out of Tolerance' THEN 'env.plenum_temp'
  WHEN message ~ 'Detector Temperature Is Low' THEN 'env.detector_temp_low'
  WHEN message ~ 'power supply read a temperature which is out of specification' THEN 'env.psu_temp_out_of_spec'
  WHEN message ~ 'power supply read a voltage which is out of specification' THEN 'env.psu_voltage_out_of_spec'
  WHEN message ~ 'humidity out of range' THEN 'env.humidity_out_of_range'
  WHEN message ~ 'PRODUCT CONFIGURATION\\|' THEN 'inventory.product'
  WHEN message ~ 'Send of message with event code [0-9]+ from service .*to Event Router process failed' THEN 'ipc.event_router_send_failed'
  WHEN message ~ 'received SIGPIPE, broken pipe' THEN 'ipc.sigpipe'
  WHEN type ~ E'\\t(dms|environmentMgr)' AND message ~ 'Image space query failed|Updating image space, received a bad status code' THEN 'storage.image_space_error'
  WHEN ermes_number IS NOT NULL THEN 'error.ermes'
END`;

const SQL = `
WITH r AS (
  SELECT id, type, message, exception_class, severity, ermes_number, ${LABEL_SQL} AS label,
         regexp_replace(left(message, 300), '[0-9]+(\\.[0-9]+)?', '#', 'g') AS tmpl
  FROM log.ge_ct_gesys
  WHERE NOT (type ~ E'\\tSvc_Notepad' AND message !~ 'PRODUCT CONFIGURATION\\|')
), t AS (
  SELECT coalesce(label, 'none') AS label, tmpl, count(*) AS n, max(id) AS id
  FROM r GROUP BY 1, 2
), pick AS (
  SELECT label, id, n, row_number() OVER (PARTITION BY label ORDER BY n DESC) AS rk FROM t
)
SELECT p.label, p.n, g.type, g.message, g.exception_class, g.severity, g.ermes_number
FROM pick p JOIN log.ge_ct_gesys g ON g.id = p.id
WHERE p.rk <= CASE WHEN p.label = 'none' THEN 40 ELSE ${PER_LABEL} END
ORDER BY p.label, p.n DESC`;

(async () => {
  const db = connect("readonly", { statementTimeoutMs: 900000, applicationName: "insight_fixtures" });
  try {
    const ro = await db.one("SHOW default_transaction_read_only");
    if (ro.default_transaction_read_only !== "on") throw new Error("not read-only");
    const rows = await db.any(SQL);
    const by = {};
    for (const r of rows) (by[r.label] = by[r.label] || []).push({ templates_seen: Number(r.n), ...scrub_row(r) });
    fs.mkdirSync(OUT, { recursive: true });
    for (const f of fs.readdirSync(OUT)) if (f.endsWith(".json")) fs.unlinkSync(path.join(OUT, f));
    for (const [label, list] of Object.entries(by)) {
      fs.writeFileSync(path.join(OUT, `${label}.json`), JSON.stringify(list, null, 1) + "\n");
      console.log(`${label.padEnd(36)} ${String(list.length).padStart(3)} samples`);
    }
  } finally {
    await db.$pool.end();
    pgp.end();
  }
})().catch((e) => { console.error(e.message); process.exitCode = 1; });
