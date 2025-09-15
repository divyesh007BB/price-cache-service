// candleWorker.js — Aggregates ticks into OHLCV candles (Redis live, Supabase final)
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

async function saveToRedis(symbol, interval, candle) {
  const key = `candles:${symbol}:${interval}`;
  try {
    const last = await redis.lindex(key, -1);
    if (last) {
      const prev = JSON.parse(last);
      if (prev.time === candle.time) {
        // overwrite latest bucket
        await redis.lset(key, -1, JSON.stringify(candle));
        return;
      }
    }
    // push new
    await redis.rpush(key, JSON.stringify(candle));
    await redis.ltrim(key, -MAX_CANDLES, -1);
  } catch (err) {
    console.error("❌ Redis save error", key, err.message);
  }
}

function enqueueSupabase(symbol, interval, candle) {
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
      // finalize old candle → Supabase
      if (bucket) enqueueSupabase(tick.symbol, interval, bucket);

      // start new
      bucket = {
        time: bucketTime,
        open: tick.price,
        high: tick.price,
        low: tick.price,
        close: tick.price,
        volume: tick.size || 1,
      };
      liveBuckets[key] = bucket;
    } else {
      bucket.high = Math.max(bucket.high, tick.price);
      bucket.low = Math.min(bucket.low, tick.price);
      bucket.close = tick.price;
      bucket.volume += tick.size || 1;
    }

    // always keep Redis live
    saveToRedis(tick.symbol, interval, bucket);
  }
}

// ✅ Restore last open candle on restart (Redis → memory)
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

// ===== Supabase batch writer =====
async function flushSupabase() {
  if (supabaseQueue.length === 0) return;
  const batch = [...supabaseQueue];
  supabaseQueue = [];

  try {
    const { error } = await supabase
      .from("candles")
      .upsert(batch, { onConflict: "symbol,interval,time" });

    if (error) {
      console.error("❌ Supabase batch error:", error.message);
      supabaseQueue.push(...batch); // retry later
    } else {
      console.log(`📤 Flushed ${batch.length} candles to Supabase`);
    }
  } catch (err) {
    console.error("❌ Supabase save error:", err.message);
    supabaseQueue.push(...batch);
  }
}
setInterval(flushSupabase, 15_000);

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
  console.log("⚠️ Shutting down, flushing supabase...");
  flushSupabase().then(() => {
    redis.quit();
    redisSub.quit();
    process.exit(0);
  });
}
process.on("SIGINT", gracefulShutdown);
process.on("SIGTERM", gracefulShutdown);

// Start preload
preloadLastCandles();
