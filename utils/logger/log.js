const enums = require("./enums");
const db = require("../db/pg-pool");
const { pg_column_sets } = require("../db/sql/pg-helpers");
const fs = require("fs");
const { v4: uuidv4 } = require("uuid");

// EXPRESS WILL CREATE A run_id FOR EACH ENDPOINT INSTANCE AND
// WILL NOT WRITE LOGS TO LOCAL STORAGE, ONLY INSERT TO DB
let path;
let write_stream;
const makeAppRunLog = async () => {
  const run_id = uuidv4();

  // EXPRESS HTTP APP ISN'T EPHERMAL
  if (process.env.APP_NAME !== "express-http") {
    switch (process.env.RUN_ENV) {
      case "dev":
        path = `./utils/logger/${process.env.APP_NAME}-log.${process.env.LOGGER}.${run_id}.json`;
        break;

      case "staging":
        path = `/opt/run-logs/${process.env.APP_NAME}/${process.env.APP_NAME}-log.${process.env.LOGGER}.${run_id}.json`;
        break;
      default:
        path = `/opt/run-logs/${process.env.APP_NAME}/${process.env.APP_NAME}-log.${process.env.LOGGER}.${run_id}.json`;
        break;
    }

    write_stream = fs.createWriteStream(path, {
      flags: "a",
    });
  }

  return {
    run_id: run_id,
    log_events: [],
  };
};

// MAY STILL NEED TO USE WINSTON IF WRITE LOG EVENTS DON'T BECOME MORE CONSISTENT
// const winston = require('winston');
// const logger = winston.createLogger({
//    level: 'info', // Set the log level
//    format: winston.format.json(), // Use JSON format for logging
//    transports: [
//       // new winston.transports.Console(), // Log to console
//       new winston.transports.File({ filename: 'logs.log' }), // Log to a file
//    ],
// });

// const log_events = [];
const addLogEvent = async (type, run_log, func, tag, note, err) => {
  const { run_id, log_events } = run_log;

  // GENERIC log_event VALUES ADDED
  let log_event = {
    run_id: run_id,
    dt: new Date().toISOString(),
    type: type,
    func: func,
    tag: tag,
    note: note,
  };

  // CONDITIONALLY APPEND ERROR OBJECT'S STACK IF IT EXISTS
  if (type === enums.type.E) {
    log_event["err_msg"] = err.stack ? err.stack : err;

    // CONSOLE LOG ERROR TO DEV
    if (process.env.LOGGER === "dev") {
      console.log(log_event.err_msg);
    }
  }

  log_events.push(log_event);

  // WINSTON
  // logger.info(log_event);
};

const dbInsertLogEvents = async (pgp, run_log) => {
  const { run_id, log_events } = run_log;

  const {
    type: { I, E },
    tag: { det, cat },
  } = enums;

  try {
    const we_logs = log_events.filter(
      ({ type }) => type === "WARN" || type === "ERROR"
    );
    const app_run_log = [
      {
        app_name: process.env.APP_NAME,
        run_id: run_id,
        verbose_log: JSON.stringify(log_events),
        warn_error_logs: JSON.stringify(we_logs),
      },
    ];

    // STORE LOGS TO PG
    const query = pgp.helpers.insert(
      app_run_log,
      pg_column_sets.util.app_run_logs
    );
    await db.none(query);

    const note = { txt: "DB INSERT SUCCESSFUL" };
    addLogEvent(I, run_log, "dbInsertLogEvents", det, note, null);
    return true;
  } catch (error) {
    // FAIL LOUDLY: THIS ROW IS THE FLEET'S OBSERVABILITY PLANE. REPORT TO
    // STDERR (CRON MAIL / docker logs) AND TELL THE CALLER IT FAILED SO THE
    // RUN CANNOT EXIT 0 WHILE MONITORING IS BLIND. THE ERROR EVENT IS STILL
    // APPENDED SO A SUBSEQUENT writeLogEvents CAPTURES IT ON DISK.
    console.error(
      `[logger] dbInsertLogEvents: insert into util.app_run_logs failed for run ${run_id}: ${
        error.message || error
      }`
    );
    addLogEvent(E, run_log, "dbInsertLogEvents", cat, null, error);
    return false;
  }
};

const writeLogEvents = async (run_log) => {
  const { log_events } = run_log;

  // EXPRESS/HTTP MODE NEVER OPENS A WRITE STREAM; NOTHING TO FLUSH.
  if (!write_stream) return true;

  // AWAIT THE STREAM'S finish/error SO THE PROCESS CANNOT EXIT BEFORE THE
  // RUN LOG HITS DISK. STREAM ERRORS (EACCES ON /opt/run-logs, ENOSPC, ...)
  // ARE ASYNC -- THE OLD SYNC try/catch NEVER SAW THEM. REPORT AND RETURN
  // false INSTEAD OF SWALLOWING (OR CRASHING ON AN UNHANDLED 'error').
  const ok = await new Promise((resolve) => {
    write_stream.on("error", (error) => {
      console.error(
        `[logger] writeLogEvents: failed to write run log to ${path}: ${
          error.message || error
        }`
      );
      resolve(false);
    });
    write_stream.end(JSON.stringify(log_events), () => resolve(true));
  });

  // PROVIDE BASIC DEV STATS
  if (process.env.LOGGER === "dev") {
    console.log(`\nFIRST LOG EVENT: ${JSON.stringify(log_events[0])}`);
    console.log(
      `LAST LOG EVENT: ${JSON.stringify(log_events[log_events.length - 1])}\n`
    );
    console.log(`WROTE ${log_events.length} EVENTS TO DISK`);
  }

  return ok;
};

const destroyAppRunLog = async (run_log) => {
  run_log = null;
};

module.exports = [
  addLogEvent,
  writeLogEvents,
  dbInsertLogEvents,
  makeAppRunLog,
  destroyAppRunLog,
];
