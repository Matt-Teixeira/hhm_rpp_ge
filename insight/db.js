"use strict";
// Database access for the insight pipeline. NOT utils/db/pg-pool (gitignored,
// and it connects as the admin role).
//
//   connect("writer")   -> insight_writer (INSIGHT_PG_USER / INSIGHT_PG_PW).
//                          Refuses to fall back to any other login: writes are
//                          only ever made as the limited role (§10).
//   connect("readonly") -> INSIGHT_PG_USER if set, else PG_USER, with
//                          default_transaction_read_only=on. For dry runs and
//                          reports (also usable from a dev workstation).
const fs = require("fs");
const path = require("path");

const REPO = path.resolve(__dirname, "..");
require("dotenv").config({ path: path.join(REPO, ".env") });
const pgp = require("pg-promise")({ noWarnings: true });

function connect(mode, { statementTimeoutMs = 300000, applicationName = "insight" } = {}) {
  if (!["writer", "readonly"].includes(mode)) throw new Error(`connect: unknown mode ${mode}`);
  let user, password;
  if (mode === "writer") {
    if (!process.env.INSIGHT_PG_USER || !process.env.INSIGHT_PG_PW) {
      throw new Error("INSIGHT_PG_USER / INSIGHT_PG_PW not set: writes require the insight_writer login (maintenance/create_insight_writer.js)");
    }
    user = process.env.INSIGHT_PG_USER;
    password = process.env.INSIGHT_PG_PW;
  } else {
    user = process.env.INSIGHT_PG_USER || process.env.PG_USER;
    password = process.env.INSIGHT_PG_USER ? process.env.INSIGHT_PG_PW : process.env.PG_PW;
  }
  const opts = [`-c statement_timeout=${statementTimeoutMs}`, "-c lock_timeout=5000", "-c idle_in_transaction_session_timeout=300000"];
  if (mode === "readonly") opts.push("-c default_transaction_read_only=on");
  return pgp({
    host: process.env.PG_HOST,
    port: process.env.PG_PORT || 5432,
    database: process.env.PG_DB,
    user,
    password,
    max: 2,
    application_name: `${applicationName}_${mode}`,
    ssl: { require: true, cert: fs.readFileSync(path.resolve(REPO, process.env.PG_SSL_PATH)), rejectUnauthorized: true },
    options: opts.join(" "),
  });
}

module.exports = { connect, pgp };
