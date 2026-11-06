const db = require("../../utils/db/pg-pool");
const pgp = require("pg-promise")();
const { ge_cv_syserror_schema } = require("../../persist/pg-schemas");
const mapDataToSchema = require("../../persist/map-data-to-schema");
const { build_upsert_str } = require("../../tooling");
const { open_syserror, plan_read, complete_lines, partial_tail, head_key } = require("../../read/syserror_file");
const { parse_syserror_lines } = require("./sysError_parse");
const { drop_already_ingested_cv } = require("../../persist/drop_already_ingested_cv");
const { getRedisFileSize, getRedisLine, updateRedisLine } = require("../../redis/redisHelpers");

const { pg_column_sets: pg_cs } = require("../../utils/db/sql/pg-helpers_hhm");

// GE CV sysError.log -> log.ge_cv_syserror (PLAN-CV-INSIGHTS.md §5, CV-1b).
//
// Redis keys (prod Redis, unchanged names):
//   <sme>.sysError.log       byte watermark. Now always the end of the last
//                            complete line read (before: the file size
//                            re-measured after the insert).
//   <sme>.sysError.log.head  NEW: first data line of the file last read; a
//                            different first line means GE started a new file.
// Order is unchanged: parse -> insert -> watermark -> offline_hhm_conn. If
// the insert fails, nothing in Redis moves and the next run reads the same
// bytes again; drop_already_ingested_cv makes that re-read harmless.
async function ge_cv_sys_error(System, capture_datetime) {
  const file_name = System.file_config.file_name;
  let note = {
    job_id: System.job_id,
    system_id: System.sme,
    file: file_name
  };
  let file = null;

  try {
    await System.addLogEvent(System.I, System.run_log, "ge_cv_sys_error", System.cal, note, null);

    // ** Start Data Acquisition

    const prev_offset = await getRedisFileSize(System.sme, file_name, System.run_log);
    const prev_head = await getRedisLine(System.sme, head_key(file_name), System.run_log);

    file = await open_syserror(System.complete_file_path);
    if (!file || !file.size) {
      await System.addLogEvent(System.W, System.run_log, "ge_cv_sys_error", System.det,
        { ...note, message: "File not present or empty", file_path: System.complete_file_path }, null);
      return;
    }

    const plan = plan_read({ prev_offset, prev_head, file_size: file.size, file_head: file.head });
    const read_note = { ...note, prev_offset, file_size: file.size, start: plan.start, reason: plan.reason, head_changed: prev_head !== null && file.head !== null && prev_head !== file.head };
    if (plan.start === null) {
      await System.addLogEvent(System.I, System.run_log, "ge_cv_sys_error: read", System.det, { ...read_note, message: "No new file data" }, null);
      return;
    }
    // A full read of a file we had already read part of: say why (the
    // drop_already_ingested_cv note below says how many rows it removed).
    if (plan.start === 0 && plan.reason !== "no_watermark") {
      await System.addLogEvent(System.W, System.run_log, "ge_cv_sys_error: read", System.det,
        { ...read_note, message: `Reading entire file (${plan.reason})` }, null);
    } else {
      await System.addLogEvent(System.I, System.run_log, "ge_cv_sys_error: read", System.det, read_note, null);
    }

    const { text, consumed } = complete_lines(await file.read_from(plan.start));
    const new_offset = plan.start + consumed;
    const tail = partial_tail({ start: plan.start, consumed, size: file.size });
    if (tail) {
      await System.addLogEvent(tail.warn ? System.W : System.I, System.run_log, "ge_cv_sys_error: read", System.det,
        { ...note, message: tail.message, partial_bytes: tail.bytes }, null);
    }
    if (consumed === 0) return;

    // ** End Data Acquisition

    // ** Begin Parse

    const { rows, unmatched, dt_null } = await parse_syserror_lines(text, {
      job_id: System.job_id,
      system_id: System.sysConfigData.id,
      parser: System.file_config.parsers[0],
      time_zone_id: System.sysConfigData.time_zone_id,
      capture_datetime
    });
    for (const u of unmatched) {
      await System.addLogEvent(System.W, System.run_log, "ge_cv_sys_error", System.det,
        { job_id: System.job_id, system_id: System.sme, message: "NO MATCH FOUND", line_num: u.line_num, line_data: u.line }, null);
    }
    for (const d of dt_null) {
      await System.addLogEvent(System.W, System.run_log, "ge_cv_sys_error", System.det,
        { job_id: System.job_id, system_id: System.sme, line_num: d.line_num, match_group: d.groups, message: "datetime object null" }, null);
    }

    const mappedData = mapDataToSchema(rows, ge_cv_syserror_schema);

    // ** End Parse

    // ** Begin Persist

    const dedupe = await drop_already_ingested_cv(db, System.sme, mappedData);
    if (dedupe.error || dedupe.dropped > 0) {
      await System.addLogEvent(dedupe.error ? System.E : System.W, System.run_log, "ge_cv_sys_error: drop_already_ingested_cv", System.det,
        { ...note, parsed: mappedData.length, dropped: dedupe.dropped, checked: dedupe.checked, range: dedupe.range, message: dedupe.error ? "Check failed; inserting all parsed rows" : "Dropped records already in log.ge_cv_syserror" },
        dedupe.error || null);
    }

    if (dedupe.fresh.length > 0) {
      const query = pgp.helpers.insert(dedupe.fresh, pg_cs.log.ge.ge_cv_syserror);
      await db.any(query);
    }

    note.number_of_rows = dedupe.fresh.length;
    note.parsed_rows = mappedData.length;
    note.first_row = dedupe.fresh[0];
    note.last_row = dedupe.fresh[dedupe.fresh.length - 1];
    note.message = dedupe.fresh.length > 0 ? "Successful Insert" : "Nothing new to insert";
    await System.addLogEvent(System.I, System.run_log, "ge_cv_sys_error", System.det, note, null);

    // ** End Persist

    // Update Redis: watermark to the end of the last complete line read,
    // then the file identity.
    await updateRedisLine(System.sme, file_name, String(new_offset), System.run_log);
    if (file.head !== null) await updateRedisLine(System.sme, head_key(file_name), file.head, System.run_log);

    // Update alert.offline_hhm_conn table with host_datetime (last parsed
    // row, as before)
    if (mappedData.length > 0) {
      const resent_host_datetime = mappedData[mappedData.length - 1].host_datetime;
      const upsert_str = build_upsert_str(System.sme, resent_host_datetime);
      await db.any(upsert_str);
    }
  } catch (error) {
    console.log(error);
    let note = {
      job_id: System.job_id,
      system_id: System.sysConfigData.id
    };
    await System.addLogEvent(System.E, System.run_log, "ge_cv_sys_error", System.cat, note, error);
  } finally {
    if (file) await file.close();
  }
}

module.exports = ge_cv_sys_error;
