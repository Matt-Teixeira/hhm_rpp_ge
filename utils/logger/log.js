// utils/logger/log.js — THE FLEET'S RUN LOGGER, MASTER COPY.
// The master lives in data_acquisition (next to docs/migration_CLAUDE.md);
// every other app copies this file VERBATIM. Nothing app-specific belongs here:
// change it in the master, then re-copy. Requires only ./enums,
// ../db/pg-pool, ../db/sql/pg-helpers and Node built-ins (no npm packages).
const enums = require("./enums");
const db = require("../db/pg-pool");
const { pg_column_sets } = require("../db/sql/pg-helpers");
const fs = require("fs");
const { randomUUID } = require("node:crypto");
const { performance } = require("node:perf_hooks");

// ALWAYS the container/dev-tree path. Where it lands on the HOST is the compose
// ${LOG_DIR:-./utils/logger/logs} mount's decision (dev tree by default,
// /opt/run-logs/<app> in a release), so a missing LOG_DIR fails SAFE into the
// dev tree instead of writing into the production record.
const LOG_DIR = "./utils/logger/logs";

// Run-log FILE NAMES carry the run's start time in New York time (a fleet
// constant on purpose, not an env setting). Only the name: event `dt` and
// everything in util.app_run_logs stay UTC ISO, and process TZ is never set.
const LOG_FILE_TZ = "America/New_York";

const stamp_format = new Intl.DateTimeFormat("en-US", {
  timeZone: LOG_FILE_TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  fractionalSecondDigits: 3,
  hourCycle: "h23",
  timeZoneName: "longOffset",
});

// Date -> "YYYY-MM-DDTHH-MM-SS.mmm±HHMM" (local wall time + its UTC offset, no
// colons). pg_manage_v2's scripts/rotate-run-logs.sh dates files by this exact
// shape and falls back to mtime for anything else — keep the two in step.
const fileStamp = (date) => {
  const p = {};
  for (const { type, value } of stamp_format.formatToParts(date)) p[type] = value;
  // longOffset prints "GMT-04:00", or a bare "GMT" for a zero offset.
  const m = /^GMT(?:([+-])(\d{2}):(\d{2}))?$/.exec(p.timeZoneName);
  if (!m) throw new Error(`[logger] unexpected UTC offset '${p.timeZoneName}'`);
  const offset = m[1] ? `${m[1]}${m[2]}${m[3]}` : "+0000";
  return (
    `${p.year}-${p.month}-${p.day}T${p.hour}-${p.minute}-${p.second}` +
    `.${p.fractionalSecond}${offset}`
  );
};

// Opens <dir>/<prefix>.<stamp>.json EXCLUSIVELY ("wx"). If two runs start in
// the same millisecond, the later one takes the next free millisecond — never
// a suffix, which would break the rotation job's name pattern.
const openRunLogFile = (dir, prefix, start) => {
  for (let ms = start.getTime(), tries = 0; ; ms++, tries++) {
    const candidate = `${dir}/${prefix}.${fileStamp(new Date(ms))}.json`;
    try {
      return { path: candidate, fd: fs.openSync(candidate, "wx") };
    } catch (error) {
      if (error.code !== "EEXIST" || tries >= 1000) throw error;
    }
  }
};

// EXPRESS WILL CREATE A run_id FOR EACH ENDPOINT INSTANCE AND
// WILL NOT WRITE LOGS TO LOCAL STORAGE, ONLY INSERT TO DB
let path;
let write_stream;
// FIRST FILE-SINK FAILURE (open or async stream error). RECORDED, NOT THROWN:
// THE RUN AND THE DB SINK CARRY ON, AND writeLogEvents REPORTS IT AS false.
let file_error;
const makeAppRunLog = async () => {
  // run_id stays a UUID in every event and DB row (ops-dashboard finds runs
  // by it); the file name carries the start-time stamp instead.
  const run_id = randomUUID();
  path = undefined;
  write_stream = undefined;
  file_error = null;

  // EXPRESS HTTP APP ISN'T EPHERMAL
  if (process.env.APP_NAME !== "express-http") {
    try {
      // Covers non-Docker runs; in Docker the bind mount already exists.
      fs.mkdirSync(LOG_DIR, { recursive: true });
      // USER_ID tags the file (dev = username, release = svc).
      const opened = openRunLogFile(
        LOG_DIR,
        `${process.env.APP_NAME}-log.${process.env.USER_ID}`,
        new Date()
      );
      path = opened.path;
      write_stream = fs.createWriteStream(path, { fd: opened.fd });
      // A LISTENER FROM THE START: AN UNHANDLED STREAM 'error' WOULD KILL THE
      // PROCESS BEFORE EITHER SINK IS WRITTEN.
      write_stream.on("error", (error) => {
        file_error = file_error || error;
      });
    } catch (error) {
      file_error = error;
      console.error(
        `[logger] makeAppRunLog: cannot create run log in ${LOG_DIR}: ${
          error.message || error
        }`
      );
    }
  }

  return {
    run_id: run_id,
    log_events: [],
    timers: new Map(),
  };
};

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
    // err MAY BE null/undefined (throw null, bare rejections) — THE LOGGER
    // MUST NEVER THROW WHILE RECORDING A FAILURE.
    log_event["err_msg"] = err?.stack ? err.stack : err ?? "Unknown error";

    // CONSOLE LOG ERROR TO DEV
    if (process.env.LOGGER_MODE === "log_and_console") {
      console.log(log_event.err_msg);
    }
  }

  log_events.push(log_event);
};

const startTimer = (run_log, label) => {
  if (!run_log?.timers) return;
  run_log.timers.set(label, performance.now());
};

const endTimer = async (run_log, label, extra_note) => {
  if (!run_log?.timers) return;
  const t0 = run_log.timers.get(label);
  if (t0 === undefined) {
    await addLogEvent(
      enums.type.W,
      run_log,
      label,
      enums.tag.det,
      { missing_start: true, ...(extra_note || null) },
      null
    );
    return;
  }
  run_log.timers.delete(label);
  const duration_ms = Math.round(performance.now() - t0);
  await addLogEvent(
    enums.type.I,
    run_log,
    label,
    enums.tag.det,
    { duration_ms, ...(extra_note || null) },
    null
  );
};

// Compute stats + buckets over timer events. Labels of the form `prefix.suffix`
// with 3+ distinct sub-labels (e.g. exec.SME01234, exec.SME05678, ...) are
// aggregated under `prefix.*`; everything else is reported as a scalar.
// When a timer event's note contains an IPv4 address string in any field, the
// event is also bucketed by /24 subnet; apps with no IPv4 in their notes will
// not see a `subnets` field in the output.
const IPV4_RE = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;
const extractIpv4FromNote = (note) => {
  if (!note || typeof note !== "object") return null;
  for (const v of Object.values(note)) {
    if (typeof v === "string" && IPV4_RE.test(v)) return v;
  }
  return null;
};
const subnet24 = (ip) => ip.split(".").slice(0, 3).join(".");

const computeRunSummary = (log_events) => {
  const durations = log_events
    .filter((e) => e?.note && typeof e.note.duration_ms === "number")
    .map((e) => ({ label: e.func, ms: e.note.duration_ms, note: e.note }));

  const labelsByPrefix = new Map();
  for (const { label } of durations) {
    const dot = label.indexOf(".");
    if (dot < 0) continue;
    const prefix = label.substring(0, dot);
    if (!labelsByPrefix.has(prefix)) labelsByPrefix.set(prefix, new Set());
    labelsByPrefix.get(prefix).add(label);
  }
  const aggregablePrefixes = new Set(
    [...labelsByPrefix]
      .filter(([, set]) => set.size >= 3)
      .map(([p]) => p)
  );

  const stats = (arr) => {
    const sorted = [...arr].sort((a, b) => a - b);
    const q = (x) =>
      sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * x))];
    return {
      count: sorted.length,
      min_ms: sorted[0],
      p50_ms: q(0.5),
      p95_ms: q(0.95),
      max_ms: sorted[sorted.length - 1],
    };
  };
  const bucket = (arr) => {
    const b = {
      "<10s": 0,
      "10-30s": 0,
      "30-60s": 0,
      "60-90s": 0,
      ">=90s": 0,
    };
    for (const ms of arr) {
      if (ms < 10_000) b["<10s"]++;
      else if (ms < 30_000) b["10-30s"]++;
      else if (ms < 60_000) b["30-60s"]++;
      else if (ms < 90_000) b["60-90s"]++;
      else b[">=90s"]++;
    }
    return b;
  };

  const timers = {};
  const aggregated = new Map();
  for (const { label, ms } of durations) {
    const dot = label.indexOf(".");
    const prefix = dot >= 0 ? label.substring(0, dot) : null;
    if (prefix && aggregablePrefixes.has(prefix)) {
      if (!aggregated.has(prefix)) aggregated.set(prefix, []);
      aggregated.get(prefix).push(ms);
    } else {
      timers[label] = { duration_ms: ms };
    }
  }
  for (const [prefix, arr] of aggregated) {
    timers[`${prefix}.*`] = { ...stats(arr), buckets: bucket(arr) };
  }

  // Opt-in subnet aggregation: only fires when events carry an IPv4 in their note.
  const bySubnet = new Map();
  for (const { ms, note } of durations) {
    const ip = extractIpv4FromNote(note);
    if (!ip) continue;
    const key = subnet24(ip);
    if (!bySubnet.has(key)) bySubnet.set(key, []);
    bySubnet.get(key).push(ms);
  }
  const subnets = {};
  for (const [key, arr] of bySubnet) {
    if (arr.length < 2) continue; // a single system is not a "cluster"
    subnets[key] = { ...stats(arr), buckets: bucket(arr) };
  }

  const first_dt = log_events[0]?.dt;
  const last_dt = log_events[log_events.length - 1]?.dt;
  const wall_clock_ms =
    first_dt && last_dt
      ? new Date(last_dt).getTime() - new Date(first_dt).getTime()
      : null;

  const result = { wall_clock_ms, event_count: log_events.length, timers };
  if (Object.keys(subnets).length > 0) result.subnets = subnets;
  return result;
};

const addRunSummary = async (run_log) => {
  if (!run_log?.log_events) return;
  const summary = computeRunSummary(run_log.log_events);
  await addLogEvent(
    enums.type.I,
    run_log,
    "run_summary",
    enums.tag.det,
    summary,
    null
  );
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

    // STORE LOGS TO PG. AN APP WHOSE ROLE MAY ONLY WRITE ITS SELF-LOG THROUGH A
    // CHECK-OPTION VIEW DEFINES pg_column_sets.util.self_log IN ITS OWN
    // pg-helpers; EVERY OTHER APP INSERTS INTO util.app_run_logs DIRECTLY.
    const query = pgp.helpers.insert(
      app_run_log,
      pg_column_sets.util.self_log || pg_column_sets.util.app_run_logs
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
  if (!write_stream && !file_error) return true;

  // AWAIT THE STREAM'S finish/error SO THE PROCESS CANNOT EXIT BEFORE THE
  // RUN LOG HITS DISK. STREAM ERRORS (EACCES ON /opt/run-logs, ENOSPC, ...)
  // ARE ASYNC -- THE OLD SYNC try/catch NEVER SAW THEM. REPORT AND RETURN
  // false INSTEAD OF SWALLOWING (OR CRASHING ON AN UNHANDLED 'error').
  const ok =
    !file_error &&
    (await new Promise((resolve) => {
      write_stream.once("error", () => resolve(false));
      write_stream.end(JSON.stringify(log_events), (error) =>
        resolve(!error && !file_error)
      );
    }));
  if (!ok) {
    const error = file_error || "stream did not finish";
    console.error(
      `[logger] writeLogEvents: failed to write run log to ${
        path || LOG_DIR
      }: ${error.message || error}`
    );
  }

  // PROVIDE BASIC DEV STATS
  if (process.env.LOGGER_MODE === "log_and_console") {
    console.log(`\nFIRST LOG EVENT: ${JSON.stringify(log_events[0])}`);
    console.log(
      `LAST LOG EVENT: ${JSON.stringify(log_events[log_events.length - 1])}\n`
    );
    console.log(`WROTE ${log_events.length} EVENTS TO ${path || "(no file)"}`);
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
  startTimer,
  endTimer,
  addRunSummary,
];

// NAMED EXTRAS FOR utils/logger/log.test.js. Callers keep destructuring the
// array by position; these do not shift it.
Object.assign(module.exports, {
  LOG_FILE_TZ,
  fileStamp,
  openRunLogFile,
});
