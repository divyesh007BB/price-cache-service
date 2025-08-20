module.exports = {
  apps: [
    {
      name: "price-server",
      script: "backend/price-server/index.js",
      env: require("dotenv").config({ path: "/root/price-cache-service/.env" }).parsed,
    },
    {
      name: "matching-engine",
      script: "backend/matching-engine/matchingEngine.js",
      env: require("dotenv").config({ path: "/root/price-cache-service/.env" }).parsed,
    },
    {
      name: "risk-engine",
      script: "backend/price-server/riskEngine.js",
      env: require("dotenv").config({ path: "/root/price-cache-service/.env" }).parsed,
    },
    {
      name: "publisher",
      script: "backend/price-server/publisher.js",
      env: require("dotenv").config({ path: "/root/price-cache-service/.env" }).parsed,
    },
    {
      name: "candle-worker", // ✅ new worker
      script: "backend/price-server/candleWorker.js",
      env: require("dotenv").config({ path: "/root/price-cache-service/.env" }).parsed,
    },
  ],
};
