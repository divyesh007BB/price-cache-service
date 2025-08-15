// index.js — Production Prop Firm Price Server (Connected to Matching Engine)

require("dotenv").config();
const express = require("express");
const WebSocket = require("ws");
const cors = require("cors");
const url = require("url");
const Redis = require("ioredis");
const dayjs = require("dayjs");
const utc = require("dayjs/plugin/utc");
const timezone = require("dayjs/plugin/timezone");
dayjs.extend(utc);
dayjs.extend(timezone);

// ===== Shared Imports =====
const { normalizeSymbol, getContracts, CONTRACTS } = require("../shared/symbolMap");
const { WHITELIST, addTick, getTicks } = require("../shared/state");

// ===== CONFIG =====
const PORT = process.env.PORT || 4000;
const redisUrl = process.env.REDIS_URL || process.env.UPSTASH_REDIS_REST_URL;
const redis = new Redis(
  redisUrl,
  process.env.UPSTASH_REDIS_REST_TOKEN
    ? {
        password: process.env.UPSTASH_REDIS_REST_TOKEN,
        tls: redisUrl.startsWith("rediss://") ? {} : undefined,
      }
    : {}
);

const TICK_HISTORY_LIMIT = 1000;
const MAX_BROADCAST_TPS = 20;
const TPS_BUCKET = { count: 0, ts: Date.now() };
const priceBuffer = {};
const lastHistoryPush = {};
const lastPriceSent = {};
const FLUSH_INTERVAL_MS = 200;
const HISTORY_INTERVAL_MS = 1000;

// ===== Instruments =====
WHITELIST.clear();
Object.keys(CONTRACTS).forEach((symbol) => WHITELIST.add(symbol));

// Auto-detect Binance pairs
const BINANCE_PAIRS = Object.values(CONTRACTS)
  .filter((c) => c.priceKey?.startsWith("BINANCE:"))
  .map((c) => c.priceKey.split(":")[1]);

// ===== Logging =====
function logEvent(type, msg, extra) {
  console.log(`[${dayjs().format("YYYY-MM-DD HH:mm:ss")}] [${type}] ${msg}`, extra || "");
}

// ===== Price Storage =====
function bufferPrice(symbol, price, ts) {
  priceBuffer[symbol] = JSON.stringify({ price, ts });
}

async function flushPrices() {
  if (Object.keys(priceBuffer).length > 0) {
    try {
      await redis.hmset("latest_prices", priceBuffer);
    } catch (err) {
      logEvent("ERR", "Failed to flush prices to Redis", err.message);
    }
  }
}
setInterval(flushPrices, FLUSH_INTERVAL_MS);

async function saveTickHistoryThrottled(symbol, price, ts) {
  if (!lastHistoryPush[symbol] || ts - lastHistoryPush[symbol] >= HISTORY_INTERVAL_MS) {
    try {
      const key = `ticks:${symbol}`;
      await redis.lpush(key, JSON.stringify({ ts, price }));
      await redis.ltrim(key, 0, TICK_HISTORY_LIMIT - 1);
      lastHistoryPush[symbol] = ts;
    } catch (err) {
      logEvent("ERR", `Failed to save tick for ${symbol}`, err.message);
    }
  }
}

async function getPrice(symbol) {
  try {
    const raw = await redis.hget("latest_prices", symbol);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

async function getRecentTicks(symbol, limit = 50) {
  const buf = getTicks(symbol);
  if (buf.length > 0) return buf.slice(-limit);
  try {
    const entries = await redis.lrange(`ticks:${symbol}`, 0, limit - 1);
    return entries.map((e) => JSON.parse(e)).reverse();
  } catch (err) {
    logEvent("ERR", `Failed to get recent ticks for ${symbol}`, err.message);
    return [];
  }
}

// ===== Price Publish =====
function publishPrice(symbol, price) {
  const normSymbol = normalizeSymbol(symbol);
  const ts = Date.now();

  if (lastPriceSent[normSymbol] === price) return; // skip duplicate ticks
  lastPriceSent[normSymbol] = price;

  bufferPrice(normSymbol, price, ts);
  addTick(normSymbol, price, ts);
  saveTickHistoryThrottled(normSymbol, price, ts);

  throttledBroadcast({ type: "price", symbol: normSymbol, price, ts });
  redis.publish("prices", JSON.stringify({ symbol: normSymbol, price, ts }));
}

// ===== Feeds =====
function startFeeds() {
  BINANCE_PAIRS.forEach(startBinanceFeed);
  logEvent("START", `Feeds started (${BINANCE_PAIRS.join(", ")})`);
}

function startBinanceFeed(pair, attempt = 1) {
  const wsUrl = `wss://stream.binance.com:9443/ws/${pair.toLowerCase()}@trade`;
  const symbolKey = `BINANCE:${pair}`;
  const ws = new WebSocket(wsUrl);

  ws.on("open", () => {
    logEvent("INFO", `Connected to Binance ${pair}`);
    attempt = 1;
  });

  ws.on("message", (msg) => {
    try {
      const data = JSON.parse(msg);
      if (data?.p) publishPrice(symbolKey, parseFloat(data.p));
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

// ===== WS Broadcast =====
function throttledBroadcast(msg) {
  const now = Date.now();
  if (now - TPS_BUCKET.ts > 1000) {
    TPS_BUCKET.ts = now;
    TPS_BUCKET.count = 0;
  }
  if (TPS_BUCKET.count >= MAX_BROADCAST_TPS) return;
  TPS_BUCKET.count++;
  broadcast(msg);
}

// ===== Express + WS =====
const app = express();
app.use(cors());
app.use(express.json());

const wss = new WebSocket.Server({ noServer: true });
function heartbeat() {
  this.isAlive = true;
}
function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(data);
  }
}

const server = app.listen(PORT, async () => {
  logEvent("START", `Price Server running on port ${PORT}`);
  startFeeds();
});

server.on("upgrade", async (req, socket, head) => {
  if (url.parse(req.url).pathname === "/ws") {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  } else socket.destroy();
});

wss.on("connection", async (ws) => {
  ws.isAlive = true;
  ws.on("pong", heartbeat);
  logEvent("WS", "Client connected");

  ws.send(JSON.stringify({ type: "welcome", symbols: Array.from(WHITELIST) }));

  for (const sym of WHITELIST) {
    const cached = await getPrice(sym);
    if (cached) ws.send(JSON.stringify({ type: "price", symbol: sym, ...cached }));
    const history = await getRecentTicks(sym, 50);
    if (history.length) ws.send(JSON.stringify({ type: "history", symbol: sym, ticks: history }));
  }
});

// ===== WS Keepalive =====
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 25000);

// ===== Graceful Shutdown =====
process.on("SIGINT", async () => {
  logEvent("STOP", "Shutting down Price Server...");
  await redis.quit();
  server.close(() => process.exit(0));
});

process.on("unhandledRejection", (err) => logEvent("FATAL", "UnhandledRejection", err));
process.on("uncaughtException", (err) => logEvent("FATAL", "UncaughtException", err));
