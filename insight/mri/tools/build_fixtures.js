#!/usr/bin/env node
"use strict";
// Build GE MRI rule fixtures from real rows (READ-ONLY connection).
//   node insight/mri/tools/build_fixtures.js
// Labels come from the independent SQL (reconcile_sql.js COND), not from
// rules.js, so the fixture test checks the rules rather than echoing them.
// A label is the sorted '+'-joined set of named metrics a record gives, or
// "mri.error" (no named metric: look-alikes on the named codes, e.g. the
// dsserver death, the 2227566 Config lines). Per label, up to PER_LABEL
// records with distinct (code, digit-free template).
//
// Only rows of the named codes are taken: any other code gives mri.error
// whatever its text, which the tests cover with synthetic rows. Only the
// columns the rules read are kept (message_number, type, message, coil,
// psd): no system, time or id. Host names (every host seen in `type`),
// system ids, MAC / IP addresses, serials, device UDIs and PACS AE titles are masked; a
// sample is kept only if it classifies exactly as the unmasked row did,
// and the build fails if any host name survives.
// Nothing in the GE CT or CV run loads this file.
const fs = require("fs");
const path = require("path");
const { isDeepStrictEqual } = require("util");
const { COND, STORABLE } = require("../reconcile_sql");
const { NAMED_CODES, classify } = require("../rules");

const OUT = path.join(__dirname, "..", "__fixtures__");
const PER_LABEL = 40;

const named = Object.entries(COND).filter(([k]) => k !== "mri.error");
const SQL = `
WITH base AS (
  SELECT DISTINCT ON (system_id, epoch, record_number_concurrent) id, message_number, type, message, coil, psd
  FROM log.ge_mri_gesys
  WHERE message_number = ANY($1) AND ${STORABLE}
  ORDER BY system_id, epoch, record_number_concurrent, id
), lab AS (
  SELECT b.*, coalesce((SELECT string_agg(k.key, '+' ORDER BY k.key) FROM (VALUES
${named.map(([k, c]) => `      ('${k}', coalesce(${c}, false))`).join(",\n")}
    ) AS k(key, hit) WHERE k.hit), 'mri.error') AS label,
    regexp_replace(coalesce(message, ''), '[0-9]+', '#', 'g') AS tmpl
  FROM base b
), d AS (
  SELECT DISTINCT ON (label, message_number, tmpl) label, message_number, type, message, coil, psd, id,
         count(*) OVER (PARTITION BY label, message_number, tmpl) AS seen
  FROM lab
  ORDER BY label, message_number, tmpl, id
), ranked AS (
  SELECT d.*, row_number() OVER (PARTITION BY label ORDER BY seen DESC, message_number, id) AS k FROM d
)
SELECT label, message_number, type, message, coil, psd, seen::int FROM ranked WHERE k <= $2 ORDER BY label, k`;

const HOSTS_SQL = `SELECT DISTINCT split_part(type, E'\\t', 1) AS host FROM log.ge_mri_gesys WHERE type LIKE E'%\\t%'`;

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function masker(hosts) {
  const list = hosts.filter((h) => h && h.length >= 3).sort((a, b) => b.length - a.length);
  const host_re = list.length ? new RegExp(`(?<![A-Za-z0-9_])(${list.map(esc).join("|")})(?![A-Za-z0-9_])`, "gi") : null;
  const mask = (s) => {
    if (s === null || s === undefined) return s;
    let m = String(s);
    if (host_re) m = m.replace(host_re, "HOST");
    return m
      .replace(/\bSME\d+\b/g, "SME0")
      .replace(/\b([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}\b/g, "00:00:00:00:00:00")
      .replace(/(?<![\d.])(\d{1,3}\.){3}\d{1,3}(?![\d.])/g, "0.0.0.0")
      .replace(/SERIAL=\S+/g, "SERIAL=X")
      .replace(/\budi=\d+/g, "udi=0")
      .replace(/push failed: \S+ could not perform/g, "push failed: AE could not perform")
      .replace(/Message received from \S+ -/g, "Message received from AE -")
      .replace(/Operation timed out \[[^\]]*\]/g, "Operation timed out [AE]")
      .replace(/No Route to [^.]+\./g, "No Route to AE.")
      .replace(/Network session creation for \S+/g, "Network session creation for AE")
      .replace(/(Association was rejected from|ECHO was received from|rejected by the remote host) [^\s.]+/g, "$1 AE");
  };
  const leaks = (s) => (host_re && s ? (String(s).match(host_re) || []) : []);
  return { mask, leaks, host_re };
}

const shape = (r) => classify(r).facts.map((f) => [f.metric_key, f.dim, f.value_num, f.attrs]);

async function build(db) {
  if ((await db.one("SHOW default_transaction_read_only")).default_transaction_read_only !== "on") throw new Error("not read-only");
  return db.tx(async (t) => {
    const hosts = (await t.any(HOSTS_SQL)).map((r) => r.host);
    const { mask, leaks } = masker(hosts);
    const rows = await t.any(SQL, [NAMED_CODES, PER_LABEL]);
    const by = {};
    let dropped = 0;
    for (const r of rows) {
      const proc = String(r.type || "").split("\t").slice(1).join("\t");
      const masked = { message_number: r.message_number, type: `HOST\t${proc}`, message: mask(r.message), coil: mask(r.coil), psd: mask(r.psd) };
      if (!isDeepStrictEqual(shape(masked), shape(r))) { dropped++; continue; }
      const left = [masked.type, masked.message, masked.coil, masked.psd].flatMap(leaks);
      if (left.length) throw new Error(`host name survived masking in a ${r.label} sample`);
      (by[r.label] ||= []).push({ templates_seen: r.seen, ...masked });
    }
    fs.mkdirSync(OUT, { recursive: true });
    for (const f of fs.readdirSync(OUT)) if (f.endsWith(".json")) fs.unlinkSync(path.join(OUT, f));
    for (const [label, list] of Object.entries(by)) fs.writeFileSync(path.join(OUT, `${label}.json`), JSON.stringify(list, null, 1) + "\n");
    return { hosts: hosts.length, dropped, labels: Object.fromEntries(Object.entries(by).map(([k, v]) => [k, v.length])) };
  });
}

if (require.main === module) {
  const { connect } = require("../../db");
  const db = connect("readonly", { applicationName: "insight_mri_fixtures" });
  build(db).then((n) => console.log(n)).catch((e) => { console.error(e.message); process.exitCode = 2; }).finally(() => db.$pool.end());
}

module.exports = { build, masker, SQL, HOSTS_SQL, PER_LABEL };
