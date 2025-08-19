// publisher.js — Binance Feed → Redis Pub/Sub + Tick History + Orderbook Snapshots

require("dotenv").config();
const WebSocket = require("ws");
const Redis = require("ioredis");
const fetch = require("node-fetch");
const dayjs = require("dayjs");

// ===== CONFIG =====
const redisUrl = process.env.REDIS_URL;
const BINANCE_PAIRS = ["BTCUSDT", "ETHUSDT", "XAUUSDT"];
const PUB_CHANNEL = "price_ticks";
const TICK_HISTORY_LIMIT = 1000; // keep last 1000 ticks per symbol

// ✅ Verbose logging toggle
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

// ===== Publish Tick =====
const lastLogTs = {};
async function publishTick(symbol, price, ts) {
  const msg = { symbol, price, ts };

  // 1. Publish live tick
  await redis.publish(PUB_CHANNEL, JSON.stringify(msg));

  // 2. Push to rolling tick history
  const key = `ticks:${symbol}`;
  await redis.lpush(key, JSON.stringify(msg));
  await redis.ltrim(key, 0, TICK_HISTORY_LIMIT - 1);

  // 3. Update latest price
  await redis.hset("latest_prices", symbol, JSON.stringify(msg));

  // Logging
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

// ===== Publish Orderbook Snapshot =====
async function publishOrderbook(symbol, bids, asks, ts) {
  const snapshot = { bids, asks, ts };
  await redis.set(`orderbook:${symbol}`, JSON.stringify(snapshot));
  if (VERBOSE_LOGS) logEvent("OB", `Updated orderbook ${symbol}`);
}

// ===== Bootstrap Price =====
async function bootstrapPrice(pair) {
  try {
    const res = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${pair}`);
    const data = await res.json();
    if (data?.price) {
      const price = parseFloat(data.price);
      const ts = Date.now();
      await publishTick(aliasSymbol(pair), price, ts);
      logEvent("BOOT", `Fetched bootstrap ${pair} = ${price}`);
    } else {
      logEvent("WARN", `Bootstrap fetch returned no price for ${pair}`);
    }
  } catch (err) {
    logEvent("ERR", `Bootstrap fetch failed for ${pair}`, err.message);
  }
}

// ===== Binance Trade Feed =====
function startTradeFeed(pair, attempt = 1) {
  const wsUrl = `wss://stream.binance.com:9443/ws/${pair.toLowerCase()}@trade`;
  const ws = new WebSocket(wsUrl);

  ws.on("open", () => {
    logEvent("INFO", `Connected to Binance Trade ${pair}`);
    attempt = 1;
  });

  ws.on("message", async (msg) => {
    try {
      const data = JSON.parse(msg);
      if (data?.p) {
        await publishTick(aliasSymbol(pair), parseFloat(data.p), Date.now());
      }
    } catch (err) {
      logEvent("ERR", `${pair} trade parse error`, err.message);
    }
  });

  ws.on("close", () => {
    logEvent("WARN", `${pair} trade feed closed — reconnecting...`);
    setTimeout(() => startTradeFeed(pair, attempt + 1), Math.min(30000, 2000 * attempt));
  });

  ws.on("error", (err) => logEvent("ERR", `${pair} trade feed error`, err.message));
}

// ===== Binance Depth Feed =====
function startDepthFeed(pair, attempt = 1) {
  const wsUrl = `wss://stream.binance.com:9443/ws/${pair.toLowerCase()}@depth5@100ms`;
  const ws = new WebSocket(wsUrl);

  ws.on("open", () => {
    logEvent("INFO", `Connected to Binance Depth ${pair}`);
    attempt = 1;
  });

  ws.on("message", async (msg) => {
    try {
      const data = JSON.parse(msg);
      if (data?.bids && data?.asks) {
        const symbol = aliasSymbol(pair);
        const ts = Date.now();

        // Only keep top 5 levels
        const bids = data.bids.map(([price, qty]) => [parseFloat(price), parseFloat(qty)]);
        const asks = data.asks.map(([price, qty]) => [parseFloat(price), parseFloat(qty)]);

        await publishOrderbook(symbol, bids, asks, ts);
      }
    } catch (err) {
      logEvent("ERR", `${pair} depth parse error`, err.message);
    }
  });

  ws.on("close", () => {
    logEvent("WARN", `${pair} depth feed closed — reconnecting...`);
    setTimeout(() => startDepthFeed(pair, attempt + 1), Math.min(30000, 2000 * attempt));
  });

  ws.on("error", (err) => logEvent("ERR", `${pair} depth feed error`, err.message));
}

// ===== Start All Feeds =====
async function startFeeds() {
  for (const pair of BINANCE_PAIRS) {
    await bootstrapPrice(pair);
    startTradeFeed(pair);
    startDepthFeed(pair);
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
