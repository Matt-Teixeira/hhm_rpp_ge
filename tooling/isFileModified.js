const fs = require("node:fs").promises;
const [addLogEvent] = require("../utils/logger/log");
const {
  type: { I, W, E },
  tag: { cal, det, cat }
} = require("../utils/logger/enums");

async function isFileModified(run_log, sme, complete_file_path, fileToParse) {
  let note = {
    sme,
    complete_file_path,
    fileToParse
  };
  try {
    let date_time = await fs.stat(complete_file_path);

    let fileModTime = date_time.mtime.toISOString();

    if (fileModTime === fileToParse.last_mod) {
      await addLogEvent(I, run_log, "isFileModified", det, note, null);
      return false;
    } else return true;
  } catch (error) {
    await addLogEvent(E, run_log, "isFileModified", cat, note, error);
  }
}

async function getLastModifiedTime(filePath) {
  try {
    const stats = await fs.stat(filePath);
    return stats.mtime; // mtime is the last modified time
  } catch (err) {
    console.error("Error reading the file:", err);
    throw err;
  }
}

module.exports = { isFileModified, getLastModifiedTime };
