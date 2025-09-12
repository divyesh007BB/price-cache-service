// candleWorker.js — Aggregates ticks into OHLCV candles (Redis + Supabase)
require("dotenv").config();
const Redis = require("ioredis");
const { createClient } = require("@supabase/supabase-js");

const redisUrl = process.env.REDIS_URL || "redis://127.0.0.1:6379";
const redis = new Redis(redisUrl, { maxRetriesPerRequest: null });
const redisSub = new Redis(redisUrl, { maxRetriesPerRequest: null });

// ===== Supabase =====
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const INTERVALS = {
  "1m": 60,
  "5m": 300,
  "15m": 900,
  "1h": 3600,
};
const MAX_CANDLES = 1000;

const liveBuckets = {};   // { key: {time, open, high, low, close, volume} }
let supabaseQueue = [];   // retry buffer

function getBucketTime(tsSec, interval) {
  const bucketSecs = INTERVALS[interval];
  return Math.floor(tsSec / bucketSecs) * bucketSecs;
}

async function saveCandle(symbol, interval, candle) {
  const key = `candles:${symbol}:${interval}`;

  // ✅ Dedup in Redis
  const last = await redis.lindex(key, -1);
  if (last) {
    try {
      const prev = JSON.parse(last);
      if (prev.time === candle.time && prev.close === candle.close) {
        return; // skip duplicate
      }
    } catch {}
  }

  // Save in Redis
  try {
    await redis.rpush(key, JSON.stringify(candle));
    await redis.ltrim(key, -MAX_CANDLES, -1);
  } catch (err) {
    console.error("❌ Redis save error", key, err.message);
  }

  // Push to Supabase batch queue
  supabaseQueue.push({
    symbol,
    interval,
    time: candle.time,
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
    volume: candle.volume || 0,
  });
}

function processTick(tick) {
  const tsSec = Math.floor(tick.ts / 1000);

  for (const [interval] of Object.entries(INTERVALS)) {
    const bucketTime = getBucketTime(tsSec, interval);
    const key = `${tick.symbol}:${interval}`;
    let bucket = liveBuckets[key];

    if (!bucket || bucket.time !== bucketTime) {
      // flush old bucket
      if (bucket) saveCandle(tick.symbol, interval, bucket);

      // start new candle
      bucket = {
        time: bucketTime,
        open: tick.price,
        high: tick.price,
        low: tick.price,
        close: tick.price,
        volume: tick.size || 1,   // count tick size if available
      };
      liveBuckets[key] = bucket;
    } else {
      bucket.high = Math.max(bucket.high, tick.price);
      bucket.low = Math.min(bucket.low, tick.price);
      bucket.close = tick.price;
      bucket.volume += tick.size || 1;
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

// ===== Flush buckets + batch Supabase =====
async function flushBuckets() {
  for (const [key, bucket] of Object.entries(liveBuckets)) {
    if (!bucket) continue;
    const [symbol, interval] = key.split(":");
    await saveCandle(symbol, interval, bucket);
  }

  if (supabaseQueue.length > 0) {
    const batch = [...supabaseQueue];
    supabaseQueue = []; // reset buffer

    try {
      const { error } = await supabase
        .from("candles")
        .upsert(batch, { onConflict: "symbol,interval,time" });

      if (error) {
        console.error("❌ Supabase batch error:", error.message);
        supabaseQueue.push(...batch); // retry next flush
      } else {
        console.log(`📤 Flushed ${batch.length} candles to Supabase`);
      }
    } catch (err) {
      console.error("❌ Supabase save error:", err.message);
      supabaseQueue.push(...batch);
    }
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
