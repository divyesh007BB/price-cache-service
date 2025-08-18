// publisher.js — Binance Feed → Redis Pub/Sub (Production Ready, Verbose Toggle)

require("dotenv").config();
const WebSocket = require("ws");
const Redis = require("ioredis");
const fetch = require("node-fetch");
const dayjs = require("dayjs");

// ===== CONFIG =====
const redisUrl = process.env.REDIS_URL;
const BINANCE_PAIRS = ["BTCUSDT", "ETHUSDT", "XAUUSDT"];
const PUB_CHANNEL = "price_ticks";

// ✅ Verbose logging toggle (default false in prod)
const VERBOSE_LOGS = process.env.VERBOSE_LOGS === "true";

// ===== Redis (Publisher) =====
const redis = new Redis(redisUrl, {
  maxRetriesPerRequest: null,
  enableReadyCheck: true,
  retryStrategy: (times) => Math.min(times * 200, 2000),
});

function logEvent(type, msg, extra) {
  console.log(`[${dayjs().format("YYYY-MM-DD HH:mm:ss")}] [${type}] ${msg}`, extra || "");
}

// ===== Symbol Mapping =====
function aliasSymbol(pair) {
  if (pair === "BTCUSDT") return "BTCUSD";
  if (pair === "ETHUSDT") return "ETHUSD";
  if (pair === "XAUUSDT") return "XAUUSD";
  return pair;
}

// ===== Publish to Redis (with throttled logging if not verbose) =====
const lastLogTs = {};
function publishTick(symbol, price, ts) {
  const msg = { symbol, price, ts };
  redis.publish(PUB_CHANNEL, JSON.stringify(msg));

  if (VERBOSE_LOGS) {
    logEvent("PUB", `Published ${symbol} ${price}`);
  } else {
    const now = Date.now();
    if (!lastLogTs[symbol] || now - lastLogTs[symbol] > 1000) {
      logEvent("PUB", `Published ${symbol} ${price}`);
      lastLogTs[symbol] = now;
    }
  }
}

// ===== Bootstrap Price =====
async function bootstrapPrice(pair) {
  try {
    const res = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${pair}`);
    const data = await res.json();
    if (data?.price) {
      const price = parseFloat(data.price);
      const ts = Date.now();
      publishTick(aliasSymbol(pair), price, ts);
      logEvent("BOOT", `Fetched bootstrap ${pair} = ${price}`);
    } else {
      logEvent("WARN", `Bootstrap fetch returned no price for ${pair}`);
    }
  } catch (err) {
    logEvent("ERR", `Bootstrap fetch failed for ${pair}`, err.message);
  }
}

// ===== Binance Feed =====
function startBinanceFeed(pair, attempt = 1) {
  const wsUrl = `wss://stream.binance.com:9443/ws/${pair.toLowerCase()}@trade`;
  const ws = new WebSocket(wsUrl);

  ws.on("open", () => {
    logEvent("INFO", `Connected to Binance ${pair}`);
    attempt = 1;
  });

  ws.on("message", (msg) => {
    try {
      const data = JSON.parse(msg);
      if (data?.p) {
        publishTick(aliasSymbol(pair), parseFloat(data.p), Date.now());
      }
    } catch (err) {
      logEvent("ERR", `${pair} parse error`, err.message);
    }
  });

  ws.on("close", () => {
    logEvent("WARN", `${pair} feed closed — reconnecting...`);
    setTimeout(() => startBinanceFeed(pair, attempt + 1), Math.min(30000, 2000 * attempt));
  });

  ws.on("error", (err) => logEvent("ERR", `${pair} feed error`, err.message));
}

// ===== Start All Feeds =====
async function startFeeds() {
  for (const pair of BINANCE_PAIRS) {
    await bootstrapPrice(pair);
    startBinanceFeed(pair);
  }
  logEvent("START", `Publisher started for ${BINANCE_PAIRS.join(", ")}`);
}

// ===== Graceful Shutdown =====
process.on("SIGINT", async () => {
  logEvent("STOP", "Shutting down Publisher...");
  await redis.quit();
  process.exit(0);
});

startFeeds();
