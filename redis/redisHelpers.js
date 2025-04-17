const execReadFileSize = require("../read/exec-readFileSize"); // exec-readFileSize
const initRedis = require("./index");
const [addLogEvent] = require("../utils/logger/log");
const {
  type: { I, W, E },
  tag: { cal, det, cat, seq, qaf }
} = require("../utils/logger/enums");

async function updateRedisFileSize(sme, exec_path, file_path, file, run_log) {
  let note = { sme, exec_path, file_path, file };
  const redisClient = await initRedis();
  try {
    const newFileSize = await execReadFileSize(
      exec_path,
      `${file_path}/${file}`
    );
    const setKey = `${sme}.${file}`;

    const setValue = newFileSize.trim();
    await redisClient.set(setKey, setValue);
    await redisClient.quit();
    return;
  } catch (error) {
    await redisClient.quit();
    await addLogEvent(E, run_log, "execReadFileSize", cat, note, error);
  }
}

async function getRedisFileSize(sme, file, run_log) {
  try {
    const redisClient = await initRedis();

    const getKey = `${sme}.${file}`;

    let fileSize = await redisClient.get(getKey);

    if (fileSize === "") return null;
    // if key does not exitst in redis, null will be returned, otherwise a string will be returned.
    if (typeof fileSize === "string") fileSize = parseInt(fileSize);
    redisClient.quit();
    return fileSize;
  } catch (error) {
    await addLogEvent(E, run_log, "getRedisFileSize", cat, note, error);
    redisClient.quit();
  }
}

async function getCurrentFileSize(sme, exec_path, file_path, file, run_log) {
  let note = { sme, exec_path, file_path, file };
  const redisClient = await initRedis();
  try {
    let currentFileSize = await execReadFileSize(
      exec_path,
      `${file_path}/${file}`
    );
    redisClient.quit();

    // If file does not exist in dir, stdout returns new line character '\n'. Set size to null
    if (currentFileSize === "\n") {
      currentFileSize = null;
      return currentFileSize;
    }

    currentFileSize = parseInt(currentFileSize);
    return currentFileSize;
  } catch (error) {
    console.log(error);
    await addLogEvent(E, run_log, "getCurrentFileSize", cat, note, error);
    await redisClient.quit();
  }
}

async function passForProcessing(sme, array, run_log) {
  let note = { sme, array };
  try {
    const redisClient = await initRedis();

    const key = "dp:queue";
    for await (let datum of array) {
      await redisClient.sendCommand(["LPUSH", key, JSON.stringify(datum)]);
    }

    redisClient.quit();
  } catch (error) {
    await addLogEvent(E, run_log, "passForProcessing", cat, note, error);
    redisClient.quit();
  }
}

async function getRedisLine(sme, file, run_log) {
  let note = { sme, file };
  const redisClient = await initRedis();
  try {
    const key = `${sme}.${file}`;
    let line = await redisClient.get(key);
    await redisClient.quit();
    if (line === null) {
      note.message = "No line returned from Redis";
      await addLogEvent(W, run_log, "getRedisLine", det, note, null);
    }
    return line;
  } catch (error) {
    await addLogEvent(E, run_log, "getRedisLine", cat, note, error);
    await redisClient.quit();
  }
}

async function updateRedisLine(sme, file, first_line, run_log) {
  let note = { sme, file, first_line };
  const redisClient = await initRedis();
  try {
    const setKey = `${sme}.${file}`;
    await redisClient.set(setKey, first_line);
    await redisClient.quit();
    return;
  } catch (error) {
    await addLogEvent(E, run_log, "updateRedisLine", cat, note, error);
    await redisClient.quit();
  }
}

async function getRedisLinePositions(sme, file, run_log) {
  let note = { sme, file };
  const redisClient = await initRedis();
  try {
    const key = `${sme}.${file}`;
    let line = await redisClient.get(key);
    await redisClient.quit();
    if (line === null) {
      note.message = "No line returned from Redis";
      await addLogEvent(W, run_log, "getRedisLinePositions", det, note, null);
      return {
        eal: null,
        events: null
      };
    }

    line = JSON.parse(line);
    return line;
  } catch (error) {
    await addLogEvent(E, run_log, "getRedisLinePositions", cat, note, error);
    await redisClient.quit();
  }
}

async function updateRedisLinePositions(sme, file, eal, events) {
  let note = {
    sme,
    file,
    eal,
    events
  };
  const redisClient = await initRedis();
  try {
    let testData = {
      eal,
      events
    };

    testData = JSON.stringify(testData);

    const setKey = `${sme}.${file}`;
    await redisClient.set(setKey, testData);
    await redisClient.quit();
    return;
  } catch (error) {
    await addLogEvent(E, run_log, "updateRedisLinePositions", cat, note, error);
    await redisClient.quit();
  }
}

/* 
async function push_file_dt_queue(run_log, system) {
  const redisClient = await initRedis();
  try {
    await redisClient.sendCommand([
      "RPUSH",
      "file_dt:queue",
      JSON.stringify(system)
    ]);
    await redisClient.quit();
  } catch (error) {
    await addLogEvent(E, run_log, "push_file_dt_queue", cat, { system }, error);
  }
}
  */

async function get_file_dt_queue(run_log) {
  await addLogEvent(I, run_log, "get_file_dt_queue", cal, null, null);
  const redisClient = await initRedis();
  try {
    const queue_data = await redisClient.sendCommand([
      "lrange",
      "file_dt:queue",
      "0",
      "1000"
    ]);
    await redisClient.quit();
    const data = [];
    for (const system of queue_data) data.push(JSON.parse(system));
    return data;
  } catch (error) {
    await redisClient.quit();
    await addLogEvent(E, run_log, "get_file_dt_queue", cat, null, error);
  }
}

async function clear_file_dt_queue(run_log) {
  await addLogEvent(I, run_log, "clear_file_dt_queue", cal, null, null);
  const redisClient = await initRedis();
  try {
    await redisClient.sendCommand(["del", "file_dt:queue"]);
    await redisClient.quit();
  } catch (error) {
    await redisClient.quit();
    await addLogEvent(E, run_log, "clear_file_dt_queue", cat, null, error);
  }
}

module.exports = {
  updateRedisFileSize,
  getCurrentFileSize,
  getRedisFileSize,
  passForProcessing,
  updateRedisLine,
  getRedisLine,
  updateRedisLinePositions,
  getRedisLinePositions,
  get_file_dt_queue,
  clear_file_dt_queue
};
