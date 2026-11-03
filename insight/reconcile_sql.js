"use strict";
// Independent per-(system, metric) counts for the Phase 2 exit criterion
// (PLAN-CT-INSIGHTS.md §8): "fact counts exactly equal hand-run SQL counts".
// Written from each metric's definition, NOT translated from the JS
// regexes, so a difference means one side is wrong. PostgreSQL regex '.'
// matches newlines (unlike JS), so '.*' spans lines here.
// $1 = from id (exclusive), $2 = to id (inclusive), $3 = system or NULL.

const COND = {
  "tube.mas_total": `p = 'scanmgr' AND message ~* 'tube usage data reports a total of\\s*-?[0-9]'`,
  "tube.identity": `p IN ('fwmgr','scanRx','orp_subsys') AND message ~* '(GE tube has been verified|unrecognized X-Ray tube has been installed|initialized for an X-Ray tube without Smart ID|Current tube type is\\s+.+\\s+tube)'`,
  "tube.rotor_unexpected_stop": `p = 'tgp_subsys' AND message ~* 'rotor is decelerating to stop unexpectedly'`,
  "tube.rotor_stop_no_random_position": `p = 'tgp_subsys' AND message ~* 'decelerating to stop without moving to random gantry position'`,
  "tube.rotor_not_at_speed": `message ~* 'Rotor not at speed'`,
  "tube.rotor_sgb_slope": `p = 'orp_subsys' AND message ~* 'SGB Slope:\\s*-?[0-9]+(\\.[0-9]+)?\\s*rpm/sec'`,
  "tube.filament_aging": `p = 'orp_subsys' AND message ~* 'Filament aging saturated'`,
  "exam.start": `p = 'scanRx' AND message ~ 'Start:\\s*Prospective Exam:\\s*[0-9]+\\s*:\\s*Protocol:'`,
  "exam.series": `p = 'scanRx' AND message ~ '^\\s*Series:\\s*[0-9]+\\s*:\\s*Scans:'`,
  "system.shutdown": `p = 'environmentMgr' AND message ~ 'System shutdown started from desktop button'`,
  "ui.start_scan_button": `p = 'tgp_subsys' AND message ~ '\\[START SCAN\\] pushbutton was pressed'`,
  "xfer.dicom_send_start": `p = 'dcserver' AND message ~ '^\\s*Start Sending:\\s*[0-9]+(/[0-9]+)?(/\\.\\.\\.)?\\s*\\('`,
  "xfer.dicom_sent": `p = 'dcserver' AND message ~ '^\\s*Sent:\\s*[0-9]+(/[0-9]+)?(/\\.\\.\\.)?\\s*\\('`,
  "scan.abort.operator": `p = 'scanmgr' AND message ~ 'Operator Aborted Scanning'`,
  "scan.abort.system": `exception_class = 'Abort'`,
  "scan.safe_state": `exception_class = 'Safe State'`,
  "error.ermes": `ermes_number IS NOT NULL`,
  "system.sw_init_complete": `p = 'cupMonitor' AND message ~ 'Software Initialization Complete'`,
  "process.restart": `p = 'cupMonitor' AND message ~* 'unexpected termination of\\s+\\S+\\s+caused it to be restarted'`,
  "service.mode": `p = 'environmentMgr' AND message ~* 'System (enter|exit) service mode'`,
  "service.calibration": `p = 'scanUtilsRx' AND message ~* 'Tube temperature (before|after)\\s+.+\\s+is\\s+-?[0-9]+(\\.[0-9]+)?\\s+degrees'`,
  "das.link_errors": `p = 'orp_subsys' AND message ~* 'Optical high speed link dropped packets'`,
  "prep.tube_temp": `p = 'dailyPrepRx' AND message ~* 'Tube temperature (before|after)\\s+.+\\s+is\\s+-?[0-9]+(\\.[0-9]+)?\\s+degrees'`,
  "op.scan_in_warmup_zone": `p = 'scanRx' AND message ~* 'Scanning was confirmed for exam\\s+[0-9]+\\s+while the X-ray tube state was in the yellow warm up zone'`,
  "op.warmup_skipped": `p = 'scanRx' AND message ~* 'Tube warm up was skipped\\.\\s*Limited mA will be used for exam\\s+[0-9]+'`,
  "compliance.dose_display_disabled": `p = 'scanRx' AND message ~* 'Dose information database \\(Ctdi\\.cfg\\) read error\\.\\s*Disabled dose information display feature'`,
  "calibration.air_overdue": `p = 'scanRx' AND message ~* 'no air ratio calibration was done more than\\s+[0-9]+\\s+days'`,
  "env.plenum_temp": `p = 'orp_subsys' AND message !~* 'CFHC has recovered' AND message ~* 'Plenum.*Temperature Out of Tolerance'`,
  "env.plenum_recovered": `p = 'orp_subsys' AND message ~* 'CFHC has recovered.*Plenum'`,
  "env.detector_temp_low": `message ~* 'Detector Temperature Is Low'`,
  "env.psu_temp_out_of_spec": `p = 'event_logger' AND message ~* 'power supply read a temperature which is out of specification.*Actual reading\\s*=\\s*-?[0-9]+\\s*millidegC'`,
  "env.psu_voltage_out_of_spec": `p = 'event_logger' AND message ~* 'power supply read a voltage which is out of specification.*Actual reading\\s*=\\s*-?[0-9]+\\s*mV'`,
  "env.humidity_out_of_range": `p = 'event_logger' AND message ~* 'humidity out of range.*Actual Value:\\s*-?[0-9]+\\s*milliRH'`,
  "ipc.event_router_send_failed": `message ~* 'Send of message with event code\\s+[0-9]+\\s+from service\\s*\\S*\\s+to Event Router process failed with status:'`,
  "ipc.sigpipe": `message ~* 'received SIGPIPE, broken pipe'`,
  "storage.image_space_error": `p IN ('dms','environmentMgr') AND (message ~* 'Image space query failed\\.\\s*Error code:\\s*-?[0-9]+' OR message ~* 'Updating image space, received a bad status code:\\s*-?[0-9]+')`,
  "inventory.product": `p = 'Svc_Notepad' AND message ~ 'PRODUCT CONFIGURATION\\|' AND message ~ '\\|\\s*Product\\s*:'`,
};

const RECONCILE_SQL = `
WITH base AS (
  SELECT system_id, message, exception_class, ermes_number,
         btrim(CASE WHEN position(E'\\t' IN coalesce(type, '')) > 0 THEN split_part(type, E'\\t', 2) ELSE coalesce(type, '') END) AS p
  FROM log.ge_ct_gesys
  WHERE id > $1 AND id <= $2 AND ($3::text IS NULL OR system_id = $3)
    AND epoch IS NOT NULL AND record_number_concurrent IS NOT NULL
    AND host_date IS NOT NULL AND host_time IS NOT NULL
    AND host_datetime >= '2025-05-01T00:00:00Z' AND host_datetime < '2029-01-01T00:00:00Z'
)
SELECT system_id, k.key, count(*) AS n
FROM base
CROSS JOIN LATERAL (VALUES
${Object.entries(COND).map(([k, c]) => `  ('${k}', coalesce(${c}, false))`).join(",\n")}
) AS k(key, hit)
WHERE k.hit
GROUP BY 1, 2`;

module.exports = { RECONCILE_SQL, COND };
