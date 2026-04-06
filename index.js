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
  makeAppRunLog,
] = require("./utils/logger/log");
const {
  type: { I, W, E },
  tag: { cal, det, cat, seq, qaf },
} = require("./utils/logger/enums");

// UTIL
const { v4: uuidv4 } = require("uuid");

async function run_job(job_id, system, run_log) {
  let note = {
    job_id,
    system_id: system.id,
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
  console.time("App Run Time");
  const run_log = await makeAppRunLog();

  try {
    let note = {
      LOGGER: process.env.LOGGER,
      REDIS_IP: process.env.REDIS_IP,
      PG_USER: process.env.PG_USER,
      PG_DB: process.env.PG_DB,
      argv: process.argv,
    };
    await addLogEvent(I, run_log, "on_boot", cal, note, null);

    const shell_value = process.argv[2];
    const queryString = boot_queires[shell_value];

    const systems = await pgPool.any(queryString);

    for (const system of systems) {
      const job_id = uuidv4();
      await run_job(job_id, system, run_log);
    }

    await dbInsertLogEvents(pgp, run_log);
    await writeLogEvents(run_log);

    console.log("\n********** END **********");
    console.timeEnd("App Run Time");
  } catch (error) {
    console.log(error);
    await addLogEvent(E, run_log, "on_boot", cat, null, error);
    await dbInsertLogEvents(pgp, run_log);
    await writeLogEvents(run_log);
  } finally {
    // close Postgres
    try {
      if (pgPool?.end) {
        await pgPool.end();
      }
    } catch (e) {
      console.error("Error closing pgPool:", e);
    }

    try {
      if (pgp?.end) {
        pgp.end();
      }
    } catch (e) {
      console.error("Error closing pgp:", e);
    }

    process.exit();
  }
}


on_boot();
