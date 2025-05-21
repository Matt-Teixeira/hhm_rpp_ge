const db = require("../../utils/db/pg-pool");
const pgp = require("pg-promise")();
const { ge_regex } = require("../../parse/parsers");
const mapDataToSchema = require("../../persist/map-data-to-schema");
const { ge_mri_gesys_schema } = require("../../persist/pg-schemas");
const generateDateTime = require("../../processing/generateDateTimes");
const { build_upsert_str } = require("../../tooling");

const { pg_column_sets: pg_cs } = require("../../utils/db/sql/pg-helpers_hhm");

async function ge_mri_gesys(System, capture_datetime) {
  // an array in each config accossiated with a file
  const parsers = System.file_config.parsers;
  const data = [];

  let note = {
    job_id: System.job_id
  };

  try {
    await System.addLogEvent(
      System.I,
      System.run_log,
      "ge_mri_gesys",
      System.cal,
      note,
      null
    );

    // ** Start Data Acquisition

    await System.getRedisFileSize();

    await System.getCurrentFileSize();

    if (!System.current_file_size) return;

    await System.getFileData("read_file");

    if (System.file_data === null) return;

    // ** End Data Acquisition

    // ** Begin Parse

    // An array of matches - no .groups property
    let matches = System.file_data.match(ge_regex.mri.gesys[parsers[0]]);

    if (matches === null) {
      let note = {
        job_id: System.job_id,
        sme: System.sme,
        file: System.file_config.file_name,
        re: `${ge_regex.mri.gesys[parsers[0]]}`,
        message: "NO MATCH FOUND"
      };
      await System.addLogEvent(
        System.W,
        System.run_log,
        "ge_mri_gesys",
        System.det,
        note,
        null
      );
      return;
    }

    for await (let match of matches) {
      const matchGroups = match.match(ge_regex.mri.gesys[parsers[1]]);

      // matchGroups will be null if no match - log bad match here
      if (!matchGroups) {
        let note = {
          job_id: System.job_id,
          system_id: System.sysConfigData.id,
          prev_epoch: data[data.length - 1].epoch,
          sr_group: data[data.length - 1].sr,
          re: `${ge_regex.mri.gesys[parsers[1]]}`,
          message: "NO MATCH FOUND - Small Group",
          file_data: match
        };
        await System.addLogEvent(
          System.W,
          System.run_log,
          "ge_mri_gesys",
          System.det,
          note,
          null
        );
        continue;
      }

      matchGroups.groups.host_date = `${
        matchGroups.groups.day.length === 1
          ? 0 + matchGroups.groups.day
          : matchGroups.groups.day
      }-${matchGroups.groups.month}-${matchGroups.groups.year}`;

      matchGroups.groups.system_id = System.sysConfigData.id;

      const dtObject = await generateDateTime(
        System.job_id,
        matchGroups.groups.system_id,
        System.file_config.pg_tables[0],
        matchGroups.groups.host_date,
        matchGroups.groups.host_time,
        System.sysConfigData.time_zone_id
      );

      if (dtObject === null) {
        let note = {
          job_id: System.job_id,
          sme: System.sysConfigData.id,
          message: "datetime object null"
        };
        await System.addLogEvent(
          System.W,
          System.run_log,
          "ge_mri_gesys",
          System.det,
          note,
          null
        );
      }

      matchGroups.groups.capture_datetime = capture_datetime;
      matchGroups.groups.host_datetime = dtObject;

      data.push(matchGroups.groups);
    }

    const mappedData = mapDataToSchema(data, ge_mri_gesys_schema);
    /* 
    console.log("\nmappedData - ge_mri");
    console.log(System.sme);
    console.log(mappedData[mappedData.length - 1]);
    console.log(mappedData);
 */

    // ** End Parse

    // ** Begin Persist

    const query = pgp.helpers.insert(mappedData, pg_cs.log.ge.ge_mri_gesys);

    await db.any(query);

    // ** End Persist

    note.number_of_rows = mappedData.length;
    note.first_row = mappedData[0];
    note.last_row = mappedData[mappedData.length - 1];
    note.message = "Successful Insert";

    await System.addLogEvent(
      System.I,
      System.run_log,
      "ge_mri_gesys",
      System.det,
      note,
      null
    );

    // Update Redis Cache
    await System.updateRedisFileSize();

    // Update alert.offline_hhm_conn table with host_datetime
    const resent_host_datetime =
      mappedData[mappedData.length - 1].host_datetime;

    const upsert_str = build_upsert_str(System.sme, resent_host_datetime);

    await db.any(upsert_str);
  } catch (error) {
    let note = {
      job_id: System.job_id,
      sme: System.sysConfigData.id
    };
    await System.addLogEvent(
      System.E,
      System.run_log,
      "ge_mri_gesys",
      System.cat,
      note,
      error
    );
  }
}

module.exports = ge_mri_gesys;
