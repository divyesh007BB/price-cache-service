// index.js — Production Price Server (Topstep-level hardened, Redis-driven)

require("dotenv").config();
const express = require("express");
const WebSocket = require("ws");
const cors = require("cors");
const url = require("url");
const Redis = require("ioredis");
const rateLimit = require("express-rate-limit");
const dayjs = require("dayjs");
const utc = require("dayjs/plugin/utc");
const timezone = require("dayjs/plugin/timezone");
const client = require("prom-client");
const { createClient } = require("@supabase/supabase-js");

dayjs.extend(utc);
dayjs.extend(timezone);

// ===== Shared Imports =====
const { normalizeSymbol, CONTRACTS } = require("../shared/symbolMap");
const { WHITELIST, setWhitelist } = require("../shared/state");
const { setBroadcaster } = require("../matching-engine/matchingEngine");
const { startDailyReset } = require("./dailyReset");   // ✅ new import
const placeOrderRoute = require("./placeOrder");

// ===== CONFIG =====
const PORT = process.env.PORT || 4000;
const redisUrl = process.env.REDIS_URL;
const FEED_API_KEY = process.env.FEED_API_KEY || "supersecret";

console.log("🔑 REDIS_URL =", redisUrl);
console.log("🔑 FEED_API_KEY =", FEED_API_KEY);

// ===== Redis =====
const redis = new Redis(redisUrl, { maxRetriesPerRequest: null });
const redisSub = new Redis(redisUrl, { maxRetriesPerRequest: null });

// ===== Supabase =====
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ===== Prometheus =====
client.collectDefaultMetrics();

const ticksPublished = new client.Counter({
  name: "price_ticks_published_total",
  help: "Total number of ticks published",
  labelNames: ["symbol"],
});

const wsConnections = new client.Gauge({
  name: "ws_connections",
  help: "Active WebSocket clients",
});

const feedHealth = new client.Gauge({
  name: "feed_health",
  help: "Feed health (0=down,1=up)",
  labelNames: ["symbol", "exchange"],
});

// ===== Logging =====
function logEvent(type, msg, extra) {
  console.log(`[${dayjs().format("YYYY-MM-DD HH:mm:ss")}] [${type}] ${msg}`, extra || "");
}

// ===== Express =====
const app = express();
app.use(cors());
app.use(express.json());

app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 200,
  })
);

app.use("/place-order", placeOrderRoute);

// ===== API Key Middleware =====
function requireApiKey(req, res, next) {
  const queryKey = req.query.key || req.query.token || req.query.api_key;
  const headerKey = req.headers["x-api-key"];
  const token = headerKey || queryKey;
  if (token !== FEED_API_KEY) {
    return res.status(403).json({ success: false, error: "Forbidden" });
  }
  next();
}

// ===== REST Endpoints =====
app.get("/prices", requireApiKey, async (req, res) => {
  try {
    const symbols =
      req.query.symbols?.split(",").map((s) => normalizeSymbol(s)) ||
      Array.from(WHITELIST);
    const prices = {};
    for (const sym of symbols) {
      const raw = await redis.hget("latest_prices", sym);
      prices[sym] = raw ? JSON.parse(raw) : null;
    }
    res.json({ success: true, prices });
  } catch (err) {
    logEvent("ERR", "Prices endpoint error", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/candles", requireApiKey, async (req, res) => {
  try {
    const symbol = normalizeSymbol(req.query.symbol);
    const interval = req.query.interval || "1m";
    const limit = parseInt(req.query.limit || "200");

    if (!symbol || !CONTRACTS[symbol]) {
      return res.status(400).json({ success: false, error: "invalid symbol" });
    }

    const rawTicks = await redis.lrange(`ticks:${symbol}`, 0, limit * 100);
    const ticks = rawTicks.map((x) => JSON.parse(x)).reverse();

    const bucketSecs =
      interval === "1m" ? 60 :
      interval === "5m" ? 300 :
      interval === "15m" ? 900 :
      interval === "1h" ? 3600 : 60;

    const candles = [];
    let bucket = null;

    for (const t of ticks) {
      const ts = Math.floor(t.ts / 1000);
      const bucketTime = Math.floor(ts / bucketSecs) * bucketSecs;

      if (!bucket || bucket.time !== bucketTime) {
        if (bucket) candles.push(bucket);
        bucket = { time: bucketTime, open: t.price, high: t.price, low: t.price, close: t.price };
      } else {
        bucket.high = Math.max(bucket.high, t.price);
        bucket.low = Math.min(bucket.low, t.price);
        bucket.close = t.price;
      }
    }
    if (bucket) candles.push(bucket);
    res.json(candles.reverse().slice(-limit));
  } catch (err) {
    logEvent("ERR", "Candle endpoint error", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/metrics", async (req, res) => {
  try {
    res.set("Content-Type", client.register.contentType);
    res.end(await client.register.metrics());
  } catch (ex) {
    res.status(500).end(ex);
  }
});

// ===== WS =====
const wss = new WebSocket.Server({ noServer: true });
function heartbeat() { this.isAlive = true; }

// ===== Redis Subscriptions (from publisher.js) =====
redisSub.subscribe("price_ticks", () => logEvent("INIT", "Subscribed price_ticks"));
redisSub.subscribe("orderbook_updates", () => logEvent("INIT", "Subscribed orderbook_updates"));

redisSub.on("message", (channel, msg) => {
  try {
    const data = JSON.parse(msg);
    if (channel === "price_ticks") {
      ticksPublished.inc({ symbol: data.symbol });
      feedHealth.set({ symbol: data.symbol, exchange: "binance" }, 1);
      broadcast({ type: "price", ...data });
    }
    if (channel === "orderbook_updates") {
      broadcast({ type: "orderbook", ...data });
    }
  } catch (err) {
    logEvent("ERR", "Redis sub parse error", err.message);
  }
});

// ===== Broadcast =====
function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const client of wss.clients) {
    if (client.readyState !== WebSocket.OPEN) continue;
    if (!client.subscriptions || client.subscriptions.has(msg.symbol)) {
      if (client.bufferedAmount < 1e6) client.send(data);
    }
  }
}

// ===== Whitelist Init =====
async function initWhitelist() {
  try {
    const { data: instruments } = await supabase
      .from("instruments")
      .select("feed_code")
      .eq("is_active", true);

    if (instruments?.length) {
      setWhitelist(instruments.map((i) => normalizeSymbol(i.feed_code)));
    } else {
      logEvent("WARN", "Supabase empty, using fallback symbols");
      setWhitelist(["BINANCE:BTCUSDT", "BINANCE:ETHUSDT", "BINANCE:XAUUSDT"]);
    }
    logEvent("INIT", `Whitelist: ${Array.from(WHITELIST).join(", ")}`);
  } catch (err) {
    logEvent("ERR", "Failed to init whitelist", err.message);
    setWhitelist(["BINANCE:BTCUSDT", "BINANCE:ETHUSDT", "BINANCE:XAUUSDT"]);
  }
}

// ===== Startup =====
const server = app.listen(PORT, "0.0.0.0", async () => {
  logEvent("START", `Price Server running on ${PORT}`);
  setBroadcaster((msg) => broadcast(msg));
  await initWhitelist();
  startDailyReset();   // ✅ start daily reset at startup
});

// ===== WS Auth =====
server.on("upgrade", (req, socket, head) => {
  const parsedUrl = url.parse(req.url, true);
  const query = parsedUrl.query;

  const queryKey = query.key || query.token || query.api_key;
  const headerKey = req.headers["sec-websocket-protocol"];
  const token = headerKey || queryKey;

  if (token !== FEED_API_KEY) {
    logEvent("AUTH", `WS auth failed from ${req.socket.remoteAddress}`);
    socket.destroy();
    return;
  }

  if (parsedUrl.pathname === "/ws") {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  } else {
    socket.destroy();
  }
});

wss.on("connection", async (ws) => {
  ws.isAlive = true;
  ws.subscriptions = new Set();
  ws.on("pong", heartbeat);

  const prices = {};
  const orderbooks = {};
  for (const sym of WHITELIST) {
    const raw = await redis.hget("latest_prices", sym);
    prices[sym] = raw ? JSON.parse(raw) : null;

    const obRaw = await redis.get(`orderbook:${sym}`);
    orderbooks[sym] = obRaw ? JSON.parse(obRaw) : { bids: [], asks: [] };
  }

  ws.send(JSON.stringify({ type: "welcome", prices, orderbooks }));
  wsConnections.inc();
  ws.on("close", () => wsConnections.dec());
  ws.on("message", async (msg) => {
    try {
      const data = JSON.parse(msg.toString());
      if (data.type === "subscribe" && data.symbol) {
        const norm = normalizeSymbol(data.symbol);
        if (!CONTRACTS[norm]) return;
        ws.subscriptions.add(norm);
        ws.send(JSON.stringify({ type: "subscribed", symbol: norm }));
      }
      if (data.type === "unsubscribe" && data.symbol) {
        ws.subscriptions.delete(normalizeSymbol(data.symbol));
      }
    } catch (err) {
      logEvent("ERR", "WS message error", err.message);
    }
  });
});

// ===== Keepalive =====
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 25000);

// ===== Shutdown =====
process.on("SIGINT", async () => {
  logEvent("STOP", "Shutting down...");
  await redis.quit();
  await redisSub.quit();
  server.close(() => process.exit(0));
});
