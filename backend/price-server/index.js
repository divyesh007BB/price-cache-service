// index.js — Production Price Server (Subscriber, Auth, Redis, Risk Forward)

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
const { normalizeSymbol } = require("../shared/symbolMap");
const { WHITELIST, addTick, getTicks } = require("../shared/state");
const { processTick } = require("../matching-engine/matchingEngine");
const placeOrderRoute = require("./placeOrder");

// ===== CONFIG =====
const PORT = process.env.PORT || 4000;
const redisUrl = process.env.REDIS_URL;
const FEED_API_KEY = process.env.FEED_API_KEY || "supersecret"; // 🔑 auth

console.log("🔑 REDIS_URL =", redisUrl);
console.log("🔑 SUPABASE_URL =", process.env.SUPABASE_URL);
console.log("🔑 FINNHUB_API_KEY =", process.env.FINNHUB_API_KEY ? "[SET]" : "[MISSING]");
console.log("🔑 FEED_API_KEY =", FEED_API_KEY);

// ✅ Redis (resilient client)
const redis = new Redis(redisUrl, {
  maxRetriesPerRequest: null,
  enableReadyCheck: true,
  reconnectOnError: (err) => {
    console.error("[ioredis] reconnectOnError:", err.message);
    return true;
  },
  retryStrategy: (times) => Math.min(times * 200, 2000),
});

// ===== Logging =====
function logEvent(type, msg, extra) {
  console.log(`[${dayjs().format("YYYY-MM-DD HH:mm:ss")}] [${type}] ${msg}`, extra || "");
}

// ===== Price Storage =====
const TICK_HISTORY_LIMIT = 1000;
const MAX_BROADCAST_TPS = 20;
const TPS_BUCKET = { count: 0, ts: Date.now() };
const priceBuffer = {};
const lastHistoryPush = {};
const FLUSH_INTERVAL_MS = 200;
const HISTORY_INTERVAL_MS = 1000;

function bufferPrice(symbol, price, ts) {
  priceBuffer[symbol] = JSON.stringify({ price, ts });
}

async function flushPrices() {
  if (Object.keys(priceBuffer).length > 0) {
    try {
      await redis.hmset("latest_prices", priceBuffer);
      for (const k of Object.keys(priceBuffer)) delete priceBuffer[k];
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

// ===== Redis Subscriber =====
const redisSub = new Redis(redisUrl);
redisSub.subscribe("price_ticks", (err) => {
  if (err) console.error("❌ Failed to subscribe:", err);
  else logEvent("START", "Subscribed to Redis channel: price_ticks");
});

redisSub.on("message", (channel, message) => {
  try {
    const tick = JSON.parse(message);
    bufferPrice(tick.symbol, tick.price, tick.ts);
    addTick(tick.symbol, tick.price, tick.ts);
    saveTickHistoryThrottled(tick.symbol, tick.price, tick.ts);
    throttledBroadcast({ type: "price", ...tick });
    processTick(tick.symbol, tick.price, tick.ts);
  } catch (err) {
    logEvent("ERR", "Redis tick parse failed", err.message);
  }
});

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

function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const client of wss.clients) {
    if (client.readyState !== WebSocket.OPEN) continue;
    if (!client.subscriptions || client.subscriptions.size === 0 || client.subscriptions.has(msg.symbol)) {
      client.send(data);
    }
  }
}

// ===== Express + WS =====
const app = express();
app.use(cors());
app.use(express.json());
app.use("/place-order", placeOrderRoute);

app.get("/prices", async (req, res) => {
  try {
    const symbols = Array.from(WHITELIST);
    const prices = {};
    for (const sym of symbols) {
      let val = await getPrice(sym);
      if (!val) {
        const ticks = getTicks(sym);
        if (ticks.length) {
          const last = ticks[ticks.length - 1];
          val = { price: last.price, ts: last.ts };
        }
      }
      prices[sym] = val;
    }
    res.json({ success: true, prices });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

const wss = new WebSocket.Server({ noServer: true });
function heartbeat() { this.isAlive = true; }

// ===== Startup =====
const server = app.listen(PORT, "0.0.0.0", () => {
  logEvent("START", `Price Server running on port ${PORT} (subscriber mode)`);
});

// ===== WS Auth + Upgrade =====
server.on("upgrade", (req, socket, head) => {
  const protocolKey = req.headers["sec-websocket-protocol"];
  const queryKey = url.parse(req.url, true).query.key;
  const token = protocolKey || queryKey;

  if (token !== FEED_API_KEY) {
    logEvent("AUTH", "Rejected WS connection (bad key)");
    socket.destroy();
    return;
  }
  if (url.parse(req.url).pathname === "/ws") {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  } else socket.destroy();
});

// ===== Handle WS connections =====
wss.on("connection", async (ws) => {
  ws.isAlive = true;
  ws.subscriptions = new Set();
  ws.on("pong", heartbeat);
  logEvent("WS", "Client connected");

  ws.send(JSON.stringify({ type: "welcome", symbols: Array.from(WHITELIST) }));

  ws.on("message", (msg) => {
    try {
      const data = JSON.parse(msg.toString());
      if (data.type === "subscribe" && data.symbol) {
        const sym = normalizeSymbol(data.symbol);
        ws.subscriptions.add(sym);
        ws.send(JSON.stringify({ type: "subscribed", symbol: sym }));
      }
      if (data.type === "unsubscribe" && data.symbol) {
        const sym = normalizeSymbol(data.symbol);
        ws.subscriptions.delete(sym);
        ws.send(JSON.stringify({ type: "unsubscribed", symbol: sym }));
      }
    } catch (err) {
      logEvent("ERR", "Invalid WS message", err.message);
    }
  });

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
