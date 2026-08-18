const redis = require("redis");

async function initRedis() {
  // SETUP ENV BASED RESOURCES -> REDIS CLIENT, JOB SCHEDULES
  const clienConfig = {
    socket: {
      port: process.env.REDIS_PORT,
      host: process.env.REDIS_HOST,
    },
  };
  // Auth is opt-in: inert until REDIS_PW is set in this app's .env AND the
  // server has requirepass enabled (redis-admin rollout).
  if (process.env.REDIS_PW) clienConfig.password = process.env.REDIS_PW;

  const redisClient = redis.createClient(clienConfig);

  redisClient.on("error", async (error) => console.log(error));

  await redisClient.connect();

  return redisClient;
}

module.exports = initRedis;
