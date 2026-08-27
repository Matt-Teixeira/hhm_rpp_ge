// db/pg-pool.js
"use strict";

const fs = require("fs");
const path = require("path");
const pgp = require("pg-promise")();

function buildSsl() {
  const mode = (process.env.PG_SSLMODE || "disable").toLowerCase();

  if (mode === "disable") return false; // local Docker

  if (mode === "require") {
    // Encrypted, no CA verification (easy path if system trust is fine)
    return { rejectUnauthorized: false };
  }

  // verify-ca / verify-full
  const caPath = process.env.PG_SSL_PATH;
  if (caPath) {
    const resolved = path.isAbsolute(caPath) ? caPath : path.resolve(process.cwd(), caPath);
    if (fs.existsSync(resolved)) {
      return { ca: fs.readFileSync(resolved, "utf8"), rejectUnauthorized: true };
    } else {
      console.warn(`[pg] PG_SSL_PATH not found at ${resolved}; falling back to 'require'.`);
      return { rejectUnauthorized: false };
    }
  } else {
    console.warn("[pg] PG_SSLMODE=verify-* but PG_SSL_PATH not set; falling back to 'require'.");
    return { rejectUnauthorized: false };
  }
}

// First process.env are mapped to docker instance params
const config = {
  host: process.env.PGHOST || process.env.PG_HOST,      // Docker service name or Azure host
  port: Number(process.env.PGPORT || process.env.PG_PORT),
  database: process.env.PGDATABASE || process.env.PG_DB,
  user: process.env.PGUSER || process.env.PG_USER,
  password: process.env.PGPASSWORD || process.env.PG_PW,
  ssl: buildSsl(),
  // Fleet pool standard (decided 2026-08-27): a hung connect must ERROR by
  // 10s -- with no timeout, an unreachable DB hangs the run forever and the
  // empty cron .out reads as "never ran". Idle sockets close after 60s;
  // at most 15 connections per process.
  max: 15,
  idleTimeoutMillis: 60000,
  connectionTimeoutMillis: 10000,
  application_name: process.env.APP_NAME || "default_app_name",
};

module.exports = pgp(config);
