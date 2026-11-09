"use strict";
// The CV-3 exit check (PLAN-CV-INSIGHTS.md §4: "independent SQL equal"),
// on any connection or transaction (the rehearsal runs it on its
// uncommitted rows). Source rows up to the extract watermark (or `to`).
//
//   A  daily per (system, device day, metric): sum(n) = the independent
//      count from log.ge_cv_syserror (reconcile_sql.js conditions; device
//      day = host_date);
//   B  cv.error per (system, device day, code) = the source count;
//   C  daily = a plain GROUP BY over the facts, every column (named-metric
//      dims, first / last, value aggregates), both directions;
//   D  ge_cv_codes = the same fields rebuilt from the source in SQL: n,
//      systems, first / last seen, most common subsystem and source file,
//      and the label (the debug-text template rebuilt with regexes in SQL,
//      not the JS function) with its share. Ties: smallest, COLLATE "C".
//   +  pending days left for any system (a note).
// Nothing in the GE CT run loads this file.
const { COND, RELAY, STORABLE } = require("./reconcile_sql");
const { JOB, DERIVE_JOB } = require("./load");
const { LABEL_MAX } = require("./derive");

const BASE = `
  SELECT system_id, host_date, host_datetime, errorcode, btrim(subsystem) AS sub, sourcefile AS sf, debugtext AS d
  FROM log.ge_cv_syserror
  WHERE id <= $1 AND NOT coalesce(${RELAY}, false) AND ${STORABLE}`;

const A_SRC = `
WITH base AS (${BASE})
SELECT system_id, host_date::text AS day, k.key, count(*)::int AS n
FROM base CROSS JOIN LATERAL (VALUES
${Object.entries(COND).map(([k, c]) => `  ('${k}', coalesce(${c.replace(/\bdebugtext\b/g, "d")}, false))`).join(",\n")}
) AS k(key, hit)
WHERE k.hit GROUP BY 1, 2, 3`;
const A_DAILY = `SELECT system_id, local_day::text AS day, metric_key AS key, sum(n)::int AS n FROM insight.ge_cv_daily GROUP BY 1, 2, 3`;

const B_SRC = `WITH base AS (${BASE}) SELECT system_id, host_date::text AS day, errorcode::text AS key, count(*)::int AS n FROM base GROUP BY 1, 2, 3`;
const B_DAILY = `SELECT system_id, local_day::text AS day, dim AS key, n::int FROM insight.ge_cv_daily WHERE metric_key = 'cv.error'`;

const C_SQL = `
WITH g AS (
  SELECT f.system_id, f.host_local::date AS local_day, f.metric_key, f.dim, count(*) AS n,
         sum(f.value_num) AS value_sum, min(f.value_num) AS value_min, max(f.value_num) AS value_max,
         (array_agg(f.value_num ORDER BY f.host_datetime DESC, f.id DESC))[1] AS value_last,
         min(f.host_datetime) AS first_at, max(f.host_datetime) AS last_at
  FROM insight.ge_cv_facts f GROUP BY 1, 2, 3, 4
), d AS (
  SELECT system_id, local_day, metric_key, dim, n, value_sum, value_min, value_max, value_last, first_at, last_at FROM insight.ge_cv_daily
)
SELECT (SELECT count(*) FROM (SELECT * FROM g EXCEPT SELECT * FROM d) x)::int AS missing_in_daily,
       (SELECT count(*) FROM (SELECT * FROM d EXCEPT SELECT * FROM g) x)::int AS extra_in_daily,
       (SELECT count(*) FROM d)::int AS daily_rows`;

// The template, by its definition (derive.js header), in PostgreSQL regexes,
// on the ASCII-normalized text 'da' (every non-ASCII character -> '?').
const ASCII = `regexp_replace(d, '[^\\x01-\\x7f]', '?', 'g')`;
const TPL = `left(replace(
  regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(da,
    '^[[:space:]"-]+', ''), '[[:space:]"]+$', ''), '0x[0-9a-fA-F]+', chr(1), 'g'),
    '\\m(?=[0-9A-F]*[0-9])[0-9A-F]{2,8}\\M', '#', 'g'), '-?[0-9]+(\\.[0-9]+)?', '#', 'g'), '[[:space:]]+', ' ', 'g'),
  chr(1), '0x#'), ${LABEL_MAX})`;
const READABLE = `(d IS NOT NULL AND da !~ '^[[:space:]]*"?[[:space:]]*-?[[:space:]]*\\(null\\)' AND d ~ '[A-Za-z]{3}')`;

const D_SRC = `
WITH t0 AS (SELECT b.*, ${ASCII} AS da FROM (${BASE}) b),
t AS (SELECT t0.*, CASE WHEN ${READABLE} THEN ${TPL} END AS tpl FROM t0),
agg AS (SELECT errorcode, count(*)::int AS n, count(DISTINCT system_id)::int AS systems, min(host_datetime) AS first_seen, max(host_datetime) AS last_seen FROM t GROUP BY 1),
sub AS (SELECT DISTINCT ON (errorcode) errorcode, sub FROM (SELECT errorcode, sub, count(*) AS c FROM t GROUP BY 1, 2) x ORDER BY errorcode, c DESC, sub COLLATE "C"),
sf  AS (SELECT DISTINCT ON (errorcode) errorcode, sf  FROM (SELECT errorcode, sf,  count(*) AS c FROM t WHERE sf IS NOT NULL GROUP BY 1, 2) x ORDER BY errorcode, c DESC, sf COLLATE "C"),
lab AS (SELECT DISTINCT ON (errorcode) errorcode, tpl, c FROM (SELECT errorcode, tpl, count(*) AS c FROM t WHERE tpl IS NOT NULL GROUP BY 1, 2) x ORDER BY errorcode, c DESC, tpl COLLATE "C")
SELECT agg.errorcode, sub.sub AS subsystem, lab.tpl AS label, lab.c::float8 / agg.n AS label_share, sf.sf AS sourcefile,
       agg.n, agg.systems, agg.first_seen, agg.last_seen
FROM agg JOIN sub USING (errorcode) LEFT JOIN sf USING (errorcode) LEFT JOIN lab USING (errorcode)`;
const D_CODES = `SELECT errorcode, subsystem, label, label_share, sourcefile, n::int, systems, first_seen, last_seen FROM insight.ge_cv_codes`;

function diff_cells(a, b) {
  const k = (r) => `${r.system_id}|${r.day}|${r.key}`;
  const am = new Map(a.map((r) => [k(r), r.n]));
  const bm = new Map(b.map((r) => [k(r), r.n]));
  const keys = new Set([...am.keys(), ...bm.keys()]);
  const diffs = [...keys].filter((x) => (am.get(x) || 0) !== (bm.get(x) || 0)).map((x) => ({ k: x, daily: am.get(x) || 0, source: bm.get(x) || 0 }));
  return { cells: keys.size, diffs: diffs.length, samples: diffs.slice(0, 5) };
}

function diff_codes(have, want) {
  const norm = (r) => ({ ...r, first_seen: new Date(r.first_seen).toISOString(), last_seen: new Date(r.last_seen).toISOString(),
    label_share: r.label_share === null ? null : Number(Number(r.label_share).toFixed(12)) });
  const hm = new Map(have.map((r) => [r.errorcode, norm(r)]));
  const wm = new Map(want.map((r) => [r.errorcode, norm(r)]));
  const out = [];
  for (const c of new Set([...hm.keys(), ...wm.keys()])) {
    const h = hm.get(c), w = wm.get(c);
    if (!h || !w) { out.push({ errorcode: c, missing: !h ? "in ge_cv_codes" : "in source" }); continue; }
    const fields = Object.keys(w).filter((f) => JSON.stringify(h[f]) !== JSON.stringify(w[f]));
    if (fields.length) out.push({ errorcode: c, fields: Object.fromEntries(fields.map((f) => [f, { codes: h[f], source: w[f] }])) });
  }
  return { codes: wm.size, diffs: out.length, samples: out.slice(0, 5) };
}

async function verify_cv_derive(t, to = null) {
  const job = to === null ? await t.oneOrNone("SELECT watermark_id FROM insight.job_state WHERE job_name = $1", [JOB]) : null;
  const upto = to ?? (job ? Number(job.watermark_id) : null);
  if (upto === null) throw new Error("no ge_cv_extract watermark: run the extract first");
  const A = diff_cells(await t.any(A_DAILY), await t.any(A_SRC, [upto]));
  const B = diff_cells(await t.any(B_DAILY), await t.any(B_SRC, [upto]));
  const C = await t.one(C_SQL);
  const D = diff_codes(await t.any(D_CODES), await t.any(D_SRC, [upto]));
  const p = await t.oneOrNone("SELECT last_run_stats->'pending' AS p FROM insight.job_state WHERE job_name = $1", [DERIVE_JOB]);
  const pending = p && p.p ? Object.keys(p.p).length : 0;
  const ok = !A.diffs && !B.diffs && !C.missing_in_daily && !C.extra_in_daily && !D.diffs;
  return { to: upto, daily_vs_source: A, cv_error_by_code_vs_source: B, daily_vs_facts: C, codes_vs_source: D, pending_systems: pending, ok };
}

module.exports = { verify_cv_derive, diff_cells, diff_codes, ASCII, TPL, READABLE, A_SRC, B_SRC, D_SRC };
