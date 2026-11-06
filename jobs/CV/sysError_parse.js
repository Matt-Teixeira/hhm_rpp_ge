"use strict";
// Per-line parse of GE CV sysError.log (moved out of sysError_parser.js for
// CV-1b so tests and the snapshot simulation run the production logic).
// The row it builds for a matching line is exactly what the parser built
// before: same regex, same millisecond fix, same date handling, same quote
// stripping. Differences are in what is reported, not what is inserted:
// - blank lines are skipped silently (before, the empty string after the
//   final newline of every incremental read was logged as "NO MATCH FOUND");
// - a header line is skipped wherever it appears (before: only on line 1).
// host_datetime: generateDateTime's "ge_cv_syserror" case, called directly
// (same pattern, same default zone) so this module loads without the logger
// and DB pool; the simulation checks it against every stored row.

const { ge_regex } = require("../../parse/parsers");
const { dateTimeTemplate } = require("../../processing/dateTimeTemplate");
const { remove_dub_quotes, blankLineTest } = require("../../tooling/regExHelpers");
const { HEADER_RE } = require("../../read/syserror_file");

// = processing/generateDateTimes.js, case "ge_cv_syserror" (its catch logs
// and returns undefined; luxon's fromFormat does not throw, it returns an
// invalid DateTime whose toISO() is null).
async function cv_host_datetime(job_id, sme, host_date, host_time, time_zone_id) {
  if (!time_zone_id) time_zone_id = "America/New_York";
  try {
    return await dateTimeTemplate(job_id, sme, `${host_date}${host_time}`, "yyyy-MM-ddHH:mm:ss.SSS", `${time_zone_id}`);
  } catch {
    return undefined;
  }
}

// text: complete lines (from read/syserror_file.js complete_lines)
// ctx:  { job_id, system_id, parser, time_zone_id, capture_datetime }
// Returns { rows, unmatched: [{ line_num, line }], dt_null: [{ line_num, groups }] }
async function parse_syserror_lines(text, ctx) {
  const rows = [];
  const unmatched = [];
  const dt_null = [];
  const re = ge_regex.cv[ctx.parser];
  const lines = text.split(/\r\n|\r|\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (blankLineTest(line)) continue;
    if (HEADER_RE.test(line)) continue;
    const matches = line.match(re);
    if (!matches) {
      unmatched.push({ line_num: i + 1, line });
      continue;
    }
    matches.groups.system_id = ctx.system_id;

    // Removes colon ":" from millisecond delimiter and change to period "."
    const t = matches.groups.host_time.split(":");
    matches.groups.host_time = `${t[0]}:${t[1]}:${t[2]}.${t[3]}`;

    const dtObject = await cv_host_datetime(
      ctx.job_id,
      matches.groups.system_id,
      matches.groups.host_date,
      matches.groups.host_time,
      ctx.time_zone_id
    );
    if (dtObject === null) dt_null.push({ line_num: i + 1, groups: { ...matches.groups } });

    matches.groups.capture_datetime = ctx.capture_datetime;
    matches.groups.host_datetime = dtObject;

    if (matches.groups.subsystem !== "") remove_dub_quotes(matches, "subsystem");

    rows.push(matches.groups);
  }
  return { rows, unmatched, dt_null };
}

module.exports = { parse_syserror_lines };
