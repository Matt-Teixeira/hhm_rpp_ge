// utils/logger/log.test.js — tests for the fleet master logger (log.js).
// Copied verbatim with log.js. No database: the db modules are stubbed below.
// Run from the repo root:  node --test utils/logger/log.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const nodePath = require("path");

// --- stub ../db/pg-pool and ../db/sql/pg-helpers BEFORE requiring log.js ----
const inserts = [];
const stubModule = (rel, exports) => {
  const file = require.resolve(nodePath.join(__dirname, rel));
  require.cache[file] = { id: file, filename: file, loaded: true, exports };
};
stubModule("../db/pg-pool", { none: async (q) => void inserts.push(q) });
const column_sets = { util: { app_run_logs: "CS:app_run_logs" } };
stubModule("../db/sql/pg-helpers", { pg_column_sets: column_sets });

const logger = require("./log");
const [addLogEvent, writeLogEvents, dbInsertLogEvents, makeAppRunLog] = logger;
const { fileStamp, openRunLogFile, LOG_FILE_TZ } = logger;

// pg_manage_v2 scripts/rotate-run-logs.sh:107 (awk ERE), verbatim in JS form,
// plus the same script's name filter (list_files).
const ROTATE_STAMP_RE =
  /\.[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]-[0-9][0-9]-[0-9][0-9](\.[0-9]+)?[+-][0-9][0-9][0-9][0-9]\.json$/;
const ROTATE_NAME_RE = /^[A-Za-z0-9._+-]+$/;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// "2026-11-01T01-30-00.000-0500" -> the instant it names.
const stampToDate = (s) =>
  new Date(
    `${s.slice(0, 10)}T${s.slice(11, 19).replace(/-/g, ":")}${s.slice(19, 23)}` +
      `${s.slice(23, 26)}:${s.slice(26)}`
  );

const at = (iso) => fileStamp(new Date(iso));

const tmpDir = () => fs.mkdtempSync(nodePath.join(os.tmpdir(), "logtest-"));

test("zone is the hard-coded fleet constant", () => {
  assert.equal(LOG_FILE_TZ, "America/New_York");
});

test("orchestrator's example", () => {
  assert.equal(at("2026-10-29T12:50:51.694Z"), "2026-10-29T08-50-51.694-0400");
});

test("spring forward 2026-03-08: 01:59:59.999 EST -> 03:00 EDT, no 02:xx", () => {
  assert.equal(at("2026-03-08T06:59:59.999Z"), "2026-03-08T01-59-59.999-0500");
  assert.equal(at("2026-03-08T07:00:00.000Z"), "2026-03-08T03-00-00.000-0400");
  for (let ms = Date.parse("2026-03-08T06:00:00Z"); ms < Date.parse("2026-03-08T09:00:00Z"); ms += 60_000) {
    assert.doesNotMatch(fileStamp(new Date(ms)), /^2026-03-08T02-/);
  }
});

test("fall back 2026-11-01: the 01:30 hour happens twice, with distinct offsets", () => {
  assert.equal(at("2026-11-01T05:30:00.000Z"), "2026-11-01T01-30-00.000-0400");
  assert.equal(at("2026-11-01T05:59:59.999Z"), "2026-11-01T01-59-59.999-0400");
  assert.equal(at("2026-11-01T06:00:00.000Z"), "2026-11-01T01-00-00.000-0500");
  assert.equal(at("2026-11-01T06:30:00.000Z"), "2026-11-01T01-30-00.000-0500");
  assert.notEqual(at("2026-11-01T05:30:00.000Z"), at("2026-11-01T06:30:00.000Z"));
});

test("around midnight: hour 00 (never 24), day and year roll over", () => {
  assert.equal(at("2026-10-30T03:59:59.999Z"), "2026-10-29T23-59-59.999-0400");
  assert.equal(at("2026-10-30T04:00:00.000Z"), "2026-10-30T00-00-00.000-0400");
  assert.equal(at("2027-01-01T04:59:59.999Z"), "2026-12-31T23-59-59.999-0500");
  assert.equal(at("2027-01-01T05:00:00.000Z"), "2027-01-01T00-00-00.000-0500");
  // UTC midnight is still the previous New York day.
  assert.equal(at("2026-07-04T00:00:00.000Z"), "2026-07-03T20-00-00.000-0400");
});

test("every stamp matches the rotation pattern and names the right instant", () => {
  const start = Date.parse("2026-01-01T00:00:00.000Z");
  const end = Date.parse("2027-01-01T00:00:00.000Z");
  const check = (ms) => {
    const s = fileStamp(new Date(ms));
    const name = `hhm_rpp_ge-log.svc.${s}.json`;
    assert.match(name, ROTATE_STAMP_RE, name);
    assert.match(name, ROTATE_NAME_RE, name);
    assert.equal(stampToDate(s).getTime(), ms, name);
  };
  for (let ms = start; ms < end; ms += 7 * 60_000 + 1_234) check(ms);
  // Minute by minute through both clock-change nights.
  for (const day of ["2026-03-08", "2026-11-01"]) {
    const d0 = Date.parse(`${day}T04:00:00Z`);
    for (let ms = d0; ms < d0 + 5 * 3_600_000; ms += 60_000) check(ms);
  }
});

test("name collision: same millisecond takes the next free millisecond, no suffix", () => {
  const dir = tmpDir();
  const t = new Date("2026-11-01T05:30:00.000Z");
  const a = openRunLogFile(dir, "app-log.svc", t);
  const b = openRunLogFile(dir, "app-log.svc", t);
  const c = openRunLogFile(dir, "app-log.svc", t);
  [a, b, c].forEach(({ fd }) => fs.closeSync(fd));
  assert.equal(a.path, `${dir}/app-log.svc.2026-11-01T01-30-00.000-0400.json`);
  assert.equal(b.path, `${dir}/app-log.svc.2026-11-01T01-30-00.001-0400.json`);
  assert.equal(c.path, `${dir}/app-log.svc.2026-11-01T01-30-00.002-0400.json`);
  for (const { path } of [a, b, c]) assert.match(path, ROTATE_STAMP_RE);
  // The pre-existing file is never opened for writing again.
  fs.writeFileSync(a.path, "keep");
  const d = openRunLogFile(dir, "app-log.svc", t);
  fs.closeSync(d.fd);
  assert.equal(fs.readFileSync(a.path, "utf8"), "keep");
  assert.equal(d.path, `${dir}/app-log.svc.2026-11-01T01-30-00.003-0400.json`);
});

test("non-EEXIST open errors are not retried", () => {
  assert.throws(
    () => openRunLogFile("/nonexistent-dir-for-logtest", "app-log.svc", new Date()),
    { code: "ENOENT" }
  );
});

// --- makeAppRunLog / writeLogEvents / dbInsertLogEvents, in a scratch cwd ---
const inScratchCwd = async (fn) => {
  const cwd = process.cwd();
  const dir = tmpDir();
  process.chdir(dir);
  const keys = ["APP_NAME", "USER_ID", "LOGGER_MODE"];
  const saved = keys.map((k) => process.env[k]);
  process.env.APP_NAME = "fleet_test";
  process.env.USER_ID = "tester";
  process.env.LOGGER_MODE = "log";
  try {
    return await fn(dir);
  } finally {
    process.chdir(cwd);
    keys.forEach((k, i) =>
      saved[i] === undefined ? delete process.env[k] : (process.env[k] = saved[i])
    );
  }
};

test("run: file is named by stamp, run_id stays a UUID in events, dt stays UTC", async () => {
  await inScratchCwd(async (dir) => {
    const before = Date.now();
    const run_log = await makeAppRunLog();
    assert.match(run_log.run_id, UUID_RE);
    await addLogEvent("INFO", run_log, "t", "DETAILS", { a: 1 }, null);
    await addLogEvent("ERROR", run_log, "t", "CATCH", null, null); // null err must not throw
    assert.equal(await writeLogEvents(run_log), true);

    const files = fs.readdirSync(`${dir}/utils/logger/logs`);
    assert.equal(files.length, 1);
    const [name] = files;
    assert.match(name, /^fleet_test-log\.tester\./);
    assert.match(name, ROTATE_STAMP_RE);
    assert.ok(!name.includes(run_log.run_id), "run_id must not be in the name");
    const started = stampToDate(name.slice("fleet_test-log.tester.".length, -5)).getTime();
    assert.ok(started >= before && started <= Date.now(), "stamp is the run start");

    const events = JSON.parse(fs.readFileSync(`${dir}/utils/logger/logs/${name}`, "utf8"));
    assert.equal(events.length, 2);
    for (const e of events) {
      assert.equal(e.run_id, run_log.run_id);
      assert.match(e.dt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    }
    assert.equal(events[1].err_msg, "Unknown error");
  });
});

test("run: an unusable log dir fails the file sink (false), never throws", async () => {
  await inScratchCwd(async (dir) => {
    fs.writeFileSync(`${dir}/utils`, "not a directory");
    const run_log = await makeAppRunLog();
    await addLogEvent("INFO", run_log, "t", "DETAILS", null, null);
    assert.equal(await writeLogEvents(run_log), false);
  });
});

test("run: express-http writes no file and reports success", async () => {
  await inScratchCwd(async (dir) => {
    process.env.APP_NAME = "express-http";
    const run_log = await makeAppRunLog();
    assert.equal(await writeLogEvents(run_log), true);
    assert.ok(!fs.existsSync(`${dir}/utils`));
  });
});

test("db: inserts via util.app_run_logs, or util.self_log when the app defines it", async () => {
  const used = [];
  const pgp = { helpers: { insert: (rows, cs) => (used.push(cs), "INSERT") } };
  const run_log = { run_id: "x", log_events: [] };
  assert.equal(await dbInsertLogEvents(pgp, run_log), true);
  column_sets.util.self_log = "CS:self_log";
  try {
    assert.equal(await dbInsertLogEvents(pgp, run_log), true);
  } finally {
    delete column_sets.util.self_log;
  }
  assert.deepEqual(used, ["CS:app_run_logs", "CS:self_log"]);
});
