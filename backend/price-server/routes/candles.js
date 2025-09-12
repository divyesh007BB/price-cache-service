// routes/candles.js — Hybrid (Redis + Supabase persistence, OHLCV)
const express = require("express");
const Redis = require("ioredis");
const { createClient } = require("@supabase/supabase-js");

const router = express.Router();

const redisUrl = process.env.REDIS_URL || "redis://127.0.0.1:6379";
const redis = new Redis(redisUrl, { maxRetriesPerRequest: null });

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

/**
 * GET /candles
 * Example: /candles?symbol=BTCUSD&interval=1m&limit=200
 */
router.get("/", async (req, res) => {
  try {
    const { symbol, interval = "1m", limit = 200 } = req.query;

    if (!symbol) {
      return res.status(400).json({ error: "Missing symbol parameter" });
    }

    const count = Math.min(parseInt(limit, 10) || 200, 1000); // hard cap 1000
    const key = `candles:${symbol}:${interval}`;

    // 1. Try Redis first
    let data = await redis.lrange(key, -count, -1);
    let candles = data.map((c) => JSON.parse(c));

    // 2. Fallback to Supabase if Redis empty or not enough
    if (candles.length < count) {
      const { data: rows, error } = await supabase
        .from("candles")
        .select("time, open, high, low, close, volume")
        .eq("symbol", symbol)
        .eq("interval", interval)
        .order("time", { ascending: false })
        .limit(count);

      if (error) {
        console.error("❌ Supabase fetch error:", error.message);
      } else if (rows?.length) {
        candles = rows.reverse(); // ascending order
      }
    }

    res.json(candles);
  } catch (err) {
    console.error("❌ /candles error:", err.message);
    res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;
