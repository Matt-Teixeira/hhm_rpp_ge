const util = require("util");
const execFile = util.promisify(require("node:child_process").execFile);

async function execTail(exec_path, delta, file_path) {
  const execOptions = {
    maxBuffer: 1024 * 1024 * 500,
  };

  try {
    const { stdout: newData } = await execFile(exec_path, [delta, file_path], execOptions);
    return newData;
  } catch (error) {
    
    return null;
  }
}

module.exports = execTail;
