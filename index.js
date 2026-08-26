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

// FAIL-LOUDLY EXIT-CODE CONTRACT (see DESIGN.md):
//   0 = success or skipped, 1 = failed (fatal error reached on_boot),
//   2 = partial (tolerated per-system errors) or self-log persistence failure,
//   3 = usage error (unknown run group -> operator must fix the crontab).
const EXIT = { SUCCESS: 0, FAILED: 1, PARTIAL: 2, USAGE: 3 };

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
      default: {
        // FAIL LOUDLY (TOLERATED): AN UNRECOGNIZED modality ON A CONFIG ROW
        // PREVIOUSLY NO-OP'D SILENTLY -- NOTHING ACQUIRED FOR THAT SYSTEM,
        // NO EVENT, EXIT 0. THE THROW IS CAUGHT BY THIS FUNCTION'S OWN CATCH
        // BELOW AND LOGGED AS A PER-SYSTEM ERROR EVENT (NOTE CARRIES
        // system_id), SO THE RUN BECOMES partial (EXIT 2), NOT failed.
        const err = new Error(
          `Unknown modality for system ${system.id}: ${JSON.stringify(
            system.modality
          )}`
        );
        err.code = "E_UNKNOWN_MODALITY";
        throw err;
      }
    }
  } catch (error) {
    console.log("ERROR OCCURED IN run_job" + error);
    await addLogEvent(E, run_log, "run_job", cat, note, error);
  }
}

// DERIVE THE FINAL RUN OUTCOME FROM THE EVENTS THE RUN ACTUALLY RECORDED.
// TOLERATED (PER-SYSTEM) FAILURES WERE CAUGHT BY run_job'S PER-UNIT CATCH
// (NOTE KEYED ON system_id) AND LOGGED AS ERROR EVENTS; A FATAL ERROR IS ONE
// THAT ESCAPED TO on_boot'S CATCH. SEE DESIGN.md ("run_outcome/v1").
const deriveOutcome = (run_log, fatal_error) => {
  const events = run_log.log_events || [];
  const error_events = events.filter((e) => e.type === "ERROR").length;
  const warn_events = events.filter((e) => e.type === "WARN").length;
  const failed_systems = [
    ...new Set(
      events
        .filter((e) => e.type === "ERROR" && e.note)
        .map((e) => e.note.sme || e.note.system_id)
        .filter(Boolean)
    ),
  ];

  let outcome;
  let exit_code;
  if (fatal_error) {
    outcome = "failed";
    exit_code =
      fatal_error.code === "E_UNKNOWN_RUN_GROUP" ? EXIT.USAGE : EXIT.FAILED;
  } else if (error_events > 0) {
    outcome = "partial";
    exit_code = EXIT.PARTIAL;
  } else if (run_log.outcome === "skipped") {
    // JOBS MAY OPT IN: run_log.outcome = "skipped" WHEN THERE WAS NO WORK.
    outcome = "skipped";
    exit_code = EXIT.SUCCESS;
  } else {
    outcome = "success";
    exit_code = EXIT.SUCCESS;
  }

  return {
    outcome: outcome,
    exit_code: exit_code,
    error_events: error_events,
    warn_events: warn_events,
    systems: {
      failed_count: failed_systems.length,
      failed: failed_systems.slice(0, 50),
    },
    fatal: fatal_error
      ? {
          code: fatal_error.code || null,
          message: String(fatal_error.message || fatal_error),
        }
      : null,
    contract: "run_outcome/v1",
  };
};

async function on_boot() {
  console.time("App Run Time");
  const run_log = await makeAppRunLog();

  // RELEASE_SHA is stamped into the deployed .env by build-release.sh; a dev
  // tree has no key and records 'dev-tree'. A 'dev-tree' row appearing on a
  // schedule means cron is running the wrong copy.
  let note = {
    USER_ID: process.env.USER_ID,
    LOGGER_MODE: process.env.LOGGER_MODE,
    RELEASE_SHA: process.env.RELEASE_SHA || "dev-tree",
    argv: process.argv,
  };

  // EVENT 0'S NOTE SHAPE IS LOAD-BEARING: ops-dashboard DERIVES THIS APP'S
  // JOB LABEL FROM verbose_log->0->'note'->'argv'->>2. DO NOT RESHAPE IT.
  await addLogEvent(I, run_log, "on_boot", cal, note, null);

  let fatal_error = null;
  try {
    const shell_value = process.argv[2];
    const queryString = boot_queires[shell_value];

    if (!queryString) {
      // FAIL LOUDLY: A TYPO'D CRONTAB ENTRY MUST NOT EXIT 0 AS A SILENT
      // NO-OP (PREVIOUSLY THIS FELL INTO pgPool.any(undefined)).
      const err = new Error(
        `Unknown run group: ${JSON.stringify(shell_value)}`
      );
      err.code = "E_UNKNOWN_RUN_GROUP";
      throw err;
    }

    const systems = await pgPool.any(queryString);

    for (const system of systems) {
      const job_id = uuidv4();
      await run_job(job_id, system, run_log);
    }
  } catch (error) {
    fatal_error = error;
    console.error(error);
    await addLogEvent(E, run_log, "on_boot", cat, null, error);
  } finally {
    // 1) DECIDE THE OUTCOME AND SET THE (HONEST) EXIT CODE. NEVER process.exit():
    //    process.exitCode LETS PENDING I/O FLUSH AND THE LOOP DRAIN NATURALLY.
    //    (THE OLD UNCONDITIONAL process.exit() HERE WAS THE FLUSH BUG: IT TORE
    //    THE PROCESS DOWN BEFORE THE RUN-LOG WRITE STREAM HIT DISK, AND IT
    //    ALWAYS REPORTED 0.)
    const outcome = deriveOutcome(run_log, fatal_error);
    process.exitCode = outcome.exit_code;

    // 2) APPEND TERMINAL run_outcome EVENT (type INFO ON PURPOSE: IT MUST
    //    NEVER LAND IN warn_error_logs -- ops-dashboard DERIVES STATUS AND
    //    incident-engine MATERIALIZES INCIDENTS FROM THAT COLUMN). THIS
    //    APP'S VENDORED LOGGER (VARIANT B) HAS NO addRunSummary; THE
    //    OUTCOME EVENT IS STILL LAST AND CARRIES A VALID dt FOR ended_at.
    await addLogEvent(I, run_log, "run_outcome", det, outcome, null);

    // 3) PERSIST THE SELF-LOG, DB FIRST THEN DISK (DISK CAPTURES ANY DB-INSERT
    //    ERROR EVENT). BOTH NOW REPORT FAILURE INSTEAD OF SWALLOWING IT.
    const db_insert_ok = await dbInsertLogEvents(pgp, run_log);
    const disk_write_ok = await writeLogEvents(run_log);
    if (!db_insert_ok || !disk_write_ok) {
      // MONITORING IS BLIND FOR THIS RUN -- NEVER REPORT A CLEAN SUCCESS.
      if (process.exitCode === EXIT.SUCCESS) process.exitCode = EXIT.PARTIAL;
      console.error(
        `[run_outcome] self-log persistence failed (db=${db_insert_ok} disk=${disk_write_ok})`
      );
    }

    console.log(
      `[run_outcome] ${outcome.outcome} exit=${process.exitCode}` +
        ` errors=${outcome.error_events} warns=${outcome.warn_events}` +
        ` failed_systems=${outcome.systems.failed_count}`
    );
    console.log("\n********** END **********");
    console.timeEnd("App Run Time");

    // 4) RELEASE THE SHARED POOL SO THE EVENT LOOP CAN DRAIN. THE OLD GUARD
    //    `if (pgPool?.end)` WAS A SILENT NO-OP: A pg-promise Database EXPOSES
    //    $pool.end(), NOT .end(). THIS APP HAS EXACTLY ONE LIVE POOL
    //    (utils/db/pg-pool).
    try {
      await pgPool.$pool.end();
    } catch (e) {
      console.error(`[run_outcome] utils/db/pg-pool close: ${e.message}`);
    }
    pgp.end();

    // 5) FAILSAFE: IF A LEAKED HANDLE (REDIS CLIENT, CHILD PROCESS) KEEPS THE
    //    LOOP ALIVE, FORCE-EXIT WITH THE SAME HONEST CODE INSTEAD OF HANGING
    //    UNDER CRON. unref() SO THE TIMER ITSELF NEVER HOLDS THE LOOP OPEN.
    const failsafe = setTimeout(() => {
      console.error(
        "[run_outcome] event loop did not drain within 30s; forcing exit"
      );
      process.exit(process.exitCode);
    }, 30_000);
    failsafe.unref();
  }
}

on_boot().catch((error) => {
  // BOOTSTRAP FAILURE (makeAppRunLog / FIRST LOG EVENT): NOTHING WAS RECORDED,
  // SO AT LEAST CRASH HONESTLY.
  console.error(error);
  process.exit(EXIT.FAILED);
});
