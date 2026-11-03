"use strict";
// GE CT rule registry (PLAN-CT-INSIGHTS.md §4, §12).
//
// One object per metric. A rule sees one log.ge_ct_gesys row and returns
// null (no fact) or { value_num, value_text, exam_no, attrs }. Rules are
// pure: no DB, no clock. Regexes were written against real prod variants
// (2026-11-03); fixtures in __fixtures__/ge_ct/ keep them honest.
//
// The catalog (label, unit, category, ...) is generated from these
// objects and upserted into insight.metric_catalog, so the registry is the
// single source of truth. Bump `version` whenever a rule's output changes;
// facts are replaced only by a newer version (§6).
//
// Messages carry leading newlines, runs of spaces, and control bytes
// (\x02, \x03): patterns use \s and [\s\S] accordingly.

const num = (s) => (s === undefined || s === null || s === "" ? null : Number(s));
const firstLine = (msg, max = 160) =>
  (msg || "").replace(/[\x00-\x1f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

// Small helper: rule that emits one event when `re` matches.
const event = (re, extra = () => ({})) => (row) => {
  const m = re.exec(row.message || "");
  return m ? { value_num: null, value_text: null, exam_no: null, attrs: null, ...extra(m, row) } : null;
};

// "Series: N : Scans: S : Images: I  (Scout)" / ": PMRSeries(n)" / ": SPScans: k"
// PET recon lines: "Series: N : Scan Series: X : Images: I: (Static PET -  MAC)"
function parseSeries(msg) {
  const ct = [];
  const pet = [];
  for (const line of msg.split(/\n/)) {
    let m = /^\s*Series:\s*(\d+)\s*:\s*Scans:\s*(\d+)\s*:\s*Images:\s*(\d+)(.*)$/.exec(line);
    if (m) {
      const rest = m[4];
      const pmr = /PMRSeries\((\d+)\)/.exec(rest);
      const sp = /SPScans:\s*(\d+)/.exec(rest);
      ct.push({ series: +m[1], scans: +m[2], images: +m[3], scout: /\(Scout\)/.test(rest),
        ...(pmr ? { pmr: +pmr[1] } : {}), ...(sp ? { sp_scans: +sp[1] } : {}) });
      continue;
    }
    m = /^\s*Series:\s*(\d+)\s*:\s*Scan Series:\s*(\d+)\s*:\s*Images:\s*(\d+):?\s*\((.*?)\)\s*$/.exec(line);
    if (m) pet.push({ series: +m[1], scan_series: +m[2], images: +m[3], label: m[4].replace(/\s+/g, " ").trim() });
  }
  return { ct, pet };
}

// Plenum: format A in 1/100 °C ("Left: 2550, Center: 2550, Right: 2800"),
// formats B/C in °C ("Left [1]:  34.25  Center [2] 34.25 , Right [3]: 33.62").
function parsePlenum(msg) {
  let m = /Left:\s*(-?\d+),\s*Center:\s*(-?\d+),\s*Right:\s*(-?\d+)[\s\S]*?Filtered Average Temperature:\s*(-?\d+)[\s\S]*?Limits:\s*(-?\d+),\s*(-?\d+)/.exec(msg);
  if (m) {
    const c = (v) => +v / 100;
    return { left: c(m[1]), center: c(m[2]), right: c(m[3]), filtered_avg: c(m[4]), limit_low: c(m[5]), limit_high: c(m[6]), unit_source: "1/100 C" };
  }
  m = /Left\s*\[\d+\]:?\s*(-?[\d.]+)\s*Center\s*\[\d+\]:?\s*(-?[\d.]+)\s*,?\s*Right\s*\[\d+\]:?\s*(-?[\d.]+)[\s\S]*?Filtered Average Temperature:\s*(-?[\d.]+)[\s\S]*?Limits:\s*(-?[\d.]+),\s*(-?[\d.]+)/.exec(msg);
  if (m) return { left: +m[1], center: +m[2], right: +m[3], filtered_avg: +m[4], limit_low: +m[5], limit_high: +m[6], unit_source: "C" };
  return null;
}

// dcserver "Start Sending:" / "Sent:" lines. Seen formats:
//   "2229/11 (AIDOC)", "15411/997/... (NSFRTAW)" (truncated), "2175 (Imalogix)".
function dicom(prefix, msg) {
  const text = msg || "";
  if (!prefix.test(text)) return null;
  const m = /:\s*(\d+)(?:\/(\d+))?(\/\.\.\.)?\s*\(([^)]*)\)/.exec(text);
  if (!m) return null;
  return { value_num: null, value_text: m[4], exam_no: null,
    attrs: { a: +m[1], ...(m[2] !== undefined ? { b: +m[2] } : {}), ...(m[3] ? { truncated: true } : {}) } };
}

const rules = [
  // ------------------------------------------------------------- tube
  {
    key: "tube.mas_total", version: 1, category: "tube", value_kind: "counter", unit: "mA·s",
    label: "Tube usage counter", description: "Cumulative tube mA·s reported by scanmgr. Basis for tube segments and replacement detection.",
    process: ["scanmgr"],
    extract: (row) => {
      const m = /tube usage data reports a total of\s*(-?\d+(?:\.\d+)?)\s*ma\*S/i.exec(row.message || "");
      return m ? { value_num: num(m[1]), value_text: null, exam_no: null, attrs: null } : null;
    },
  },
  {
    key: "tube.identity", version: 1, category: "inventory", value_kind: "text", unit: null,
    label: "Tube identity", description: "Tube verification / identity messages: verified, unrecognized, no Smart ID, or the reported bearing type.",
    process: ["fwmgr", "scanRx", "orp_subsys"],
    extract: (row) => {
      const msg = row.message || "";
      if (/GE tube has been verified/i.test(msg)) return { value_num: null, value_text: "verified", exam_no: null, attrs: null };
      if (/unrecognized X-Ray tube has been installed/i.test(msg)) return { value_num: null, value_text: "unrecognized", exam_no: null, attrs: null };
      if (/initialized for an X-Ray tube without Smart ID/i.test(msg)) return { value_num: null, value_text: "no_smart_id", exam_no: null, attrs: null };
      const m = /Current tube type is\s+(.+?)\s+tube\b/i.exec(msg);
      if (m) return { value_num: null, value_text: "type", exam_no: null, attrs: { tube_type: m[1] } };
      return null;
    },
  },
  {
    key: "tube.rotor_unexpected_stop", version: 1, category: "tube", value_kind: "event", unit: null, model_specific: true,
    label: "Rotor stopped unexpectedly", description: "Liquid-bearing rotor decelerating to stop unexpectedly; gantry rotation stopped to protect the tube.",
    process: ["tgp_subsys"],
    extract: event(/rotor is decelerating to stop unexpectedly/i),
  },
  {
    key: "tube.rotor_stop_no_random_position", version: 1, category: "tube", value_kind: "event", unit: null, model_specific: true,
    label: "Rotor stopped without random gantry position", description: "Rotor stopped without moving to a random gantry position by request. GE notes frequent use shortens tube life.",
    process: ["tgp_subsys"],
    extract: event(/decelerating to stop without moving to random gantry position/i),
  },
  {
    key: "tube.rotor_not_at_speed", version: 1, category: "tube", value_kind: "event", unit: null, model_specific: true,
    label: "Rotor not at speed", description: "(40-0114) Rotor not at speed. attrs carry the Z-counter hours.",
    process: null,
    extract: event(/Rotor not at speed/i, (m, row) => {
      const z = /Z(\d+),\s*Z(\d+)\s*=\s*(\d+)h,\s*(\d+)h/.exec(row.message || "");
      return { attrs: z ? { [`z${z[1]}_h`]: +z[3], [`z${z[2]}_h`]: +z[4] } : null };
    }),
  },
  {
    key: "tube.rotor_sgb_slope", version: 1, category: "tube", value_kind: "gauge", unit: "rpm/s", model_specific: true,
    label: "Rotor SGB slope", description: "Liquid-bearing rotor health log: spiral-groove-bearing deceleration slope.",
    process: ["orp_subsys"],
    extract: (row) => {
      const m = /SGB Slope:\s*(-?\d+(?:\.\d+)?)\s*rpm\/sec/i.exec(row.message || "");
      return m ? { value_num: num(m[1]), value_text: null, exam_no: null, attrs: null } : null;
    },
  },
  {
    key: "tube.filament_aging", version: 1, category: "tube", value_kind: "event", unit: null, model_specific: true,
    label: "Filament aging saturated", description: "Filament aging saturated. attrs carry the Z-counter hours.",
    process: ["orp_subsys"],
    extract: event(/Filament aging saturated/i, (m, row) => {
      const z = /Z(\d+),\s*Z(\d+)\s*=\s*(\d+)h,\s*(\d+)h/.exec(row.message || "");
      return { attrs: z ? { [`z${z[1]}_h`]: +z[3], [`z${z[2]}_h`]: +z[4] } : null };
    }),
  },

  // -------------------------------------------------------- utilization
  {
    key: "exam.start", version: 1, category: "utilization", value_kind: "event", unit: null,
    label: "Exam started", description: "Start: Prospective Exam. value_text = protocol, exam_no set.",
    process: ["scanRx"],
    extract: (row) => {
      const m = /Start:\s*Prospective Exam:\s*(\d+)\s*:\s*Protocol:\s*([^\n]*?)\s*$/m.exec(row.message || "");
      return m ? { value_num: null, value_text: m[2] || null, exam_no: m[1], attrs: null } : null;
    },
  },
  {
    key: "exam.series", version: 1, category: "utilization", value_kind: "gauge", unit: "images",
    label: "Exam series summary", description: "Running list of an exam's series (no exam number in the message; Phase 3 links it to the exam by time). value_num = CT images; attrs = per-series detail.",
    process: ["scanRx"],
    extract: (row) => {
      const msg = row.message || "";
      if (!/^\s*Series:\s*\d+\s*:\s*Scans:/.test(msg)) return null;
      const { ct, pet } = parseSeries(msg);
      if (!ct.length) return null;
      const sum = (k) => ct.reduce((a, s) => a + s[k], 0);
      return { value_num: sum("images"), value_text: null, exam_no: null,
        attrs: { ct_series: ct.length, ct_scans: sum("scans"), ct_images: sum("images"), series: ct, ...(pet.length ? { pet } : {}) } };
    },
  },
  {
    key: "system.shutdown", version: 1, category: "utilization", value_kind: "event", unit: null,
    label: "Shutdown from desktop", description: "System shutdown started from the desktop button.",
    process: ["environmentMgr"],
    extract: event(/System shutdown started from desktop button/),
  },
  {
    key: "ui.start_scan_button", version: 1, category: "utilization", value_kind: "event", unit: null, model_specific: true,
    label: "Start Scan button presses", description: "[START SCAN] pushbutton pressed (hardware cycle counter).",
    process: ["tgp_subsys"],
    extract: event(/\[START SCAN\] pushbutton was pressed/),
  },
  {
    key: "xfer.dicom_send_start", version: 1, category: "utilization", value_kind: "event", unit: null, model_specific: true,
    label: "DICOM send started", description: "dcserver Start Sending a[/b[/...]] (DEST). value_text = destination.",
    process: ["dcserver"],
    extract: (row) => {
      return dicom(/^\s*Start Sending:/, row.message);
    },
  },
  {
    key: "xfer.dicom_sent", version: 1, category: "utilization", value_kind: "event", unit: null, model_specific: true,
    label: "DICOM send completed", description: "dcserver Sent a/b (DEST). Pairs with xfer.dicom_send_start for latency (Phase 3).",
    process: ["dcserver"],
    extract: (row) => {
      return dicom(/^\s*Sent:/, row.message);
    },
  },

  // -------------------------------------------------------- reliability
  {
    key: "scan.abort.operator", version: 1, category: "reliability", value_kind: "event", unit: null,
    label: "Operator abort", description: "Operator Aborted Scanning (gantry or hard key). Counted from the scanmgr message only; exception_class 'Operator Abort' records are separate ermes rows (error.ermes).",
    process: ["scanmgr"],
    extract: event(/Operator Aborted Scanning/, (m, row) => {
      const t = /Scan Type:\s*([^\s].*?)\s+Scan:/.exec(row.message || "");
      return { attrs: t ? { scan_type: t[1] } : null };
    }),
  },
  {
    key: "scan.abort.system", version: 1, category: "reliability", value_kind: "event", unit: null,
    label: "System abort", description: "Records with exception_class 'Abort'. value_text = first line of the message.",
    process: null,
    extract: (row) => (row.exception_class === "Abort"
      ? { value_num: null, value_text: firstLine(row.message), exam_no: null, attrs: { ermes: num(row.ermes_number), severity: row.severity || null } }
      : null),
  },
  {
    key: "scan.safe_state", version: 1, category: "reliability", value_kind: "event", unit: null,
    label: "Safe state", description: "Records with exception_class 'Safe State' (e.g. slip-ring comms down, E-off pressed).",
    process: null,
    extract: (row) => (row.exception_class === "Safe State"
      ? { value_num: null, value_text: firstLine(row.message), exam_no: null, attrs: { ermes: num(row.ermes_number), severity: row.severity || null } }
      : null),
  },
  {
    key: "error.ermes", version: 1, category: "reliability", value_kind: "event", unit: null,
    label: "Error (ermes code)", description: "Any record with an ermes number. value_num = ermes code, value_text = exception class.",
    process: null,
    extract: (row) => (row.ermes_number !== null && row.ermes_number !== undefined && row.ermes_number !== ""
      ? { value_num: num(row.ermes_number), value_text: row.exception_class || null, exam_no: null,
          attrs: { severity: row.severity || null, process: row.process || null } }
      : null),
  },
  {
    key: "system.sw_init_complete", version: 1, category: "reliability", value_kind: "event", unit: null,
    label: "Software initialization complete", description: "cupMonitor 'Software Initialization Complete' (raw). Also fires after process restarts; system boots are derived from it in Phase 3.",
    process: ["cupMonitor"],
    extract: event(/Software Initialization Complete/),
  },
  {
    key: "process.restart", version: 1, category: "reliability", value_kind: "event", unit: null,
    label: "Process restarted", description: "cupMonitor: an unexpected termination caused a process restart. value_text = process.",
    process: ["cupMonitor"],
    extract: (row) => {
      const m = /unexpected termination of\s+(\S+)\s+caused it to be restarted/i.exec(row.message || "");
      return m ? { value_num: null, value_text: m[1], exam_no: null, attrs: null } : null;
    },
  },
  {
    key: "service.mode", version: 1, category: "reliability", value_kind: "event", unit: null,
    label: "Service mode", description: "environmentMgr: system enter/exit service mode. value_text = enter | exit.",
    process: ["environmentMgr"],
    extract: (row) => {
      const m = /System (enter|exit) service mode/i.exec(row.message || "");
      return m ? { value_num: null, value_text: m[1].toLowerCase(), exam_no: null, attrs: null } : null;
    },
  },
  {
    key: "service.calibration", version: 1, category: "reliability", value_kind: "gauge", unit: "°C",
    label: "Service calibration step", description: "scanUtilsRx tube temperature before/after a service calibration (Air, Air Ratio, Basis, Water Phantom ...). value_text = step.",
    process: ["scanUtilsRx"],
    extract: (row) => {
      const m = /Tube temperature (before|after)\s+(.+?)\s+is\s+(-?\d+(?:\.\d+)?)\s+degrees/i.exec(row.message || "");
      return m ? { value_num: num(m[3]), value_text: m[2], exam_no: null, attrs: { phase: m[1].toLowerCase() } } : null;
    },
  },
  {
    key: "das.link_errors", version: 1, category: "reliability", value_kind: "event", unit: null, model_specific: true,
    label: "DAS optical link dropped packets", description: "DAS optical high-speed link dropped packets. attrs = the reported counters.",
    process: ["orp_subsys"],
    extract: event(/Optical high speed link dropped packets/i, (m, row) => {
      const attrs = {};
      const re = /(Optical\w+)\s*:\s*(-?\d+)/g;
      let x;
      while ((x = re.exec(row.message || ""))) attrs[x[1]] = +x[2];
      return { attrs: Object.keys(attrs).length ? attrs : null };
    }),
  },

  {
    key: "ipc.event_router_send_failed", version: 1, category: "reliability", value_kind: "event", unit: null,
    label: "Event Router send failed", description: "Send of a message to the Event Router process failed (any process). value_num = event code, value_text = sending service, attrs.status = failure reason. SME01434 logged ~419k on 2026-08-06 (§12.1).",
    process: null,
    extract: (row) => {
      const m = /Send of message with event code\s+(\d+)\s+from service\s*(\S*)\s+to Event Router process failed with status:\s*([^\n]*)/i.exec(row.message || "");
      return m ? { value_num: num(m[1]), value_text: m[2] || null, exam_no: null, attrs: { status: m[3].trim() || null } } : null;
    },
  },
  {
    key: "ipc.sigpipe", version: 1, category: "reliability", value_kind: "event", unit: null,
    label: "Broken pipe (SIGPIPE)", description: "A process received SIGPIPE (broken pipe). value_text = process.",
    process: null,
    extract: (row) => (/received SIGPIPE, broken pipe/i.test(row.message || "")
      ? { value_num: null, value_text: row.process || null, exam_no: null, attrs: null } : null),
  },
  {
    key: "storage.image_space_error", version: 1, category: "reliability", value_kind: "event", unit: null,
    label: "Image space error", description: "Image space query failed / update received a bad status (image storage). value_text = query_failed | update_bad_status, value_num = error code. SME00881 logged ~56k in 2026-05/06 (§12.1).",
    process: ["dms", "environmentMgr"],
    extract: (row) => {
      const msg = row.message || "";
      let m = /Image space query failed\.\s*Error code:\s*(-?\d+)/i.exec(msg);
      if (m) return { value_num: num(m[1]), value_text: "query_failed", exam_no: null, attrs: null };
      m = /Updating image space, received a bad status code:\s*(-?\d+)/i.exec(msg);
      if (!m) return null;
      const reason = /Reason:\s*([^\n]*)/.exec(msg);
      return { value_num: num(m[1]), value_text: "update_bad_status", exam_no: null, attrs: reason ? { reason: reason[1].trim() } : null };
    },
  },

  // --------------------------------------------------------- compliance
  {
    key: "prep.tube_temp", version: 1, category: "compliance", value_kind: "gauge", unit: "°C",
    label: "Daily prep step", description: "dailyPrepRx tube temperature before/after a daily prep step (Cold Tube Warmup, Fast Calibration, ...). value_text = step; drives prep compliance.",
    process: ["dailyPrepRx"],
    extract: (row) => {
      const m = /Tube temperature (before|after)\s+(.+?)\s+is\s+(-?\d+(?:\.\d+)?)\s+degrees/i.exec(row.message || "");
      return m ? { value_num: num(m[3]), value_text: m[2], exam_no: null, attrs: { phase: m[1].toLowerCase() } } : null;
    },
  },
  {
    key: "op.scan_in_warmup_zone", version: 1, category: "compliance", value_kind: "event", unit: null, model_specific: true,
    label: "Scan confirmed in warm-up zone", description: "Scanning confirmed while the tube was in the yellow warm-up zone.",
    process: ["scanRx"],
    extract: (row) => {
      const m = /Scanning was confirmed for exam\s+(\d+)\s+while the X-ray tube state was in the yellow warm up zone/i.exec(row.message || "");
      return m ? { value_num: null, value_text: null, exam_no: m[1], attrs: null } : null;
    },
  },
  {
    key: "op.warmup_skipped", version: 1, category: "compliance", value_kind: "event", unit: null, model_specific: true,
    label: "Tube warm-up skipped", description: "Tube warm-up skipped; limited mA used for the exam. attrs = the mA limits.",
    process: ["scanRx"],
    extract: (row) => {
      const msg = row.message || "";
      const m = /Tube warm up was skipped\.\s*Limited mA will be used for exam\s+(\d+)/i.exec(msg);
      if (!m) return null;
      const attrs = {};
      const s = /Max small spot mA\s*=\s*(\d+),\s*max large spot mA\s*=\s*(\d+)/i.exec(msg);
      if (s) Object.assign(attrs, { max_small_spot_ma: +s[1], max_large_spot_ma: +s[2] });
      const re = /Max mA for\s*(\d+)kV\s*=\s*(\d+)/gi;
      let x;
      while ((x = re.exec(msg))) attrs[`max_ma_${x[1]}kv`] = +x[2];
      return { value_num: null, value_text: null, exam_no: m[1], attrs: Object.keys(attrs).length ? attrs : null };
    },
  },
  {
    key: "compliance.dose_display_disabled", version: 1, category: "compliance", value_kind: "event", unit: null, model_specific: true,
    label: "Dose information display disabled", description: "scanRx: Dose information database (Ctdi.cfg) read error, dose information display disabled. Emitted once per failed token path. Data only until confirmed by field service (§12).",
    process: ["scanRx"],
    extract: (row) => {
      const msg = row.message || "";
      if (!/Dose information database \(Ctdi\.cfg\) read error\.\s*Disabled dose information display feature/i.test(msg)) return null;
      const t = /Failed token path:\s*([^\n]*?)\s*$/m.exec(msg);
      return { value_num: null, value_text: t ? t[1] : null, exam_no: null, attrs: null };
    },
  },
  {
    key: "calibration.air_overdue", version: 1, category: "compliance", value_kind: "gauge", unit: "days", model_specific: true,
    label: "Air ratio calibration overdue", description: "Only the large spot is allowed because no air ratio calibration was done in more than N days (value_num = N). Data only until confirmed by field service (§12).",
    process: ["scanRx"],
    extract: (row) => {
      const msg = row.message || "";
      const m = /no air ratio calibration was done more than\s+(\d+)\s+days/i.exec(msg);
      if (!m) return null;
      const t = /Current tube temperature is\s+(-?\d+(?:\.\d+)?)\s+degrees/i.exec(msg);
      return { value_num: num(m[1]), value_text: null, exam_no: null, attrs: t ? { tube_temp_c: num(t[1]) } : null };
    },
  },

  // -------------------------------------------------------- environment
  {
    key: "env.plenum_temp", version: 1, category: "environment", value_kind: "gauge", unit: "°C", model_specific: true,
    label: "Plenum temperature out of tolerance", description: "Plenum temperature out of tolerance. value_num = filtered average in °C (normalized; one firmware reports 1/100 °C). value_text = which sensor tripped.",
    process: ["orp_subsys"],
    extract: (row) => {
      const msg = row.message || "";
      if (/CFHC has recovered/i.test(msg) || !/Plenum[\s\S]*Temperature Out of Tolerance/i.test(msg)) return null;
      const p = parsePlenum(msg);
      const which = /Plenum\s+Plenum\s+(.+?)\s+Temperature Out of Tolerance/i.exec(msg) || /Plenum\s+(\d+)\s+Temperature Out of Tolerance/i.exec(msg);
      return { value_num: p ? p.filtered_avg : null, value_text: which ? which[1] : null, exam_no: null, attrs: p };
    },
  },
  {
    key: "env.plenum_recovered", version: 1, category: "environment", value_kind: "event", unit: null, model_specific: true,
    label: "Plenum temperature recovered", description: "The CFHC has recovered from a plenum out-of-tolerance error.",
    process: ["orp_subsys"],
    extract: (row) => {
      const msg = row.message || "";
      if (!/CFHC has recovered[\s\S]*Plenum/i.test(msg)) return null;
      const p = parsePlenum(msg);
      return { value_num: p ? p.filtered_avg : null, value_text: null, exam_no: null, attrs: p };
    },
  },
  {
    key: "env.detector_temp_low", version: 1, category: "environment", value_kind: "gauge", unit: "°C", model_specific: true,
    label: "Detector temperature low", description: "Detector temperature is low; image quality may be affected. value_num = reading.",
    process: null,
    extract: (row) => {
      const msg = row.message || "";
      if (!/Detector Temperature Is Low/i.test(msg)) return null;
      const m = /Current Reading:\s*(-?\d+(?:\.\d+)?)\s*Deg C/i.exec(msg);
      return { value_num: m ? num(m[1]) : null, value_text: null, exam_no: null, attrs: null };
    },
  },
  {
    key: "env.psu_temp_out_of_spec", version: 1, category: "environment", value_kind: "gauge", unit: "°C", model_specific: true,
    label: "Power supply temperature out of spec", description: "Health Readiness Service: a power supply read a temperature out of specification. value_text = supply, value_num = °C.",
    process: ["event_logger"],
    extract: (row) => {
      const msg = row.message || "";
      const m = /The\s+(.+?)\s+power supply read a temperature which is out of specification[\s\S]*?Actual reading\s*=\s*(-?\d+)\s*millidegC/i.exec(msg);
      if (!m) return null;
      const hi = /Hi limit\s*=\s*(-?\d+)\s*millidegC/i.exec(msg);
      return { value_num: +m[2] / 1000, value_text: m[1], exam_no: null, attrs: hi ? { hi_limit_c: +hi[1] / 1000 } : null };
    },
  },
  {
    key: "env.psu_voltage_out_of_spec", version: 1, category: "environment", value_kind: "gauge", unit: "mV", model_specific: true,
    label: "Power supply voltage out of spec", description: "Health Readiness Service: a power supply read a voltage out of specification. value_text = supply.",
    process: ["event_logger"],
    extract: (row) => {
      const msg = row.message || "";
      const m = /The\s+(.+?)\s+power supply read a voltage which is out of specification[\s\S]*?Actual reading\s*=\s*(-?\d+)\s*mV/i.exec(msg);
      if (!m) return null;
      const lim = /Hi limit\s*=\s*(-?\d+)\s*mV,\s*Low limit\s*=\s*(-?\d+)\s*mV/i.exec(msg);
      return { value_num: +m[2], value_text: m[1], exam_no: null, attrs: lim ? { hi_limit_mv: +lim[1], low_limit_mv: +lim[2] } : null };
    },
  },
  {
    key: "env.humidity_out_of_range", version: 1, category: "environment", value_kind: "gauge", unit: "%RH", model_specific: true,
    label: "Gantry humidity out of range", description: "TempHumidityService: ambient gantry humidity out of range. value_num = %RH.",
    process: ["event_logger"],
    extract: (row) => {
      const m = /humidity out of range[\s\S]*?Actual Value:\s*(-?\d+)\s*milliRH/i.exec(row.message || "");
      return m ? { value_num: +m[1] / 1000, value_text: null, exam_no: null, attrs: null } : null;
    },
  },

  // ---------------------------------------------------------- inventory
  {
    key: "inventory.product", version: 1, category: "inventory", value_kind: "text", unit: null,
    label: "Product configuration", description: "Svc_Notepad PRODUCT CONFIGURATION. value_text = product; attrs = software and hardware strings (host_id deliberately not kept).",
    process: ["Svc_Notepad"],
    extract: (row) => {
      const msg = row.message || "";
      const i = msg.indexOf("PRODUCT CONFIGURATION|");
      if (i < 0) return null;
      const fields = {};
      for (const part of msg.slice(i + "PRODUCT CONFIGURATION|".length).split("|")) {
        const kv = /^\s*([^:]+?)\s*:\s*(.*?)\s*$/.exec(part);
        if (kv) fields[kv[1]] = kv[2];
      }
      if (!fields.Product) return null;
      const keep = ["sw_version", "sw_hw_string", "machine_type", "tube_type", "gantry_type"];
      const attrs = {};
      for (const k of keep) if (fields[k] !== undefined) attrs[k] = fields[k];
      return { value_num: null, value_text: fields.Product, exam_no: null, attrs };
    },
  },
];

module.exports = { rules, parseSeries, parsePlenum };
