const db = require("../utils/db/pg-pool");
const zlib = require("zlib");
const fs = require("fs");
const { promisify } = require("util");

const [addLogEvent] = require("../utils/logger/log");
const {
  type: { I, W, E },
  tag: { cal, cat }
} = require("../utils/logger/enums");

const gzip_n_save = async (
  job_id,
  run_log,
  system_id,
  file_name,
  capture_datetime,
  path
) => {
  try {
    const file_present = fs.existsSync(path);
    if (!file_present) {
      await addLogEvent(
        W,
        run_log,
        "gzip_n_save",
        cal,
        { job_id, message: "File Not Present", file_path: path },
        null
      );
      return;
    }
    const file_content = fs.readFileSync(path);

    const buffer = await compress_file(file_content);

    await insert_buffer(system_id, file_name, buffer, capture_datetime);
  } catch (error) {
    await addLogEvent(
      E,
      run_log,
      "gzip_n_save",
      cat,
      { job_id, file_path: path },
      error
    );
    console.log(error);
  }
};

const compress_file = async (file_content) => {
  const gzipAsync = promisify(zlib.gzip);
  try {
    const buffer = await gzipAsync(file_content);

    return buffer;
  } catch (error) {
    console.log(error);
  }
};

const insert_buffer = async (
  system_id,
  file_name,
  buffer,
  capture_datetime
) => {
  try {
    let query =
      "INSERT INTO log.saved_files (system_id, file_name, buffer, capture_datetime) VALUES ($1, $2, $3, $4)";
    db.none(query, [system_id, file_name, buffer, capture_datetime]);
  } catch (error) {
    console.log(error);
  }
};

module.exports = gzip_n_save;
