const db = require("../../utils/db/pg-pool");
const pgp = require("pg-promise")();
const { ge_regex } = require("../../parse/parsers");
const { ge_cv_syserror_schema } = require("../../persist/pg-schemas");
const mapDataToSchema = require("../../persist/map-data-to-schema");
const { blankLineTest } = require("../../tooling/regExHelpers");
const generateDateTime = require("../../processing/generateDateTimes");
const { remove_dub_quotes } = require("../../tooling/regExHelpers");
const { build_upsert_str } = require("../../tooling");

const { pg_column_sets: pg_cs } = require("../../utils/db/sql/pg-helpers_hhm");

// File data streamed line by line
async function ge_cv_sys_error(System, capture_datetime) {
  // an array in each config accossiated with a file
  const parsers = System.file_config.parsers;
  const data = [];

  let note = {
    job_id: System.job_id,
    system_id: System.sme,
    file: System.file_config.file_name
  };

  try {
    await System.addLogEvent(
      System.I,
      System.run_log,
      "ge_cv_sys_error",
      System.cal,
      note,
      null
    );

    // ** Start Data Acquisition

    await System.getRedisFileSize();

    await System.getCurrentFileSize();

    if (!System.current_file_size) return;

    await System.getFileData("read_stream");

    const last_mod = (
      await System.getLastModifiedTime(System.complete_file_path)
    ).toISOString();

    const file_metadata = {
      system_id: System.sme,
      file_name: System.file_config.file_name,
      last_mod,
      source: "hhm"
    };

    if (System.delta === 0) {
      await System.push_file_dt_queue(System.run_log, file_metadata);
      return;
    }

    if (System.file_data === null) return;

    // ** End Data Acquisition

    // ** Begin Parse

    let line_num = 1;
    const sequencenumber_re = /sequencenumber,date/;

    for await (const line of System.file_data) {
      let matches = line.match(ge_regex.cv[parsers[0]]);

      // Test for headers and skip iteration if headers present
      if (line_num === 1 && sequencenumber_re.test(line)) {
        continue;
      }

      // matches will be null if no match - log bad match here
      if (!matches) {
        console.log("No Match Group");
        let note = {
          job_id: System.job_id,
          system_id: System.sme,
          message: "NO MATCH FOUND",
          line_num,
          line_data: line
        };
        await System.addLogEvent(
          System.W,
          System.run_log,
          "ge_cv_sys_error",
          System.det,
          note,
          null
        );
        continue;
      }

      line_num++;

      if (matches === null) {
        const isNewLine = blankLineTest(line);
        if (isNewLine) {
          continue;
        } else {
          let note = {
            job_id: System.job_id,
            system_id: System.sysConfigData.id,
            line: line,
            re: `${ge_regex.cv[parsers[0]]}`,
            message: "NO MATCH FOUND"
          };
          await System.addLogEvent(
            System.W,
            System.run_log,
            "ge_cv_sys_error",
            System.det,
            note,
            null
          );
        }
      } else {
        matches.groups.system_id = System.sysConfigData.id;

        // Removes colen ":" from millisecond delimiter and change to period "."
        let splitColens = matches.groups.host_time.split(":");
        matches.groups.host_time = `${splitColens[0]}:${splitColens[1]}:${splitColens[2]}.${splitColens[3]}`;

        const dtObject = await generateDateTime(
          System.job_id,
          matches.groups.system_id,
          System.file_config.pg_tables[0],
          matches.groups.host_date,
          matches.groups.host_time,
          System.sysConfigData.time_zone_id
        );

        if (dtObject === null) {
          let note = {
            job_id: System.job_id,
            system_id: System.sme,
            line: line,
            match_group: matches.groups,
            message: "datetime object null"
          };
          await System.addLogEvent(
            System.W,
            System.run_log,
            "ge_cv_sys_error",
            System.det,
            note,
            null
          );
        }

        matches.groups.capture_datetime = capture_datetime;
        matches.groups.host_datetime = dtObject;

        // Remove double quotes from str
        if (matches.groups.subsystem !== "") {
          remove_dub_quotes(matches, "subsystem");
        }

        data.push(matches.groups);
      }
    }

    const mappedData = mapDataToSchema(data, ge_cv_syserror_schema);

    /* 
    console.log("\nmappedData - ge_cv");
    console.log(System.sme);
    console.log(mappedData[mappedData.length - 1]);
    console.log(mappedData);
   */

    // ** End Parse

    // ** Begin Persist

    const query = pgp.helpers.insert(mappedData, pg_cs.log.ge.ge_cv_syserror);

    await db.any(query);

    note.number_of_rows = mappedData.length;
    note.first_row = mappedData[0];
    note.last_row = mappedData[mappedData.length - 1];
    note.message = "Successful Insert";

    await System.addLogEvent(
      System.I,
      System.run_log,
      "ge_cv_sys_error",
      System.det,
      note,
      null
    );

    // ** End Persist

    // Update Redis Cache
    await System.updateRedisFileSize();

    // Update alert.offline_hhm_conn table with host_datetime
    const resent_host_datetime =
      mappedData[mappedData.length - 1].host_datetime;

    const upsert_str = build_upsert_str(System.sme, resent_host_datetime);
    await db.any(upsert_str);
  } catch (error) {
    console.log(error);
    let note = {
      job_id: System.job_id,
      system_id: System.sysConfigData.id
    };
    await System.addLogEvent(
      System.E,
      System.run_log,
      "ge_cv_sys_error",
      System.cat,
      note,
      error
    );
  }
}

module.exports = ge_cv_sys_error;
