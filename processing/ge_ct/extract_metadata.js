const db = require("../../utils/db/pg-pool");
const pgp = require("pg-promise")();
const [addLogEvent] = require("../../utils/logger/log");
const {
  type: { I, W, E },
  tag: { cal, det, cat }
} = require("../../utils/logger/enums");
const { pg_column_sets: pg_cs } = require("../../utils/db/sql/pg-helpers_hhm");

async function extract(job_id, extraction_data, run_log) {
  let note = {
    job_id
  };
  await addLogEvent(I, run_log, "extract", cal, note, null);
  const data = [];
  try {
    const scan_seconds_re =
      /The current tube usage data reports a total of\s?(?<scan_seconds>\d+\.\d+)/;

    for (const group of extraction_data) {
      const match = group.message.match(scan_seconds_re);
      if (match) {
        data.push({
          system_id: group.system_id,
          name: "scan_seconds",
          value: match.groups.scan_seconds,
          host_datetime: group.host_datetime
        });
      }
    }

    // ** Begin Persist

    const query = pgp.helpers.insert(
      data,
      pg_cs.meta_data.logfile_event_history_metadata
    );

    await db.any(query);

    // ** End Persist
  } catch (error) {
    let note = {
      job_id,
      sme: data[0].system_id
    };
    console.log(error);
    await addLogEvent(E, run_log, "extract", cat, note, error);
  }
}

module.exports = extract;
