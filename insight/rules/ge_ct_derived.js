"use strict";
// Derived-fact rules for GE CT (PLAN-CT-INSIGHTS.md §13.2 items 1 and 4).
//
// Unlike the per-row rules in ge_ct.js, these read a system's facts in
// context (neighbouring readings, events in a time window). Each rule is a
// pure function: (facts of one system, by metric) -> derived facts. No DB,
// no clock. A derived fact is keyed on its source record (the init row or
// the reset reading), so it shares that record's natural-key columns and
// differs only in metric_key.
//
// The output for a system is complete: derive replaces the system's derived
// facts with it (a reading that later turns out to be a glitch disappears).
//
// Times: windows and ordering use host_datetime (absolute). Dates reported
// to people (install_date) use the device wall clock (host_local), §12.

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

// ------------------------------------------------------------ system.boot
// A boot is a system.sw_init_complete with no process.restart in the 5 min
// before it and >= 10 min since the previous init (of any kind). It is
// clean if a system.shutdown happened since the previous boot.
const BOOT = {
  restart_window_ms: 5 * MIN,
  min_gap_ms: 10 * MIN,
};

// ------------------------------------------------------- tube.replacement
// A reset is a tube.mas_total reading below RESET_RATIO of the previous
// reading, where the previous reading is above MIN_PRIOR_MAS, and the
// counter stays low: at least MIN_FOLLOWING later readings exist and the
// next (up to) CHECK_FOLLOWING readings are all below RESET_RATIO of the
// previous reading. With fewer later readings the reset is pending (not
// emitted yet; a later run decides).
// confirmed = at least MIN_CALIBRATIONS service.calibration facts in
// [reset - 7 d, reset + 1 d]; otherwise counter_only (field-service review).
const TUBE = {
  reset_ratio: 0.5,
  min_prior_mas: 100000,
  min_following: 2,
  check_following: 3,
  cal_before_ms: 7 * DAY,
  cal_after_ms: 1 * DAY,
  min_calibrations: 3,
  source_window_ms: 30 * DAY,
};

const t = (f) => new Date(f.host_datetime).getTime();
// host_local must be the device wall clock as text ('YYYY-MM-DDTHH:MI:SS',
// as extract.js and the derive loader select it). A JS Date here would mean
// the driver re-interpreted the wall clock in the process time zone.
function localDate(f) {
  if (typeof f.host_local !== "string" || !/^\d{4}-\d{2}-\d{2}[T ]/.test(f.host_local)) {
    throw new Error(`host_local must be 'YYYY-MM-DDTHH:MI:SS' text, got ${Object.prototype.toString.call(f.host_local)} ${String(f.host_local).slice(0, 30)}`);
  }
  return f.host_local.slice(0, 10);
}
// Stable order within a system: absolute time, then the device's record order.
const byTime = (a, b) => t(a) - t(b) || a.epoch - b.epoch || a.record_number_concurrent - b.record_number_concurrent;
const sorted = (arr) => [...(arr || [])].sort(byTime);
const minutes = (ms) => Math.round((ms / MIN) * 10) / 10;

// Derived fact on the source record's key.
function on_source(src, rule, out) {
  return {
    system_id: src.system_id, epoch: src.epoch, record_number_concurrent: src.record_number_concurrent,
    host_datetime: src.host_datetime, host_local: src.host_local,
    source_id: src.source_id, source_capture_datetime: src.source_capture_datetime,
    metric_key: rule.key, rule_version: rule.version, exam_no: null,
    value_num: out.value_num === undefined ? null : out.value_num,
    value_text: out.value_text === undefined ? null : out.value_text,
    attrs: out.attrs === undefined ? null : out.attrs,
  };
}

function derive_boots(byMetric, rule) {
  const inits = sorted(byMetric["system.sw_init_complete"]);
  const restarts = sorted(byMetric["process.restart"]).map(t);
  const shutdowns = sorted(byMetric["system.shutdown"]).map(t);
  const out = [];
  let prevInit = null;   // ms
  let prevBoot = null;   // ms
  let r = 0;             // restarts[r] is the first restart >= init - window (two-pointer)
  for (const init of inits) {
    const ti = t(init);
    while (r < restarts.length && restarts[r] < ti - BOOT.restart_window_ms) r++;
    const restartBefore = r < restarts.length && restarts[r] <= ti;
    const gap = prevInit === null ? null : ti - prevInit;
    prevInit = ti;
    if (restartBefore || (gap !== null && gap < BOOT.min_gap_ms)) continue;
    const shutdown = shutdowns.some((s) => s <= ti && (prevBoot === null || s > prevBoot));
    out.push(on_source(init, rule, {
      value_text: shutdown ? "clean" : "unclean",
      attrs: {
        clean: shutdown,
        since_prev_init_min: gap === null ? null : minutes(gap),
        since_prev_boot_h: prevBoot === null ? null : Math.round(((ti - prevBoot) / HOUR) * 10) / 10,
      },
    }));
    prevBoot = ti;
  }
  return out;
}

// Tube source of a segment: the tube.identity verdict in its first 30 days
// (§13.2 item 1, refined 2026-11-04). The most frequent of verified /
// unrecognized; no_smart_id only when neither appears (it is a companion
// line logged next to the verdict at every boot). An exact tie goes to the
// value seen first. Returns { tube_source, counts }.
function tube_source(identity, startMs, endMs) {
  const counts = { verified: 0, unrecognized: 0, no_smart_id: 0 };
  const first = {}; // verdict -> position in (time, epoch, rnc) order, so same-second ties follow record order
  sorted(identity).forEach((f, pos) => {
    const ms = t(f);
    if (ms < startMs || ms >= endMs || !(f.value_text in counts)) return;
    counts[f.value_text]++;
    if (!(f.value_text in first)) first[f.value_text] = pos;
  });
  let src = null;
  if (counts.verified || counts.unrecognized) {
    if (counts.verified !== counts.unrecognized) src = counts.verified > counts.unrecognized ? "verified" : "unrecognized";
    else src = first.verified < first.unrecognized ? "verified" : "unrecognized";
  } else if (counts.no_smart_id) src = "no_smart_id";
  return { tube_source: src, counts };
}

// All confirmed-low resets of a system, in order. Exported for tube segments.
function find_resets(readings) {
  const rs = sorted(readings).filter((f) => typeof f.value_num === "number" && Number.isFinite(f.value_num));
  const resets = [];
  for (let i = 1; i < rs.length; i++) {
    const prev = rs[i - 1].value_num;
    const v = rs[i].value_num;
    if (!(prev > TUBE.min_prior_mas && v < TUBE.reset_ratio * prev)) continue;
    const following = rs.slice(i + 1, i + 1 + TUBE.check_following);
    if (following.length < TUBE.min_following) continue; // pending
    if (!following.every((f) => f.value_num < TUBE.reset_ratio * prev)) continue; // glitch: came back up
    resets.push({ index: i, reading: rs[i], prior: rs[i - 1] });
  }
  return { readings: rs, resets };
}

function derive_replacements(byMetric, rule) {
  const { resets } = find_resets(byMetric["tube.mas_total"]);
  const cals = sorted(byMetric["service.calibration"]);
  const identity = byMetric["tube.identity"] || [];
  return resets.map((x, k) => {
    const tr = t(x.reading);
    const inWindow = cals.filter((c) => t(c) >= tr - TUBE.cal_before_ms && t(c) <= tr + TUBE.cal_after_ms);
    const confidence = inWindow.length >= TUBE.min_calibrations ? "confirmed" : "counter_only";
    const install_date = inWindow.length ? localDate(inWindow[0]) : localDate(x.reading);
    const next = resets[k + 1];
    const end = Math.min(tr + TUBE.source_window_ms, next ? t(next.reading) : Infinity);
    const src = tube_source(identity, tr, end);
    return on_source(x.reading, rule, {
      value_num: x.prior.value_num,
      value_text: confidence,
      attrs: {
        confidence,
        install_date,
        old_mas: x.prior.value_num,
        old_last_reading_at: new Date(x.prior.host_datetime).toISOString(),
        new_mas: x.reading.value_num,
        calibrations_in_window: inWindow.length,
        first_calibration_at: inWindow.length ? new Date(inWindow[0].host_datetime).toISOString() : null,
        tube_source: src.tube_source,
        tube_source_counts: src.counts,
      },
    });
  });
}

const derived_rules = [
  {
    key: "system.boot", version: 1, category: "reliability", value_kind: "event", unit: null,
    label: "System boot",
    description: "Derived: a Software Initialization Complete with no process restart in the 5 min before and >= 10 min since the previous init. value_text = clean (a desktop shutdown since the previous boot) | unclean.",
    inputs: ["system.sw_init_complete", "process.restart", "system.shutdown"],
    derive: derive_boots,
  },
  {
    key: "tube.replacement", version: 1, category: "tube", value_kind: "event", unit: "mA·s",
    label: "Tube replacement",
    description: "Derived: tube mA·s counter reset that stays low. value_text = confirmed (>= 3 service calibrations in [reset - 7 d, reset + 1 d]) | counter_only (needs field-service review); value_num = old tube mA·s. attrs: install_date, old/new mA·s, tube_source.",
    inputs: ["tube.mas_total", "service.calibration", "tube.identity"],
    derive: derive_replacements,
  },
];

const DERIVED_KEYS = derived_rules.map((r) => r.key);
const INPUT_KEYS = [...new Set(derived_rules.flatMap((r) => r.inputs))];

// Pure: one system's facts (any order, any metrics) -> derived facts.
function derive_system_facts(facts) {
  const byMetric = {};
  for (const f of facts) (byMetric[f.metric_key] = byMetric[f.metric_key] || []).push(f);
  const out = [];
  for (const r of derived_rules) out.push(...r.derive(byMetric, r));
  return out;
}

function validate_derived_rules(rules, base_rules) {
  const errors = [];
  const baseKeys = new Set(base_rules.map((r) => r.key));
  for (const r of rules) {
    if (baseKeys.has(r.key)) errors.push(`${r.key}: collides with a per-row rule`);
    if (typeof r.derive !== "function") errors.push(`${r.key}: derive must be a function`);
    for (const k of r.inputs || []) if (!baseKeys.has(k)) errors.push(`${r.key}: unknown input ${k}`);
  }
  // shared metadata checks (key format, category, value_kind, version, label)
  const { validate_rules } = require("./engine");
  errors.push(...validate_rules(rules.map((r) => ({ ...r, extract: () => null, process: null }))));
  return errors;
}

module.exports = {
  derived_rules, derive_system_facts, validate_derived_rules, find_resets, tube_source,
  DERIVED_KEYS, INPUT_KEYS, BOOT, TUBE,
};
