#!/usr/bin/env node
"use strict";
// One-off backfill of a GE CV sysErrorPrev.log tail into log.ge_cv_syserror
// (PLAN-CV-INSIGHTS.md §5.5 D3b, D6).
//
// GE keeps one previous log generation, DL/Log/sysErrorPrev.log. Before
// D5, records written after our last read of the old file were never
// ingested (gap class G3). This inserts exactly those records from a copy
// of sysErrorPrev.log fetched from the device.
//
// Run ON THE PRODUCTION SERVER (vm-debian), from the repo root:
//   node maintenance/backfill_ge_cv_prev_tail.js --sme SME08640 --file <copy> --expect 15            # dry run (BEGIN ... ROLLBACK)
//   node maintenance/backfill_ge_cv_prev_tail.js --sme SME08640 --file <copy> --expect 15 --apply    # COMMIT
//
// How the tail is found: the whole file is parsed with the production
// parser (jobs/CV/sysError_parse.js, the system's regex model and time
// zone from config) and passed through the production duplicate guard
// (persist/drop_already_ingested_cv.js, every parsed column compared).
// The rows that remain are the tail. It refuses to insert unless all of
// these hold:
//   - the file starts with the CSV header, its first record is sequence 1,
//     and it ends on a newline (a complete copy);
//   - every line parses (0 unmatched, 0 null datetimes);
//   - part of the file is already stored, and the rows to insert are
//     exactly the file's last N records, with contiguous sequence numbers
//     (so this is the old file we read, minus its unread end);
//   - N equals --expect;
//   - inside the INSERT's transaction, under an advisory lock per system,
//     the same check runs again and finds the same N rows (else ROLLBACK);
//   - the INSERT's row count equals N (else ROLLBACK);
//   - --apply is refused in the minutes around the parser's :18/:48 runs.
// Re-running after a COMMIT finds nothing to insert and stops.
// Redis and alert.* are not touched.

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { v4: uuidv4 } = require("uuid");

const REPO = path.resolve(__dirname, "..");
const { first_data_line, complete_lines, HEADER_RE } = require("../read/syserror_file");
const { parse_syserror_lines } = require("../jobs/CV/sysError_parse");
const mapDataToSchema = require("../persist/map-data-to-schema");
const { ge_cv_syserror_schema } = require("../persist/pg-schemas");
const { drop_already_ingested_cv } = require("../persist/drop_already_ingested_cv");

const CONFIG_SQL = `
SELECT sys.id, sites.time_zone_id, log.regex_models
FROM systems sys
JOIN config.log log ON log.system_id = sys.id
JOIN sites ON sites.id = sys.site_id
WHERE sys.id = $1 AND sys.manufacturer = 'GE' AND sys.modality = 'CV/IR' AND log.dir_name = 'sysError'
`;

// Pure-ish core (reads only): what would be inserted, and why not if not.
// db: anything with .any/.oneOrNone (pg-promise). Exported for the
// read-only rehearsal and tests.
async function plan_backfill(db, { sme, buf, expect, capture_datetime, job_id }) {
  const problems = [];
  const cfg = await db.oneOrNone(CONFIG_SQL, [sme]);
  if (!cfg) return { problems: [`${sme}: not a GE CV/IR system with a sysError log config`] };
  const parser = Array.isArray(cfg.regex_models) ? cfg.regex_models[0] : null;
  if (!parser) problems.push("no regex model in config.log");

  const { text, consumed } = complete_lines(buf);
  if (consumed !== buf.length) problems.push(`file does not end on a newline (${buf.length - consumed} trailing bytes): incomplete copy`);
  if (!HEADER_RE.test(buf.subarray(0, 64).toString("utf8"))) problems.push("file does not start with the sysError CSV header");
  const head = first_data_line(buf);
  if (!head || head.split(",")[0] !== "1") problems.push(`first record is not sequence 1 (${head ? head.slice(0, 40) : "none"})`);
  if (problems.length) return { problems, cfg };

  const parsed = await parse_syserror_lines(text, { job_id, system_id: sme, parser, time_zone_id: cfg.time_zone_id, capture_datetime });
  if (parsed.unmatched.length) problems.push(`${parsed.unmatched.length} lines do not parse (first: line ${parsed.unmatched[0].line_num})`);
  if (parsed.dt_null.length) problems.push(`${parsed.dt_null.length} lines have no datetime`);
  const rows = mapDataToSchema(parsed.rows, ge_cv_syserror_schema);

  const d = await drop_already_ingested_cv(db, sme, rows);
  if (d.error) problems.push(`duplicate check failed: ${d.error.message}`);
  const fresh = d.fresh;
  const n = fresh.length;
  const suffix = rows.slice(rows.length - n);
  const is_suffix = n > 0 && fresh.every((r, i) => r === suffix[i]);
  const seq = fresh.map((r) => Number(r.sequencenumber));
  const contiguous = seq.every((s, i) => i === 0 || s === seq[i - 1] + 1);
  const summary = {
    file_records: rows.length,
    already_stored: d.dropped,
    to_insert: n,
    seq: n ? `${seq[0]}..${seq[n - 1]}` : null,
    host_datetime: n ? `${fresh[0].host_datetime} .. ${fresh[n - 1].host_datetime}` : null,
  };
  if (n === 0) problems.push("nothing to insert: every record of this file is already stored");
  else {
    if (d.dropped === 0) problems.push("none of this file is stored yet: not the old file we read (refusing a whole-file insert)");
    if (!is_suffix) problems.push("rows to insert are not the file's last records: stored rows and file differ in the middle");
    if (!contiguous) problems.push("sequence numbers of the rows to insert are not contiguous");
  }
  if (expect !== undefined && n !== expect) problems.push(`--expect ${expect} but ${n} rows would be inserted`);
  return { problems, cfg, summary, fresh };
}

// The live parser (npm run ge_cv, cron :18 and :48) inserts into the same
// table. It can only insert an old-file tail on a rotation it detects, and
// then from the CURRENT sysErrorPrev.log, but APPLY still keeps clear of
// its runs (as maintenance/dedupe_ge_ct_gesys.js keeps clear of the alert
// processor); the in-transaction re-check covers the rest.
const PARSER_WINDOWS = [[15, 23], [45, 53]]; // minutes, inclusive
const in_parser_window = (d) => PARSER_WINDOWS.some(([f, t]) => d.getUTCMinutes() >= f && d.getUTCMinutes() <= t);

// ---------------------------------------------------------------- CLI
const out = (...s) => console.log(...s);
const hr = () => out("-".repeat(72));
const fail = (m) => Object.assign(new Error(m), { safeguard: true });

function args(argv) {
  const a = { apply: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--apply") a.apply = true;
    else if (argv[i] === "--sme") a.sme = argv[++i];
    else if (argv[i] === "--file") a.file = argv[++i];
    else if (argv[i] === "--expect") a.expect = Number(argv[++i]);
    else throw fail(`unknown argument ${argv[i]}`);
  }
  if (!/^SME\d{5}$/.test(a.sme || "") || !a.file) throw fail("usage: backfill_ge_cv_prev_tail.js --sme SMExxxxx --file <sysErrorPrev.log copy> --expect N [--apply]");
  if (!Number.isInteger(a.expect) || a.expect <= 0) throw fail("--expect N is required (the tail size found in the rehearsal)");
  return a;
}

function connect() {
  const pgp = require("pg-promise")({ noWarnings: true });
  return {
    pgp,
    db: pgp({
      host: process.env.PG_HOST, port: process.env.PG_PORT || 5432, database: process.env.PG_DB,
      user: process.env.PG_USER, password: process.env.PG_PW, max: 1,
      ssl: { require: true, cert: fs.readFileSync(path.resolve(REPO, process.env.PG_SSL_PATH)), rejectUnauthorized: true },
      application_name: "ge_cv_prev_tail_backfill",
      options: "-c lock_timeout=5000 -c statement_timeout=120000 -c idle_in_transaction_session_timeout=300000",
    }),
  };
}

async function confirm(db, a) {
  const t = await db.one("SELECT current_database() AS db, current_user AS usr, inet_server_addr()::text AS addr");
  hr();
  out(`target: database=${t.db} host=${process.env.PG_HOST} (${t.addr}) user=${t.usr}`);
  out(`step:   insert tail of ${a.file} for ${a.sme} — ${a.apply ? "APPLY (will COMMIT)" : "DRY RUN (BEGIN ... ROLLBACK)"}`);
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  const it = rl[Symbol.asyncIterator]();
  const ask = async (q) => {
    process.stdout.write(q);
    const { value, done } = await it.next();
    if (done) throw fail("no input: aborted");
    if (!process.stdin.isTTY) out(value);
    return value.trim();
  };
  try {
    if ((await ask("Type the database name to continue: ")) !== t.db) throw fail("database name mismatch: aborted");
    if (a.apply && (await ask("This COMMITS. Type APPLY to continue: ")) !== "APPLY") throw fail("not confirmed: aborted");
  } finally {
    rl.close();
  }
}

async function main() {
  const a = args(process.argv.slice(2));
  require("dotenv").config({ path: path.join(REPO, ".env") });
  const { pg_column_sets: pg_cs } = require("../utils/db/sql/pg-helpers_hhm");
  const { dt_now } = require("../tooling/dates");
  const buf = fs.readFileSync(a.file);
  const { pgp, db } = connect();
  try {
    const capture_datetime = dt_now();
    const job_id = uuidv4();
    const p = await plan_backfill(db, { sme: a.sme, buf, expect: a.expect, capture_datetime, job_id });
    hr();
    out(`file:   ${a.file} (${buf.length} bytes)`);
    out(`plan:   ${JSON.stringify(p.summary || {})}`);
    if (p.problems.length) {
      p.problems.forEach((m) => out(`REFUSED: ${m}`));
      process.exitCode = 1;
      return;
    }
    await confirm(db, a);
    if (a.apply && in_parser_window(new Date())) throw fail(`the GE CV parser runs at :18 and :48; APPLY only outside minutes ${PARSER_WINDOWS.map(([f, t]) => `${f}-${t}`).join(" and ")} (now ${new Date().toISOString()})`);
    await db.tx(async (t) => {
      // Serialize backfills of this system, then re-plan inside this
      // transaction right before the INSERT, so rows stored since the plan
      // above (another backfill, or the parser) are not inserted twice
      // (REVIEW-CV1B-PREV-CODEX P2).
      await t.one("SELECT pg_advisory_xact_lock(hashtext($1))", [`ge_cv_prev_tail_backfill:${a.sme}`]);
      const again = await plan_backfill(t, { sme: a.sme, buf, expect: a.expect, capture_datetime, job_id });
      if (again.problems.length || again.summary.seq !== p.summary.seq || again.fresh.length !== p.fresh.length) {
        throw fail(`re-check inside the transaction differs from the plan (${JSON.stringify(again.summary)}; ${again.problems.join("; ")}): rolled back`);
      }
      const res = await t.result(pgp.helpers.insert(again.fresh, pg_cs.log.ge.ge_cv_syserror));
      if (res.rowCount !== p.fresh.length) throw fail(`INSERT rowCount ${res.rowCount} != ${p.fresh.length}: rolled back`);
      out(`INSERT: ${res.rowCount} rows (${p.summary.seq})`);
      if (!a.apply) throw Object.assign(new Error("dry run"), { dryRun: true });
    }).catch((e) => {
      if (e.dryRun) return out("ROLLBACK (dry run): nothing persisted.");
      throw e;
    });
    if (a.apply) out("COMMIT: done. Re-running this command should now refuse with 'nothing to insert'.");
  } finally {
    pgp.end();
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e.safeguard ? `ABORTED: ${e.message}` : e);
    process.exitCode = 1;
  });
}

module.exports = { plan_backfill, in_parser_window, CONFIG_SQL };
