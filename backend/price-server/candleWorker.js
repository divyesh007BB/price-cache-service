// candleWorker.js — Aggregates ticks into OHLC candles in Redis
require("dotenv").config();
const Redis = require("ioredis");

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

const liveBuckets = {}; // { key: {time, open, high, low, close} }

function getBucketTime(tsSec, interval) {
  const bucketSecs = INTERVALS[interval];
  return Math.floor(tsSec / bucketSecs) * bucketSecs;
}

async function saveCandle(symbol, interval, candle) {
  const key = `candles:${symbol}:${interval}`;

  // ✅ Dedup check: only save if candle changed
  const last = await redis.lindex(key, -1);
  if (last) {
    try {
      const prev = JSON.parse(last);
      if (prev.time === candle.time && prev.close === candle.close) {
        return; // skip duplicate
      }
    } catch {}
  }

  try {
    await redis.rpush(key, JSON.stringify(candle)); // append at end
    await redis.ltrim(key, -MAX_CANDLES, -1); // keep last N
  } catch (err) {
    console.error("❌ Redis save error", key, err.message);
  }
}

function processTick(tick) {
  const tsSec = Math.floor(tick.ts / 1000);

  for (const [interval] of Object.entries(INTERVALS)) {
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

// ✅ Restore last open candle on restart
async function preloadLastCandles() {
  for (const interval of Object.keys(INTERVALS)) {
    const keys = await redis.keys(`candles:*:${interval}`);
    for (const key of keys) {
      const symbol = key.split(":")[1];
      const last = await redis.lindex(key, -1);
      if (last) {
        try {
          const candle = JSON.parse(last);
          liveBuckets[`${symbol}:${interval}`] = candle;
          console.log(`🔄 Preloaded last ${interval} candle for ${symbol}`);
        } catch {}
      }
    }
  }
}

// Flush all current buckets periodically
async function flushBuckets() {
  for (const [key, bucket] of Object.entries(liveBuckets)) {
    if (!bucket) continue;
    const [symbol, interval] = key.split(":");
    await saveCandle(symbol, interval, bucket);
  }
}
setInterval(flushBuckets, 10_000);

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

// ✅ Graceful shutdown
function gracefulShutdown() {
  console.log("⚠️ Shutting down, flushing candles...");
  flushBuckets().then(() => {
    redis.quit();
    redisSub.quit();
    process.exit(0);
  });
}
process.on("SIGINT", gracefulShutdown);
process.on("SIGTERM", gracefulShutdown);

// Start preload
preloadLastCandles();
