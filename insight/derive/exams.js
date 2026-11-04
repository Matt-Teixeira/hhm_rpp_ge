"use strict";
// Stage 3: insight.ge_ct_exams (§13.2 item 5).
//
// One row per exam.start (system, exam_no, started_at). The exam's window
// runs to the next exam.start on the same system, in (time, epoch, rnc)
// order; the last exam's window is open. Series / scans / images come from
// the LAST exam.series in the window; aborts are the scan.abort.* facts in
// it. A start whose exam_no was started before is marked reopened.
//
//   full system : rebuild all of the system's exams
//   touched days: rebuild from the last exam that started before the
//                 earliest touched day (its window may have grown), onward
const { pgp } = require("../db");
const { load_facts, cmp, insert_rows } = require("./common");

const EVENT_KEYS = ["exam.series", "scan.abort.operator", "scan.abort.system"];

const EXAM_CS = new pgp.helpers.ColumnSet(
  ["system_id", "exam_no", "started_at", "last_activity_at", { name: "local_day", cast: "date" }, "protocol",
    "series", "scans", "images", "aborts_operator", "aborts_system",
    { name: "attrs", init: (c) => (c.value === null || c.value === undefined ? null : JSON.stringify(c.value)), cast: "jsonb" }],
  { table: new pgp.helpers.TableName({ table: "ge_ct_exams", schema: "insight" }) }
);

const ms = (f) => new Date(f.host_datetime).getTime();
const int = (x) => (Number.isFinite(Number(x)) ? Math.max(0, Math.trunc(Number(x))) : 0);

// Pure. starts: ALL exam.start facts of the system (for reopened);
// events: exam.series / scan.abort.* facts from the anchor on. Returns rows
// for starts at or after `from` (a start fact, or null for all).
function build_exams(starts, events, from = null) {
  const S = [...starts].sort(cmp);
  const E = [...events].sort(cmp);
  const seen = new Set();
  const rows = [];
  let e = 0;
  for (let i = 0; i < S.length; i++) {
    const s = S[i];
    const reopened = seen.has(s.exam_no);
    seen.add(s.exam_no);
    const next = S[i + 1] || null;
    // events strictly before this start belong to an earlier exam (or none)
    while (e < E.length && cmp(E[e], s) < 0) e++;
    let lastSeries = null, nSeries = 0, abOp = 0, abSys = 0, lastAt = ms(s);
    let j = e;
    for (; j < E.length && (next === null || cmp(E[j], next) < 0); j++) {
      const ev = E[j];
      if (ev.metric_key === "exam.series") { lastSeries = ev; nSeries++; }
      else if (ev.metric_key === "scan.abort.operator") abOp++;
      else if (ev.metric_key === "scan.abort.system") abSys++;
      lastAt = Math.max(lastAt, ms(ev));
    }
    e = j;
    if (from && cmp(s, from) < 0) continue;
    const a = (lastSeries && lastSeries.attrs) || {};
    rows.push({
      system_id: s.system_id, exam_no: s.exam_no, started_at: new Date(ms(s)), last_activity_at: new Date(lastAt),
      local_day: String(s.host_local).slice(0, 10), protocol: s.value_text,
      series: lastSeries ? int(a.ct_series) : 0, scans: lastSeries ? int(a.ct_scans) : 0,
      images: lastSeries ? int(a.ct_images !== undefined ? a.ct_images : lastSeries.value_num) : 0,
      aborts_operator: abOp, aborts_system: abSys,
      attrs: { reopened, series_summaries: nSeries, ...(a.pet ? { pet_series: a.pet.length } : {}) },
    });
  }
  return rows;
}

// Pure: the anchor start for an incremental rebuild = the last start whose
// device-clock day is before the earliest touched day (null = rebuild all).
function anchor_for(starts, days) {
  const first = [...days].sort()[0];
  let anchor = null;
  for (const s of [...starts].sort(cmp)) if (String(s.host_local).slice(0, 10) < first) anchor = s;
  return anchor;
}

async function rebuild_exams(t, system_id, sysScope) {
  const starts = await load_facts(t, system_id, ["exam.start"]);
  let anchor = null;
  if (!sysScope.full) {
    if (!sysScope.days.size) return { deleted: 0, inserted: 0 };
    anchor = anchor_for(starts, sysScope.days);
  }
  const events = await load_facts(t, system_id, EVENT_KEYS, anchor ? anchor.host_datetime : null);
  const rows = build_exams(starts, events, anchor);
  const del = anchor
    ? await t.result("DELETE FROM insight.ge_ct_exams WHERE system_id = $1 AND started_at >= $2", [system_id, anchor.host_datetime])
    : await t.result("DELETE FROM insight.ge_ct_exams WHERE system_id = $1", [system_id]);
  const inserted = await insert_rows(t, rows, EXAM_CS);
  return { deleted: del.rowCount, inserted, from: anchor ? new Date(ms(anchor)).toISOString() : null };
}

module.exports = { rebuild_exams, build_exams, anchor_for, EVENT_KEYS };
