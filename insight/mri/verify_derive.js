"use strict";
// The MRI-3 exit check (PLAN-MRI-INSIGHTS.md §4: "verifiers pass"; §8),
// on any connection or transaction (the rehearsal runs it on its
// uncommitted rows). Source rows up to the extract watermark (or `to`).
//
//   A  daily per (system, device day, metric), summed over dims = the
//      independent count from log.ge_mri_gesys (reconcile_sql.js
//      conditions on the deduped records; device day = host_date, not
//      epoch);
//   B  mri.error per (system, device day, code) = the source count;
//   C  daily = a plain GROUP BY over the facts, every column, both ways;
//   D  ge_mri_codes = the same fields rebuilt from the source in SQL: n,
//      systems, first / last seen (host_date + host_time), the most common
//      process, the reviewed category, and the label (the labels.js
//      masking rewritten in PostgreSQL regexes, not the JS function) with
//      its share. Ties: smallest, COLLATE "C";
//   E  no label holds a host name, an IPv4 / MAC address or a system id;
//   F  each derived query (derived_sql.js) = an independent JS computation
//      from the facts: capabilities, inventory, software sessions, service
//      sessions, deaths with the restart mark;
//   +  pending days left for any system (a note).
// Nothing in the GE CT or CV run loads this file.
const { COND, STORABLE } = require("./reconcile_sql");
const { JOB, DERIVE_JOB } = require("./load");
const { CODE_CATEGORY } = require("./codes_reviewed");
const { LABEL_MAX, MIN_HOST } = require("./labels");
const D = require("./derived_sql");

// The deduped storable records (first row per natural key), with what A, B and D need.
const BASE = `
  SELECT DISTINCT ON (system_id, epoch, record_number_concurrent)
         id, system_id, message_number, type, message, to_date(host_date, 'DD-Mon-YYYY') AS day,
         to_date(host_date, 'DD-Mon-YYYY') + host_time AS at
  FROM log.ge_mri_gesys
  WHERE id <= $1 AND ${STORABLE}
  ORDER BY system_id, epoch, record_number_concurrent, id`;

const A_SRC = `
WITH base AS (${BASE})
SELECT system_id, day::text AS day, k.key, count(*)::int AS n
FROM base CROSS JOIN LATERAL (VALUES
${Object.entries(COND).map(([k, c]) => `  ('${k}', coalesce(${c}, false))`).join(",\n")}
) AS k(key, hit)
WHERE k.hit GROUP BY 1, 2, 3`;
const A_DAILY = `SELECT system_id, local_day::text AS day, metric_key AS key, sum(n)::int AS n FROM insight.ge_mri_daily GROUP BY 1, 2, 3`;

const B_SRC = `WITH base AS (${BASE}) SELECT system_id, day::text AS day, message_number::text AS key, count(*)::int AS n FROM base GROUP BY 1, 2, 3`;
const B_DAILY = `SELECT system_id, local_day::text AS day, dim AS key, n::int FROM insight.ge_mri_daily WHERE metric_key = 'mri.error'`;

const C_SQL = `
WITH g AS (
  SELECT f.system_id, f.host_local::date AS local_day, f.metric_key, f.dim, count(*) AS n,
         sum(f.value_num) AS value_sum, min(f.value_num) AS value_min, max(f.value_num) AS value_max,
         (array_agg(f.value_num ORDER BY f.host_local DESC, f.record_number_concurrent DESC, f.id DESC))[1] AS value_last,
         min(f.host_local) AS first_at, max(f.host_local) AS last_at
  FROM insight.ge_mri_facts f GROUP BY 1, 2, 3, 4
), d AS (
  SELECT system_id, local_day, metric_key, dim, n, value_sum, value_min, value_max, value_last, first_at, last_at FROM insight.ge_mri_daily
)
SELECT (SELECT count(*) FROM (SELECT * FROM g EXCEPT SELECT * FROM d) x)::int AS missing_in_daily,
       (SELECT count(*) FROM (SELECT * FROM d EXCEPT SELECT * FROM g) x)::int AS extra_in_daily,
       (SELECT count(*) FROM d)::int AS daily_rows`;

// Every host name seen in the source, as one alternation (every character
// other than a letter, digit, '_' or '-' escaped; longest first).
const HOSTS_ALT = String.raw`
  SELECT string_agg(regexp_replace(h, '([^A-Za-z0-9_-])', '\\\1', 'g'), '|' ORDER BY length(h) DESC, h COLLATE "C") AS alt
  FROM (SELECT DISTINCT btrim(split_part(type, E'\t', 1)) AS h FROM log.ge_mri_gesys WHERE type LIKE E'%\t%') x
  WHERE length(h) >= ${MIN_HOST}`;

// The labels.js template, by its definition, in PostgreSQL regexes. `m0` =
// the message made ASCII; `alt` = the host alternation. Written with
// String.raw: every backslash below reaches PostgreSQL as written.
const MON = "Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec";
const DAY = "Mon|Tue|Wed|Thu|Fri|Sat|Sun";
const R = (x, pat, rep, flags = "g") => `regexp_replace(${x}, '${pat}', '${rep}', '${flags}')`;
function tpl_sql() {
  let x = R("m0", String.raw`\\n|\\r|\r\n|\n|\r`, " | ");
  x = `CASE WHEN alt IS NULL THEN ${x} ELSE regexp_replace(${x}, '(?<![A-Za-z0-9_])(' || alt || ')(?![A-Za-z0-9_])', '<host>', 'gi') END`;
  x = R(x, String.raw`\y([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}\y`, "<mac>");
  x = R(x, String.raw`SERIAL=[^[:space:]]+`, "SERIAL=<serial>");
  x = R(x, String.raw`\y[0-9]{1,3}(\.[0-9]{1,3}){3}\y`, "<ip>");
  x = R(x, String.raw`0x[0-9a-fA-F]+`, "#");
  x = R(x, String.raw`[0-9]+`, "#");
  x = R(x, String.raw`\y(${DAY}) (${MON}) # #:#:# [A-Z]{3} #`, "<date>");
  x = R(x, String.raw`\y(${MON}) #, # #:#:# [AP]M\y`, "<date>");
  x = R(x, String.raw`\y(${DAY}) #/#/# #:#:#\.# [AP]M [A-Z]{3}`, "<date>");
  x = R(x, String.raw`push failed: [^[:space:]]+ could not perform`, "push failed: <ae> could not perform");
  x = R(x, String.raw`Message received from [^[:space:]]+ -`, "Message received from <ae> -");
  x = R(x, String.raw`Operation timed out \[[^]]*\]`, "Operation timed out [<ae>]");
  x = R(x, String.raw`No Route to [^.]+\.`, "No Route to <ae>.");
  x = R(x, String.raw`Network session creation for [^[:space:]]+`, "Network session creation for <ae>");
  x = R(x, String.raw`(Association was rejected from|ECHO was received from|rejected by the remote host) [^[:space:].]+`, String.raw`\1 <ae>`);
  x = R(x, String.raw`Resetting ARS [^[:space:]]+ - .*$`, "Resetting ARS <device> - <build>", "");
  x = R(x, String.raw`host: [^[:space:]]+:`, "host <host>:", "gi");
  x = R(x, String.raw`^<date> com\.ge\.[A-Za-z0-9_.$]+ [A-Za-z0-9_]+([[:space:]]*\|)?[[:space:]]*`, "", "");
  x = R(x, String.raw`([[:space:]]*\|[[:space:]]*)+`, " | ");
  x = R(x, String.raw`[[:space:]]+`, " ");
  x = R(x, String.raw`^[[:space:]|]+|[[:space:]|]+$`, "");
  return `nullif(left(${x}, ${LABEL_MAX}), '')`;
}
const TPL_SQL = tpl_sql();
const ASCII_SQL = String.raw`regexp_replace(coalesce(message, ''), '[^\x01-\x7f]', '?', 'g')`;
// process_of(type): after the first tab (or the whole type), trimmed; '' -> none.
const PROC_SQL = String.raw`nullif(btrim(CASE WHEN position(E'\t' in coalesce(type, '')) > 0 THEN substr(type, position(E'\t' in type) + 1) ELSE coalesce(type, '') END, E' \t\n\r\f\x0b'), '')`;

const D_SRC = `
WITH h AS (${HOSTS_ALT}),
t0 AS (SELECT b.*, ${ASCII_SQL} AS m0, ${PROC_SQL} AS proc FROM (${BASE}) b),
t AS (SELECT t0.*, ${TPL_SQL} AS tpl FROM t0, h),
agg AS (SELECT message_number, count(*)::int AS n, count(DISTINCT system_id)::int AS systems,
               to_char(min(at), 'YYYY-MM-DD"T"HH24:MI:SS') AS first_seen, to_char(max(at), 'YYYY-MM-DD"T"HH24:MI:SS') AS last_seen FROM t GROUP BY 1),
pr AS (SELECT DISTINCT ON (message_number) message_number, proc FROM (SELECT message_number, proc, count(*) AS c FROM t WHERE proc IS NOT NULL GROUP BY 1, 2) x ORDER BY message_number, c DESC, proc COLLATE "C"),
lab AS (SELECT DISTINCT ON (message_number) message_number, tpl, c FROM (SELECT message_number, tpl, count(*) AS c FROM t WHERE tpl IS NOT NULL GROUP BY 1, 2) x ORDER BY message_number, c DESC, tpl COLLATE "C"),
cat AS (SELECT * FROM unnest($2::int[], $3::text[]) AS c(message_number, category))
SELECT agg.message_number, coalesce(pr.proc, '') AS process, cat.category, lab.tpl AS label, lab.c::float8 / agg.n AS label_share,
       agg.n, agg.systems, agg.first_seen, agg.last_seen
FROM agg LEFT JOIN pr USING (message_number) LEFT JOIN lab USING (message_number) LEFT JOIN cat USING (message_number)`;
const D_CODES = `SELECT message_number, process, category, label, label_share, n::int, systems,
                        to_char(first_seen, 'YYYY-MM-DD"T"HH24:MI:SS') AS first_seen, to_char(last_seen, 'YYYY-MM-DD"T"HH24:MI:SS') AS last_seen
                 FROM insight.ge_mri_codes`;

// E: what must never be in a label.
const E_SQL = String.raw`
WITH h AS (${HOSTS_ALT})
SELECT count(*) FILTER (WHERE h.alt IS NOT NULL AND c.label ~* ('(?<![A-Za-z0-9_])(' || h.alt || ')(?![A-Za-z0-9_])'))::int AS host,
       count(*) FILTER (WHERE c.label ~ '\y[0-9]{1,3}(\.[0-9]{1,3}){3}\y')::int AS ip,
       count(*) FILTER (WHERE c.label ~ '\y([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}\y')::int AS mac,
       count(*) FILTER (WHERE c.label ~ '\ySME[0-9]')::int AS system_id,
       count(*)::int AS labels
FROM insight.ge_mri_codes c, h WHERE c.label IS NOT NULL`;

// F: the inputs of the JS side, straight from the facts.
const F_EVENTS_SQL = `
  SELECT system_id, to_char(host_local, 'YYYY-MM-DD"T"HH24:MI:SS') AS t, record_number_concurrent AS rnc, id::text AS id, metric_key, dim, value_num, attrs
  FROM insight.ge_mri_facts
  WHERE metric_key IN ('mri.sw_start', 'mri.sw_stop', 'mri.system_up', 'mri.service_mode', 'mri.process_death')
     OR (metric_key = 'mri.error' AND dim = '${D.STOP_COMPANION}')`;
const F_CAPS_SQL = `
  SELECT system_id, metric_key, min(host_local::date)::text AS first_day, max(host_local::date)::text AS last_day,
         count(DISTINCT host_local::date)::int AS days, count(*)::bigint AS n
  FROM insight.ge_mri_facts GROUP BY 1, 2`;

// ---------------------------------------------------------------- pure (F)

const secs = (t) => Date.parse(`${t}Z`) / 1000;
const cmp = (a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : a.rnc - b.rnc || (a.metric_key < b.metric_key ? -1 : a.metric_key > b.metric_key ? 1 : 0));
const by_system = (rows) => { const m = new Map(); for (const r of rows) { if (!m.has(r.system_id)) m.set(r.system_id, []); m.get(r.system_id).push(r); } return m; };

function js_sw_sessions(events) {
  const out = [];
  const ev = events.filter((e) => e.metric_key === "mri.sw_start" || e.metric_key === "mri.sw_stop" || e.metric_key === "mri.error");
  for (const [sys, list] of by_system(ev)) {
    list.sort(cmp);
    list.forEach((e, i) => {
      if (e.metric_key !== "mri.sw_start") return;
      const nx = list[i + 1];
      const kind = !nx ? "open" : nx.metric_key === "mri.sw_start" ? "no_stop" : "stop";
      out.push({ system_id: sys, started_at: e.t, end_kind: kind, next_at: nx ? nx.t : null, duration_s: kind === "stop" ? secs(nx.t) - secs(e.t) : null });
    });
  }
  return out;
}

function js_service_sessions(events) {
  const out = [];
  for (const [sys, list] of by_system(events.filter((e) => e.metric_key === "mri.service_mode"))) {
    list.sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : a.rnc - b.rnc));
    list.forEach((e, i) => {
      if (e.dim !== "on" || (i > 0 && list[i - 1].dim === "on")) return;
      const off = list.slice(i + 1).find((x) => x.dim === "off");
      out.push({ system_id: sys, started_at: e.t, ended_at: off ? off.t : null, end_kind: off ? "off" : "open", duration_s: off ? secs(off.t) - secs(e.t) : null });
    });
  }
  return out;
}

function js_deaths(events, window_min = D.RESTART_WINDOW_MIN) {
  const restart = by_system(events.filter((e) => ["mri.sw_start", "mri.sw_stop", "mri.system_up", "mri.error"].includes(e.metric_key)));
  return events.filter((e) => e.metric_key === "mri.process_death").map((d) => {
    const w = window_min * 60;
    const at_restart = (restart.get(d.system_id) || []).some((r) => Math.abs(secs(r.t) - secs(d.t)) <= w);
    return { system_id: d.system_id, at: d.t, process: d.dim, at_restart };
  });
}

function js_inventory(events) {
  const out = [];
  for (const [sys, list] of by_system(events.filter((e) => e.metric_key === "mri.system_up"))) {
    list.sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : a.rnc - b.rnc || (BigInt(a.id) < BigInt(b.id) ? -1 : 1)));
    const l = list[list.length - 1];
    const fs = [...new Set(list.map((u) => u.value_num).filter((v) => v !== null))].sort((a, b) => a - b);
    out.push({
      system_id: sys, sw: l.dim, field_strength_t: l.value_num, attrs: l.attrs, last_up_at: l.t,
      sw_first_seen: list.find((u) => u.dim === l.dim).t, sw_versions: new Set(list.map((u) => u.dim)).size,
      field_strengths_t: fs.length ? fs : null, system_ups: list.length,
    });
  }
  return out;
}

// Two row sets, compared as sorted canonical JSON over the given fields.
function same_rows(a, b, fields) {
  const canon = (rows) => rows.map((r) => JSON.stringify(fields.map((f) => (r[f] === undefined ? null : typeof r[f] === "bigint" || /^-?\d+$/.test(String(r[f])) && f.endsWith("_s") ? Number(r[f]) : r[f])))).sort();
  const x = canon(a), y = canon(b);
  const xs = new Set(x), ys = new Set(y);
  const only_sql = x.filter((r) => !ys.has(r)), only_js = y.filter((r) => !xs.has(r));
  return { rows: x.length, js_rows: y.length, diffs: only_sql.length + only_js.length, samples: [...only_sql.slice(0, 3).map((r) => ({ sql: r })), ...only_js.slice(0, 3).map((r) => ({ js: r }))] };
}

// ---------------------------------------------------------------- checks

function diff_cells(a, b) {
  const k = (r) => `${r.system_id}|${r.day}|${r.key}`;
  const am = new Map(a.map((r) => [k(r), r.n]));
  const bm = new Map(b.map((r) => [k(r), r.n]));
  const keys = new Set([...am.keys(), ...bm.keys()]);
  const diffs = [...keys].filter((x) => (am.get(x) || 0) !== (bm.get(x) || 0)).map((x) => ({ k: x, daily: am.get(x) || 0, source: bm.get(x) || 0 }));
  return { cells: keys.size, diffs: diffs.length, samples: diffs.slice(0, 5) };
}

function diff_codes(have, want) {
  const norm = (r) => ({ ...r, label_share: r.label_share === null ? null : Number(Number(r.label_share).toFixed(12)) });
  const hm = new Map(have.map((r) => [r.message_number, norm(r)]));
  const wm = new Map(want.map((r) => [r.message_number, norm(r)]));
  const out = [];
  for (const c of new Set([...hm.keys(), ...wm.keys()])) {
    const h = hm.get(c), w = wm.get(c);
    if (!h || !w) { out.push({ message_number: c, missing: !h ? "in ge_mri_codes" : "in source" }); continue; }
    const fields = Object.keys(w).filter((f) => JSON.stringify(h[f]) !== JSON.stringify(w[f]));
    if (fields.length) out.push({ message_number: c, fields: Object.fromEntries(fields.map((f) => [f, { codes: h[f], source: w[f] }])) });
  }
  return { codes: wm.size, diffs: out.length, samples: out.slice(0, 5) };
}

async function verify_mri_derive(t, to = null) {
  const job = to === null ? await t.oneOrNone("SELECT watermark_id FROM insight.job_state WHERE job_name = $1", [JOB]) : null;
  const upto = to ?? (job ? Number(job.watermark_id) : null);
  if (upto === null) throw new Error("no ge_mri_extract watermark: run the extract first");
  const A = diff_cells(await t.any(A_DAILY), await t.any(A_SRC, [upto]));
  const B = diff_cells(await t.any(B_DAILY), await t.any(B_SRC, [upto]));
  const C = await t.one(C_SQL);
  const cats = [...CODE_CATEGORY];
  const Dc = diff_codes(await t.any(D_CODES), await t.any(D_SRC, [upto, cats.map((x) => x[0]), cats.map((x) => x[1])]));
  const E = await t.one(E_SQL);
  const events = await t.any(F_EVENTS_SQL);
  const F = {
    capabilities: same_rows(await t.any(D.CAPABILITIES_SQL, [null]), (await t.any(F_CAPS_SQL)).map((r) => ({ ...r, n: String(r.n) })), ["system_id", "metric_key", "first_day", "last_day", "days", "n"]),
    inventory: same_rows(await t.any(D.INVENTORY_SQL, [null]), js_inventory(events),
      ["system_id", "sw", "field_strength_t", "attrs", "last_up_at", "sw_first_seen", "sw_versions", "field_strengths_t", "system_ups"]),
    sw_sessions: same_rows(await t.any(D.SW_SESSIONS_SQL, [null]), js_sw_sessions(events), ["system_id", "started_at", "end_kind", "next_at", "duration_s"]),
    service_sessions: same_rows(await t.any(D.SERVICE_SESSIONS_SQL, [null]), js_service_sessions(events), ["system_id", "started_at", "ended_at", "end_kind", "duration_s"]),
    deaths: same_rows(await t.any(D.DEATHS_SQL, [null]), js_deaths(events), ["system_id", "at", "process", "at_restart"]),
  };
  const p = await t.oneOrNone("SELECT last_run_stats->'pending' AS p, last_run_stats->'codes_pending' AS c FROM insight.job_state WHERE job_name = $1", [DERIVE_JOB]);
  const pending = p && p.p ? Object.keys(p.p).length : 0;
  const leaks = E.host + E.ip + E.mac + E.system_id;
  const ok = !A.diffs && !B.diffs && !C.missing_in_daily && !C.extra_in_daily && !Dc.diffs && !leaks && Object.values(F).every((x) => !x.diffs);
  return { to: upto, daily_vs_source: A, mri_error_by_code_vs_source: B, daily_vs_facts: C, codes_vs_source: Dc, label_leaks: E, derived: F,
    pending_systems: pending, codes_pending: !!(p && p.c === true), ok };
}

module.exports = {
  verify_mri_derive, diff_cells, diff_codes, same_rows, js_sw_sessions, js_service_sessions, js_deaths, js_inventory,
  A_SRC, B_SRC, D_SRC, E_SQL, TPL_SQL, HOSTS_ALT, PROC_SQL,
};
