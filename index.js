("use strict");
require("dotenv").config();

// PARSEING JOBS
const { ge_ct_parsers, ge_cv_parsers, ge_mri_parsers } = require("./jobs");

// DATABASE
const pgPool = require("./utils/db/pg-pool");
const pgp = require("pg-promise")();

// ACQUISITION QUEIRES
const boot_queires = require("./acquisition/on_boot_queries");

// LOGGER
const [
  addLogEvent,
  writeLogEvents,
  dbInsertLogEvents,
  makeAppRunLog
] = require("./utils/logger/log");
const {
  type: { I, W, E },
  tag: { cal, det, cat, seq, qaf }
} = require("./utils/logger/enums");

// UTIL
const { v4: uuidv4 } = require("uuid");

async function run_job(job_id, system, run_log) {
  let note = {
    job_id,
    system_id: system.id
  };

  try {
    await addLogEvent(I, run_log, "run_job", cal, note, null);

    switch (system.modality) {
      case "MRI":
        await ge_mri_parsers(job_id, system, run_log);
        break;
      case "CT":
        await ge_ct_parsers(job_id, system, run_log);
        break;
      case "CV/IR":
        await ge_cv_parsers(job_id, system, run_log);
        break;
      default:
        break;
    }
  } catch (error) {
    console.log("ERROR OCCURED IN run_job" + error);
    await addLogEvent(E, run_log, "run_job", cat, note, error);
  }
}

async function on_boot() {
  const run_log = await makeAppRunLog();

  let shell_value = [process.argv[2]];

  try {
    let note = {
      LOGGER: process.env.LOGGER,
      REDIS_IP: process.env.REDIS_IP,
      PG_USER: process.env.PG_USER,
      PG_DB: process.env.PG_DB,
      argv: process.argv
    };
    await addLogEvent(I, run_log, "on_boot", cal, note, null);

    let queryString = boot_queires[shell_value];

    const systems = await pgPool.any(queryString);

    // FOR DEV TESTING TO REACH DEV DATA_ACQU FILES @ /home/matt-teixeira/hep3/hhm_data_acquisition
    if (process.env.DEV_ENV === "dev") {
      let dv_path = "/home/matt-teixeira/hep3/hhm_data_acquisition";
      for (let system of systems) {
        system.debian_server_path = `${dv_path}/files/${system.id}`;
      }
    }

    console.log(systems);

    for await (const system of systems) {
      const job_id = uuidv4();

      await run_job(job_id, system, run_log);
    }
    // await dbInsertLogEvents(pgp, run_log);
    console.log(run_log.log_events);
    await writeLogEvents(run_log);
  } catch (error) {
    console.log(error);
    await addLogEvent(E, run_log, "on_boot", cat, null, error);
    // await dbInsertLogEvents(pgp, run_log);
    await writeLogEvents(run_log);
  }
}

on_boot();
