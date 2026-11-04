"use strict";
// verify-derive: the Phase 3 exit checks (PLAN-CT-INSIGHTS.md §13.3), each
// against independent SQL. Read-only. Takes any connection or transaction,
// so the rehearsal can run it on its own (uncommitted) data before rolling
// back.
//
// Independence: exams are re-derived set-based (each event is assigned to
// the latest start by a running count), daily is re-aggregated with
// DISTINCT ON and a separately written dim expression, boots and resets
// come from derive/verify_sql.js, capabilities from a plain GROUP BY.
const { BOOTS_SQL, RESETS_SQL } = require("./verify_sql");
const { rules } = require("../rules/ge_ct");
const { derived_rules, DERIVED_KEYS } = require("../rules/ge_ct_derived");
const { MAX_OFFSET_H } = require("./daily");

// §13.1 / §13.3 acceptance (as of 2026-11-04): reset day is the UTC date of
// the reset reading, as in the §13.1 table.
const EXPECTED_REPLACEMENTS = [
  ["SME15218", "2026-05-28", "confirmed"], ["SME15218", "2026-09-24", "confirmed"],
  ["SME16618", "2026-06-04", "confirmed"], ["SME21864", "2026-07-15", "confirmed"],
  ["SME21873", "2025-08-14", "confirmed"], ["SME21873", "2025-09-02", "counter_only"],
  ["SME21873", "2025-12-08", "confirmed"], ["SME21873", "2026-01-28", "confirmed"],
];
const EXPECTED_CLOCK_AHEAD = ["SME11229", "SME16618", "SME21873", "SME21929"];
// SME18531's restart loop (§1, §13.1): restarts ran 2026-09-12 05:11 to 09-14 09:45 UTC.
const RESTART_LOOP = { system_id: "SME18531", from: "2026-09-12T05:11:00Z", to: "2026-09-14T09:45:34Z" };
const BOOT_RATIO_REVIEW = [0.8, 1.25]; // boots / shutdowns outside this: listed for review (not a failure)
const MIN_SERIES_SHARE = 0.95;

const DAILY_DIFF_SQL = `
WITH f AS (
  SELECT system_id, host_local::date AS d, metric_key,
         CASE WHEN metric_key = 'error.ermes' THEN CASE WHEN value_num IS NULL THEN '' ELSE (value_num::numeric)::text END
              WHEN metric_key IN ('prep.tube_temp', 'service.calibration', 'process.restart') THEN coalesce(value_text, '')
              WHEN metric_key LIKE 'xfer.%' THEN coalesce(value_text, '')
              WHEN metric_key LIKE 'ipc.%' THEN coalesce(attrs ->> 'status', '')
              ELSE '' END AS dim,
         value_num, host_datetime, epoch, record_number_concurrent AS rnc
  FROM insight.ge_ct_facts
), agg AS (
  SELECT system_id, d, metric_key, dim, count(*) AS n, sum(value_num::numeric)::double precision AS s,
         min(value_num) AS mn, max(value_num) AS mx, max(host_datetime) AS last_at
  FROM f GROUP BY 1, 2, 3, 4
), lst AS (
  SELECT DISTINCT ON (system_id, d, metric_key, dim) system_id, d, metric_key, dim, value_num AS last
  FROM f ORDER BY system_id, d, metric_key, dim, host_datetime DESC, epoch DESC, rnc DESC
), x AS (
  SELECT agg.*, lst.last FROM agg JOIN lst USING (system_id, d, metric_key, dim)
)
SELECT count(*) FILTER (WHERE y.system_id IS NULL) AS missing,
       count(*) FILTER (WHERE x.system_id IS NULL) AS extra,
       count(*) FILTER (WHERE x.system_id IS NOT NULL AND y.system_id IS NOT NULL AND (
           y.n <> x.n OR y.value_sum IS DISTINCT FROM x.s OR y.value_min IS DISTINCT FROM x.mn
        OR y.value_max IS DISTINCT FROM x.mx OR y.value_last IS DISTINCT FROM x.last OR y.last_at IS DISTINCT FROM x.last_at)) AS differ,
       count(*) FILTER (WHERE x.system_id IS NOT NULL AND y.system_id IS NOT NULL) AS matched,
       (array_agg(coalesce(x.system_id, y.system_id) || ' ' || coalesce(x.d, y.local_day) || ' ' || coalesce(x.metric_key, y.metric_key) || ' [' || coalesce(x.dim, y.dim) || ']')
          FILTER (WHERE x.system_id IS NULL OR y.system_id IS NULL OR y.n <> x.n OR y.value_sum IS DISTINCT FROM x.s
                  OR y.value_min IS DISTINCT FROM x.mn OR y.value_max IS DISTINCT FROM x.mx
                  OR y.value_last IS DISTINCT FROM x.last OR y.last_at IS DISTINCT FROM x.last_at))[1:10] AS sample
FROM x FULL JOIN insight.ge_ct_daily y
  ON y.system_id = x.system_id AND y.local_day = x.d AND y.metric_key = x.metric_key AND y.dim = x.dim`;

const EXAMS_DIFF_SQL = `
WITH ev AS (
  SELECT system_id, metric_key, exam_no, host_datetime, epoch, record_number_concurrent AS rnc, value_num, attrs
  FROM insight.ge_ct_facts
  WHERE metric_key IN ('exam.start', 'exam.series', 'scan.abort.operator', 'scan.abort.system')
), o AS (
  SELECT ev.*, count(*) FILTER (WHERE metric_key = 'exam.start')
                 OVER (PARTITION BY system_id ORDER BY host_datetime, epoch, rnc ROWS UNBOUNDED PRECEDING) AS k
  FROM ev
), st AS (
  SELECT system_id, k, exam_no, host_datetime AS started_at,
         count(*) OVER (PARTITION BY system_id, exam_no ORDER BY host_datetime, epoch, rnc ROWS UNBOUNDED PRECEDING) > 1 AS reopened
  FROM o WHERE metric_key = 'exam.start'
), ls AS (
  SELECT DISTINCT ON (system_id, k) system_id, k, attrs, value_num
  FROM o WHERE metric_key = 'exam.series' AND k > 0
  ORDER BY system_id, k, host_datetime DESC, epoch DESC, rnc DESC
), c AS (
  SELECT system_id, k, count(*) FILTER (WHERE metric_key = 'exam.series') AS nser,
         count(*) FILTER (WHERE metric_key = 'scan.abort.operator') AS aop,
         count(*) FILTER (WHERE metric_key = 'scan.abort.system') AS asys,
         max(host_datetime) AS last_at
  FROM o WHERE k > 0 GROUP BY 1, 2
), x AS (
  SELECT st.system_id, st.exam_no, st.started_at, st.reopened, c.nser, c.aop, c.asys, c.last_at,
         coalesce((ls.attrs ->> 'ct_series')::int, 0) AS series, coalesce((ls.attrs ->> 'ct_scans')::int, 0) AS scans,
         coalesce((ls.attrs ->> 'ct_images')::int, ls.value_num::int, 0) AS images
  FROM st JOIN c USING (system_id, k) LEFT JOIN ls USING (system_id, k)
)
SELECT count(*) FILTER (WHERE y.system_id IS NULL) AS missing,
       count(*) FILTER (WHERE x.system_id IS NULL) AS extra,
       count(*) FILTER (WHERE x.system_id IS NOT NULL AND y.system_id IS NOT NULL AND (
           y.series <> x.series OR y.scans <> x.scans OR y.images <> x.images OR y.aborts_operator <> x.aop
        OR y.aborts_system <> x.asys OR y.last_activity_at <> x.last_at
        OR coalesce((y.attrs ->> 'reopened')::boolean, false) <> x.reopened
        OR coalesce((y.attrs ->> 'series_summaries')::int, -1) <> x.nser)) AS differ,
       count(*) FILTER (WHERE x.system_id IS NOT NULL) AS starts,
       count(*) FILTER (WHERE x.nser > 0) AS with_series,
       count(*) FILTER (WHERE x.reopened) AS reopened,
       (array_agg(coalesce(x.system_id, y.system_id) || ' ' || coalesce(x.exam_no, y.exam_no) || ' ' || coalesce(x.started_at, y.started_at))
          FILTER (WHERE x.system_id IS NULL OR y.system_id IS NULL OR y.series <> x.series OR y.scans <> x.scans
                  OR y.images <> x.images OR y.aborts_operator <> x.aop OR y.aborts_system <> x.asys
                  OR y.last_activity_at <> x.last_at OR coalesce((y.attrs ->> 'reopened')::boolean, false) <> x.reopened
                  OR coalesce((y.attrs ->> 'series_summaries')::int, -1) <> x.nser))[1:10] AS sample
FROM x FULL JOIN insight.ge_ct_exams y
  ON y.system_id = x.system_id AND y.exam_no = x.exam_no AND y.started_at = x.started_at`;

const CAPS_DIFF_SQL = `
WITH x AS (
  SELECT system_id, metric_key, min(host_datetime) AS f, max(host_datetime) AS l, count(*) AS n
  FROM insight.ge_ct_facts GROUP BY 1, 2
)
SELECT count(*) FILTER (WHERE y.system_id IS NULL) AS missing,
       count(*) FILTER (WHERE x.system_id IS NULL) AS extra,
       count(*) FILTER (WHERE x.system_id IS NOT NULL AND y.system_id IS NOT NULL
                          AND (y.first_seen <> x.f OR y.last_seen <> x.l OR y.n <> x.n)) AS differ,
       count(*) AS cells
FROM x FULL JOIN insight.system_capabilities y ON y.system_id = x.system_id AND y.metric_key = x.metric_key`;

const key = (s, e, r) => `${s}|${e}|${r}`;

async function check_tube(db) {
  const lines = [];
  let ok = true;
  const facts = await db.any(`SELECT system_id, epoch, record_number_concurrent AS rnc, host_datetime, value_text, attrs
                              FROM insight.ge_ct_facts WHERE metric_key = 'tube.replacement' ORDER BY system_id, host_datetime`);
  const sql = await db.any(RESETS_SQL, [null]);
  // facts vs independent SQL
  const sm = new Map(sql.map((r) => [key(r.system_id, r.epoch, r.rnc), r]));
  const mism = [];
  for (const f of facts) {
    const s = sm.get(key(f.system_id, f.epoch, f.rnc));
    if (!s) { mism.push(`only in facts: ${f.system_id} ${f.host_datetime.toISOString()}`); continue; }
    const conf = s.calibrations >= 3 ? "confirmed" : "counter_only";
    if (f.value_text !== conf || f.attrs.calibrations_in_window !== s.calibrations) mism.push(`${f.system_id} ${f.host_datetime.toISOString()}: facts ${f.value_text}/${f.attrs.calibrations_in_window} sql ${conf}/${s.calibrations}`);
    sm.delete(key(f.system_id, f.epoch, f.rnc));
  }
  for (const s of sm.values()) mism.push(`only in SQL: ${s.system_id} ${s.t.toISOString()}`);
  lines.push(`facts vs independent SQL: ${facts.length} vs ${sql.length} resets, ${mism.length} differences`);
  mism.slice(0, 10).forEach((m) => lines.push(`  ${m}`));
  if (mism.length) ok = false;
  // §13.1 acceptance
  const got = facts.map((f) => [f.system_id, f.host_datetime.toISOString().slice(0, 10), f.value_text]);
  const same = JSON.stringify(got) === JSON.stringify(EXPECTED_REPLACEMENTS);
  lines.push(`§13.1 table: ${same ? "exact match" : "MISMATCH"} (${got.filter((g) => g[2] === "confirmed").length} confirmed, ${got.filter((g) => g[2] === "counter_only").length} counter_only)`);
  if (!same) { ok = false; lines.push(`  got ${JSON.stringify(got)}`); }
  for (const f of facts) {
    lines.push(`  ${f.system_id} reset ${f.host_datetime.toISOString().slice(0, 16)}Z  ${f.value_text.padEnd(12)} install ${f.attrs.install_date}  cal ${String(f.attrs.calibrations_in_window).padStart(2)}  old ${f.attrs.old_mas} mA·s  source ${f.attrs.tube_source}`);
  }
  const noSource = facts.filter((f) => !f.attrs.tube_source);
  lines.push(`tube source on every replacement: ${noSource.length ? `MISSING on ${noSource.length}` : "yes"}`);
  if (noSource.length) ok = false;
  // segments agree with the replacement facts
  const seg = await db.any(`
    WITH r AS (SELECT system_id, host_datetime, value_text, attrs FROM insight.ge_ct_facts WHERE metric_key = 'tube.replacement'),
         m AS (SELECT DISTINCT system_id FROM insight.ge_ct_facts WHERE metric_key = 'tube.mas_total')
    SELECT
      (SELECT count(*) FROM m WHERE (SELECT count(*) FROM insight.ge_ct_tube_segments s WHERE s.system_id = m.system_id)
                                 <> 1 + (SELECT count(*) FROM r WHERE r.system_id = m.system_id))::int AS wrong_count,
      (SELECT count(*) FROM m WHERE (SELECT count(*) FROM insight.ge_ct_tube_segments s WHERE s.system_id = m.system_id AND s.segment_end IS NULL) <> 1)::int AS wrong_current,
      (SELECT count(*) FROM r LEFT JOIN insight.ge_ct_tube_segments s ON s.system_id = r.system_id AND s.segment_start = r.host_datetime
        WHERE s.system_id IS NULL OR s.install_confidence <> r.value_text OR s.install_date::text IS DISTINCT FROM r.attrs ->> 'install_date'
           OR s.tube_source IS DISTINCT FROM r.attrs ->> 'tube_source')::int AS wrong_replacement_segments,
      (SELECT count(*) FROM insight.ge_ct_tube_segments s WHERE s.install_confidence = 'initial')::int AS initial,
      (SELECT count(*) FROM insight.ge_ct_tube_segments)::int AS segments,
      (SELECT count(*) FROM insight.ge_ct_tube_segments WHERE latest_mas < start_mas)::int AS negative`);
  const g = seg[0];
  const segOk = !g.wrong_count && !g.wrong_current && !g.wrong_replacement_segments && !g.negative;
  lines.push(`tube segments: ${g.segments} (${g.initial} initial); per system 1 + replacements: ${g.wrong_count ? `${g.wrong_count} wrong` : "ok"}; one current: ${g.wrong_current ? `${g.wrong_current} wrong` : "ok"}; replacement segments match facts: ${g.wrong_replacement_segments ? `${g.wrong_replacement_segments} wrong` : "ok"}; negative: ${g.negative}`);
  if (!segOk) ok = false;
  return { name: "tube replacements and segments", ok, lines };
}

async function check_boots(db) {
  const lines = [];
  let ok = true;
  const facts = await db.any(`SELECT system_id, epoch, record_number_concurrent AS rnc, value_text FROM insight.ge_ct_facts WHERE metric_key = 'system.boot'`);
  const sql = await db.any(BOOTS_SQL, [null]);
  const sm = new Map(sql.map((r) => [key(r.system_id, r.epoch, r.rnc), r.clean]));
  let only_facts = 0, clean_diff = 0;
  for (const f of facts) {
    const k = key(f.system_id, f.epoch, f.rnc);
    if (!sm.has(k)) only_facts++;
    else if (sm.get(k) !== (f.value_text === "clean")) clean_diff++;
    sm.delete(k);
  }
  lines.push(`facts vs independent SQL: ${facts.length} vs ${sql.length} boots; only in facts ${only_facts}, only in SQL ${sm.size}, clean/unclean differs ${clean_diff}`);
  if (only_facts || sm.size || clean_diff) ok = false;
  const loop = await db.one(`SELECT count(*) FILTER (WHERE metric_key = 'system.boot')::int AS boots,
                                    count(*) FILTER (WHERE metric_key = 'system.sw_init_complete')::int AS inits
                             FROM insight.ge_ct_facts WHERE system_id = $1 AND host_datetime BETWEEN $2 AND $3`,
  [RESTART_LOOP.system_id, RESTART_LOOP.from, RESTART_LOOP.to]);
  lines.push(`${RESTART_LOOP.system_id} restart loop (${RESTART_LOOP.from} .. ${RESTART_LOOP.to}): ${loop.inits} inits, ${loop.boots} boots`);
  if (loop.boots !== 0 || loop.inits < 1000) ok = false;
  const per = await db.any(`SELECT system_id,
      count(*) FILTER (WHERE metric_key = 'system.boot')::int AS boots,
      count(*) FILTER (WHERE metric_key = 'system.boot' AND value_text = 'unclean')::int AS unclean,
      count(*) FILTER (WHERE metric_key = 'system.shutdown')::int AS shutdowns
    FROM insight.ge_ct_facts WHERE metric_key IN ('system.boot', 'system.shutdown') GROUP BY 1 ORDER BY 1`);
  const tot = per.reduce((a, r) => ({ b: a.b + r.boots, s: a.s + r.shutdowns, u: a.u + r.unclean }), { b: 0, s: 0, u: 0 });
  lines.push(`fleet: ${tot.b} boots, ${tot.s} shutdowns (ratio ${(tot.b / tot.s).toFixed(2)}), ${tot.u} unclean`);
  const review = per.filter((r) => !r.shutdowns || r.boots / r.shutdowns < BOOT_RATIO_REVIEW[0] || r.boots / r.shutdowns > BOOT_RATIO_REVIEW[1]);
  lines.push(`boots/shutdowns outside ${BOOT_RATIO_REVIEW.join("–")} (for review, not a failure): ${review.length}`);
  review.forEach((r) => lines.push(`  ${r.system_id}  ${r.boots} boots / ${r.shutdowns} shutdowns = ${r.shutdowns ? (r.boots / r.shutdowns).toFixed(2) : "-"}; ${r.unclean} unclean`));
  lines.push(`unclean boots per system: ${per.filter((r) => r.unclean).map((r) => `${r.system_id} ${r.unclean}`).join(", ")}`);
  return { name: "boots", ok, lines };
}

async function check_exams(db) {
  const r = await db.one(EXAMS_DIFF_SQL);
  const rows = (await db.one("SELECT count(*)::int AS n FROM insight.ge_ct_exams")).n;
  const share = r.starts ? r.with_series / r.starts : 0;
  const ok = !Number(r.missing) && !Number(r.extra) && !Number(r.differ) && rows === Number(r.starts) && share >= MIN_SERIES_SHARE;
  const lines = [
    `rows ${rows} vs distinct starts ${r.starts}; missing ${r.missing}, extra ${r.extra}, differ ${r.differ} (series/scans/images/aborts/last activity/reopened/series count)`,
    `with a series summary: ${r.with_series} (${(100 * share).toFixed(2)}%, need >= ${100 * MIN_SERIES_SHARE}%); reopened: ${r.reopened}`,
  ];
  if (r.sample && r.sample.length) lines.push(`  sample: ${r.sample.join(" | ")}`);
  return { name: "exams", ok, lines };
}

async function check_daily(db) {
  const r = await db.one(DAILY_DIFF_SQL);
  const ok = !Number(r.missing) && !Number(r.extra) && !Number(r.differ);
  const lines = [`(system, local_day, metric, dim) cells: ${r.matched} matched; missing ${r.missing}, extra ${r.extra}, differ ${r.differ} (n/sum/min/max/last/last_at)`];
  if (r.sample && r.sample.length) lines.push(`  sample: ${r.sample.join(" | ")}`);
  return { name: "daily", ok, lines };
}

async function check_capabilities(db) {
  const r = await db.one(CAPS_DIFF_SQL);
  const ok = !Number(r.missing) && !Number(r.extra) && !Number(r.differ);
  return { name: "capabilities", ok, lines: [`(system, metric) cells: ${r.cells}; missing ${r.missing}, extra ${r.extra}, differ ${r.differ}`] };
}

async function check_clock(db) {
  const rows = await db.any("SELECT system_id, flag, est_offset_min, p10_lag_min, captures, window_end FROM insight.system_clock ORDER BY system_id");
  const ahead = rows.filter((r) => r.flag === "ahead").map((r) => r.system_id);
  const ok = JSON.stringify(ahead) === JSON.stringify(EXPECTED_CLOCK_AHEAD);
  const lines = [`${rows.length} systems; ahead: ${ahead.join(", ") || "none"} (expected ${EXPECTED_CLOCK_AHEAD.join(", ")})`];
  for (const f of ["ahead", "lagging", "jumps"]) {
    const xs = rows.filter((r) => r.flag === f);
    if (xs.length) lines.push(`  ${f}: ${xs.map((r) => `${r.system_id} (p10 ${r.p10_lag_min} min${f === "ahead" ? `, est ${r.est_offset_min} min ahead` : ""})`).join(", ")}`);
  }
  lines.push(`  ok: ${rows.filter((r) => r.flag === "ok").length}`);
  return { name: "clock flags", ok, lines };
}

async function check_invariants(db) {
  const r = await db.one(`SELECT
      (SELECT count(*) FROM insight.ge_ct_facts f
        WHERE abs(extract(epoch FROM f.host_datetime - (f.host_local AT TIME ZONE 'UTC'))) > $1 * 3600)::int AS offset_breaks,
      (SELECT count(*) FROM insight.metric_catalog)::int AS catalog,
      (SELECT count(*) FROM insight.metric_catalog WHERE metric_key = ANY($2))::int AS derived_in_catalog`, [MAX_OFFSET_H, DERIVED_KEYS]);
  const expectCat = rules.length + derived_rules.length;
  const ok = r.offset_breaks === 0 && r.catalog === expectCat && r.derived_in_catalog === derived_rules.length;
  return { name: "invariants", ok, lines: [
    `facts with host_datetime more than ${MAX_OFFSET_H} h from host_local (touched-day scan bound): ${r.offset_breaks}`,
    `catalog rows: ${r.catalog} (expected ${expectCat}: ${rules.length} per-row + ${derived_rules.length} derived)`,
  ] };
}

const CHECKS = [check_tube, check_boots, check_exams, check_daily, check_capabilities, check_clock, check_invariants];

async function run_verify(db, log = console.log) {
  const results = [];
  for (const c of CHECKS) {
    const t0 = Date.now();
    const r = await c(db);
    r.ms = Date.now() - t0;
    results.push(r);
    log(`[${r.ok ? "PASS" : "FAIL"}] ${r.name} (${(r.ms / 1000).toFixed(1)}s)`);
    r.lines.forEach((l) => log(`       ${l}`));
  }
  return { ok: results.every((r) => r.ok), results };
}

module.exports = { run_verify, EXPECTED_REPLACEMENTS, EXPECTED_CLOCK_AHEAD, RESTART_LOOP, DAILY_DIFF_SQL, EXAMS_DIFF_SQL };
