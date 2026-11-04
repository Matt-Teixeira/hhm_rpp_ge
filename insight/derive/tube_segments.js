"use strict";
// Stage 4: insight.ge_ct_tube_segments (§13.2 item 1). Always rebuilt per
// system (a system has a few hundred counter readings).
//
// Segments are split at the confirmed resets from rules/ge_ct_derived.js,
// so they agree with the tube.replacement facts by construction:
//   - the first segment is `initial` (already running when data starts;
//     no install date)
//   - later segments take confidence / install_date / tube_source from the
//     replacement fact that opened them
//   - a trailing pending reset (not yet confirmed low) is left out of the
//     current segment and recorded in its evidence
const { pgp } = require("../db");
const { find_resets, tube_source, derive_system_facts, TUBE } = require("../rules/ge_ct_derived");
const { load_facts, insert_rows, DAY_MS } = require("./common");

const KEYS = ["tube.mas_total", "service.calibration", "tube.identity"];

const SEG_CS = new pgp.helpers.ColumnSet(
  ["system_id", "segment_start", "segment_end", { name: "install_date", cast: "date" }, "install_confidence", "tube_source",
    "start_mas", "latest_mas", "latest_at", "mas_per_day", "readings", "ended_reason",
    { name: "evidence", init: (c) => (c.value === null || c.value === undefined ? null : JSON.stringify(c.value)), cast: "jsonb" }],
  { table: new pgp.helpers.TableName({ table: "ge_ct_tube_segments", schema: "insight" }) }
);

const ms = (f) => new Date(f.host_datetime).getTime();
const iso = (f) => new Date(ms(f)).toISOString();

// Pure: one system's tube facts -> segment rows.
function build_segments(facts) {
  const readings = facts.filter((f) => f.metric_key === "tube.mas_total");
  const identity = facts.filter((f) => f.metric_key === "tube.identity");
  const { readings: rs, resets, pending } = find_resets(readings);
  const cut = pending ? pending.index : rs.length;
  if (!cut) return [];
  const reps = derive_system_facts(facts).filter((f) => f.metric_key === "tube.replacement");
  const repAt = new Map(reps.map((r) => [`${r.epoch}|${r.record_number_concurrent}|${ms(r)}`, r]));
  const bounds = [0, ...resets.map((r) => r.index), cut];
  const rows = [];
  for (let k = 0; k < bounds.length - 1; k++) {
    const seg = rs.slice(bounds[k], bounds[k + 1]);
    const first = seg[0], last = seg[seg.length - 1];
    const isLast = k === bounds.length - 2;
    const spanDays = (ms(last) - ms(first)) / DAY_MS;
    const row = {
      system_id: first.system_id, segment_start: new Date(ms(first)), segment_end: isLast ? null : new Date(ms(last)),
      start_mas: first.value_num, latest_mas: last.value_num, latest_at: new Date(ms(last)),
      mas_per_day: spanDays >= 1 ? (last.value_num - first.value_num) / spanDays : null,
      readings: seg.length, ended_reason: isLast ? null : "replacement",
    };
    if (k === 0) {
      const nextStart = bounds.length > 2 ? ms(rs[bounds[1]]) : Infinity;
      const src = tube_source(identity, ms(first), Math.min(ms(first) + TUBE.source_window_ms, nextStart));
      Object.assign(row, { install_date: null, install_confidence: "initial", tube_source: src.tube_source,
        evidence: { tube_source_counts: src.counts } });
    } else {
      const rep = repAt.get(`${first.epoch}|${first.record_number_concurrent}|${ms(first)}`);
      if (!rep) throw new Error(`${first.system_id}: no tube.replacement fact for the reset at ${iso(first)}`);
      const a = rep.attrs;
      Object.assign(row, { install_date: a.install_date, install_confidence: a.confidence, tube_source: a.tube_source,
        evidence: { reset_source_id: Number(rep.source_id), old_mas: a.old_mas, new_mas: a.new_mas,
          calibrations_in_window: a.calibrations_in_window, first_calibration_at: a.first_calibration_at,
          tube_source_counts: a.tube_source_counts } });
    }
    if (isLast && pending) {
      row.evidence.pending_reset = { at: iso(pending.reading), value: pending.reading.value_num, prior: pending.prior.value_num };
    }
    rows.push(row);
  }
  return rows;
}

async function rebuild_tube_segments(t, system_id) {
  const facts = await load_facts(t, system_id, KEYS);
  const rows = build_segments(facts);
  const del = await t.result("DELETE FROM insight.ge_ct_tube_segments WHERE system_id = $1", [system_id]);
  const inserted = await insert_rows(t, rows, SEG_CS);
  return { deleted: del.rowCount, inserted, replacements: rows.filter((r) => r.install_confidence !== "initial").length };
}

module.exports = { rebuild_tube_segments, build_segments };
