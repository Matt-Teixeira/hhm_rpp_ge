const util = require("util");
const execFile = util.promisify(require("node:child_process").execFile);

async function execReadFileSize(exec_path, file_path) {
  const execOptions = {
    maxBuffer: 1024 * 1024 * 500,
  };

  try {
    const { stdout: newData } = await execFile(
      exec_path,
      [file_path],
      execOptions
    );
    return newData;
  } catch (error) {
    
    return null;
  }
}

module.exports = execReadFileSize;
