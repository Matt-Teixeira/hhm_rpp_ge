const redis = require("redis");

async function initRedis() {
  // SETUP ENV BASED RESOURCES -> REDIS CLIENT, JOB SCHEDULES
  const clienConfig = {
    socket: {
      port: process.env.REDIS_PORT,
      host: process.env.REDIS_HOST,
    },
  };

  const redisClient = redis.createClient(clienConfig);

  redisClient.on("error", async (error) => console.log(error));

  await redisClient.connect();

  return redisClient;
}

module.exports = initRedis;
