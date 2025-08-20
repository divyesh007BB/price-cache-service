// candleWorker.js — Aggregates ticks into OHLC candles in Redis
require("dotenv").config();
const Redis = require("ioredis");
const dayjs = require("dayjs");

const redisUrl = process.env.REDIS_URL || "redis://127.0.0.1:6379";
const redis = new Redis(redisUrl, { maxRetriesPerRequest: null });
const redisSub = new Redis(redisUrl, { maxRetriesPerRequest: null });

const INTERVALS = {
  "1m": 60,
  "5m": 300,
  "15m": 900,
  "1h": 3600,
};
const MAX_CANDLES = 1000;

// Keep in-memory candles before flush
const liveBuckets = {}; // { key: {time, open, high, low, close} }

function getBucketTime(tsSec, interval) {
  const bucketSecs = INTERVALS[interval];
  return Math.floor(tsSec / bucketSecs) * bucketSecs;
}

async function saveCandle(symbol, interval, candle) {
  const key = `candles:${symbol}:${interval}`;
  try {
    await redis.lpush(key, JSON.stringify(candle));
    await redis.ltrim(key, 0, MAX_CANDLES - 1);
  } catch (err) {
    console.error("❌ Redis save error", key, err.message);
  }
}

function processTick(tick) {
  const tsSec = Math.floor(tick.ts / 1000);

  for (const [interval, bucketSecs] of Object.entries(INTERVALS)) {
    const bucketTime = getBucketTime(tsSec, interval);
    const key = `${tick.symbol}:${interval}`;
    let bucket = liveBuckets[key];

    if (!bucket || bucket.time !== bucketTime) {
      // flush old bucket if exists
      if (bucket) saveCandle(tick.symbol, interval, bucket);

      // start new candle
      bucket = {
        time: bucketTime,
        open: tick.price,
        high: tick.price,
        low: tick.price,
        close: tick.price,
      };
      liveBuckets[key] = bucket;
    } else {
      bucket.high = Math.max(bucket.high, tick.price);
      bucket.low = Math.min(bucket.low, tick.price);
      bucket.close = tick.price;
    }
  }
}

// Flush any open candles periodically
async function flushBuckets() {
  for (const [key, bucket] of Object.entries(liveBuckets)) {
    if (!bucket) continue;
    const [symbol, interval] = key.split(":");
    await saveCandle(symbol, interval, bucket);
  }
}
setInterval(flushBuckets, 10_000); // every 10s

// ===== Subscribe to ticks =====
redisSub.subscribe("price_ticks", (err) => {
  if (err) {
    console.error("❌ Failed to subscribe price_ticks", err.message);
    process.exit(1);
  }
  console.log("📡 Subscribed to price_ticks for candle aggregation");
});

redisSub.on("message", (channel, msg) => {
  try {
    const tick = JSON.parse(msg);
    processTick(tick);
  } catch (e) {
    console.error("❌ Tick parse error", e.message, msg);
  }
});
