// index.js — Production Price Server (Binance → Redis → Broadcast + Orderbook Snapshot + Metrics)

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
const client = require("prom-client"); // ✅ Prometheus

dayjs.extend(utc);
dayjs.extend(timezone);

// ===== Shared Imports =====
const { normalizeSymbol } = require("../shared/symbolMap");
const { WHITELIST, addTick } = require("../shared/state");
const {
  processTick,
  setBroadcaster,
  loadInitialData,
} = require("../matching-engine/matchingEngine");
const placeOrderRoute = require("./placeOrder");

// ===== CONFIG =====
const PORT = process.env.PORT || 4000;
const redisUrl = process.env.REDIS_URL;
const FEED_API_KEY = process.env.FEED_API_KEY || "supersecret";

console.log("🔑 REDIS_URL =", redisUrl);
console.log("🔑 FEED_API_KEY =", FEED_API_KEY);

// ✅ Redis clients
const redis = new Redis(redisUrl, { maxRetriesPerRequest: null });
const redisSub = new Redis(redisUrl, { maxRetriesPerRequest: null });

// ===== Prometheus Metrics =====
client.collectDefaultMetrics();

const ticksPublished = new client.Counter({
  name: "price_ticks_published_total",
  help: "Total number of ticks published to Redis",
  labelNames: ["symbol"],
});

const wsConnections = new client.Gauge({
  name: "ws_connections",
  help: "Number of active WebSocket clients",
});

const httpRequests = new client.Counter({
  name: "http_requests_total",
  help: "Number of HTTP requests served",
  labelNames: ["endpoint", "method", "status"],
});

function observeRequest(req, res, endpoint) {
  httpRequests.inc({ endpoint, method: req.method, status: res.statusCode });
}

// ===== Logging =====
function logEvent(type, msg, extra) {
  console.log(
    `[${dayjs().format("YYYY-MM-DD HH:mm:ss")}] [${type}] ${msg}`,
    extra || ""
  );
}

// ===== Price Storage =====
const TICK_HISTORY_LIMIT = 1000;
const MAX_BROADCAST_TPS = 20;
const TPS_BUCKET = { count: 0, ts: Date.now() };
const priceBuffer = {};
const lastHistoryPush = {};
const FLUSH_INTERVAL_MS = 200;
const HISTORY_INTERVAL_MS = 1000;

function bufferPrice(binanceSymbol, price, ts) {
  priceBuffer[binanceSymbol] = JSON.stringify({ price, ts });
}

async function flushPrices() {
  if (Object.keys(priceBuffer).length > 0) {
    try {
      await redis.hset("latest_prices", priceBuffer);
      for (const k of Object.keys(priceBuffer)) delete priceBuffer[k];
    } catch (err) {
      logEvent("ERR", "Failed to flush prices to Redis", err.message);
    }
  }
}
setInterval(flushPrices, FLUSH_INTERVAL_MS);

async function saveTickHistoryThrottled(binanceSymbol, price, ts) {
  if (
    !lastHistoryPush[binanceSymbol] ||
    ts - lastHistoryPush[binanceSymbol] >= HISTORY_INTERVAL_MS
  ) {
    try {
      const key = `ticks:${binanceSymbol}`;
      await redis.lpush(key, JSON.stringify({ ts, price }));
      await redis.ltrim(key, 0, TICK_HISTORY_LIMIT - 1);
      lastHistoryPush[binanceSymbol] = ts;
    } catch (err) {
      logEvent("ERR", `Failed to save tick for ${binanceSymbol}`, err.message);
    }
  }
}

// ===== BROADCAST =====
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
    if (
      !client.subscriptions ||
      client.subscriptions.size === 0 ||
      client.subscriptions.has(msg.symbol)
    ) {
      if (client.bufferedAmount < 1e6) {
        client.send(data);
      }
    }
  }
}

// ===== Express + WS =====
const app = express();
app.use(cors());
app.use(express.json());

// ✅ Rate limit API only, not WS
app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
  })
);

app.use("/place-order", placeOrderRoute);

// ===== API Key Middleware =====
function requireApiKey(req, res, next) {
  const queryKey = req.query.key;
  const headerKey = req.headers["x-api-key"];
  const token = headerKey || queryKey;
  if (token !== FEED_API_KEY) {
    return res.status(403).json({ success: false, error: "Forbidden" });
  }
  next();
}

// ===== REST Endpoints =====
app.get("/prices", requireApiKey, async (req, res) => {
  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
  try {
    const symbols =
      req.query.symbols?.split(",").map((s) => s.toUpperCase()) ||
      Array.from(WHITELIST);

    logEvent("API", `[/prices] from ${ip}, symbols=${symbols.join(",")}`);

    const prices = {};
    for (const sym of symbols) {
      const raw = await redis.hget("latest_prices", sym);
      prices[sym] = raw ? JSON.parse(raw) : null;
    }
    res.json({ success: true, prices });
    observeRequest(req, res, "/prices");
  } catch (err) {
    logEvent("ERR", "Prices endpoint error", err.message);
    res.status(500).json({ success: false, error: err.message });
    observeRequest(req, res, "/prices");
  }
});

app.get("/candles", requireApiKey, async (req, res) => {
  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
  try {
    const symbol = req.query.symbol?.toUpperCase();
    const interval = req.query.interval || "1m";
    const limit = parseInt(req.query.limit || "200");

    logEvent(
      "API",
      `[/candles] from ${ip}, symbol=${symbol}, interval=${interval}, limit=${limit}`
    );

    if (!symbol) {
      res.status(400).json({ success: false, error: "symbol required" });
      observeRequest(req, res, "/candles");
      return;
    }

    const rawTicks = await redis.lrange(`ticks:${symbol}`, 0, limit * 100);
    const ticks = rawTicks.map((x) => JSON.parse(x)).reverse();

    const bucketSecs =
      interval === "1m"
        ? 60
        : interval === "5m"
        ? 300
        : interval === "15m"
        ? 900
        : interval === "1h"
        ? 3600
        : 60;

    const candles = [];
    let bucket = null;

    for (const t of ticks) {
      const ts = Math.floor(t.ts / 1000);
      const bucketTime = Math.floor(ts / bucketSecs) * bucketSecs;

      if (!bucket || bucket.time !== bucketTime) {
        if (bucket) candles.push(bucket);
        bucket = {
          time: bucketTime,
          open: t.price,
          high: t.price,
          low: t.price,
          close: t.price,
        };
      } else {
        bucket.high = Math.max(bucket.high, t.price);
        bucket.low = Math.min(bucket.low, t.price);
        bucket.close = t.price;
      }
    }
    if (bucket) candles.push(bucket);

    res.json(candles.reverse().slice(-limit));
    observeRequest(req, res, "/candles");
  } catch (err) {
    logEvent("ERR", "Candle endpoint error", err.message);
    res.status(500).json({ success: false, error: err.message });
    observeRequest(req, res, "/candles");
  }
});

// ✅ Prometheus Metrics endpoint
app.get("/metrics", async (req, res) => {
  try {
    res.set("Content-Type", client.register.contentType);
    res.end(await client.register.metrics());
  } catch (ex) {
    res.status(500).end(ex);
  }
});

// ===== WS server =====
const wss = new WebSocket.Server({ noServer: true });
function heartbeat() {
  this.isAlive = true;
}

// ===== Startup =====
const server = app.listen(PORT, "0.0.0.0", async () => {
  logEvent("START", `Price Server running on port ${PORT}`);

  setBroadcaster((msg) => throttledBroadcast(msg));

  try {
    const instruments = await loadInitialData();
    logEvent("INIT", `Loaded ${instruments.length} instruments from Supabase`);

    instruments.forEach((inst) => {
      if (!inst.feed_code) return;
      const [exchange, pair] = inst.feed_code.split(":");
      if (exchange === "BINANCE") {
        const binanceSymbol = pair.toUpperCase();
        const norm = normalizeSymbol(binanceSymbol);

        startBinanceTrade(binanceSymbol, norm);
        startBinanceOrderbook(binanceSymbol, norm);
      }
    });
  } catch (err) {
    logEvent("ERR", "Initial data load failed", err.message);
  }
});

// ===== Binance Trade Feed =====
function startBinanceTrade(binanceSymbol, norm) {
  const ws = new WebSocket(
    `wss://stream.binance.com:9443/ws/${binanceSymbol.toLowerCase()}@trade`
  );
  ws.on("open", () =>
    logEvent("FEED", `Connected Trade ${binanceSymbol}/${norm}`)
  );
  ws.on("message", async (msg) => {
    try {
      const data = JSON.parse(msg);
      const price = parseFloat(data.p);
      const tick = { symbol: binanceSymbol, norm, price, ts: Date.now() };

      bufferPrice(binanceSymbol, price, tick.ts);
      addTick(binanceSymbol, price, tick.ts);
      saveTickHistoryThrottled(binanceSymbol, price, tick.ts);
      throttledBroadcast({ type: "price", ...tick });
      processTick(binanceSymbol, price);

      ticksPublished.inc({ symbol: binanceSymbol }); // ✅ metric
      await redis.publish("price_ticks", JSON.stringify(tick));
    } catch (e) {
      logEvent("ERR", "Binance trade parse failed", e.message);
    }
  });
  ws.on("close", () => logEvent("FEED", `Trade ${binanceSymbol} closed`));
}

// ===== Binance Orderbook Feed =====
function startBinanceOrderbook(binanceSymbol, norm) {
  const ws = new WebSocket(
    `wss://stream.binance.com:9443/ws/${binanceSymbol.toLowerCase()}@depth10@100ms`
  );
  ws.on("open", () =>
    logEvent("FEED", `Connected OB ${binanceSymbol}/${norm}`)
  );
  ws.on("message", async (msg) => {
    try {
      const data = JSON.parse(msg);
      const ob = {
        bids: data.bids.map(([price, qty]) => [
          parseFloat(price),
          parseFloat(qty),
        ]),
        asks: data.asks.map(([price, qty]) => [
          parseFloat(price),
          parseFloat(qty),
        ]),
        ts: Date.now(),
        norm,
      };

      await redis.set(`orderbook:${binanceSymbol}`, JSON.stringify(ob), "EX", 10);
      throttledBroadcast({ type: "orderbook", symbol: binanceSymbol, ...ob });
    } catch (e) {
      logEvent("ERR", "Binance orderbook parse failed", e.message);
    }
  });
  ws.on("close", () => logEvent("FEED", `OB ${binanceSymbol} closed`));
}

// ===== WS Auth + Upgrade =====
server.on("upgrade", (req, socket, head) => {
  const queryKey = url.parse(req.url, true).query.key;
  const headerKey = req.headers["sec-websocket-protocol"];
  const token = headerKey || queryKey;

  if (token !== FEED_API_KEY) {
    logEvent("AUTH", "❌ Invalid key, closing socket");
    socket.destroy();
    return;
  }

  if (url.parse(req.url).pathname === "/ws") {
    wss.handleUpgrade(req, socket, head, (ws) =>
      wss.emit("connection", ws, req)
    );
  } else socket.destroy();
});

// ===== Handle WS connections =====
wss.on("connection", async (ws, req) => {
  ws.isAlive = true;
  ws.subscriptions = new Set();
  ws.on("pong", heartbeat);

  const prices = {};
  for (const sym of WHITELIST) {
    const raw = await redis.hget("latest_prices", sym);
    prices[sym] = raw ? JSON.parse(raw) : null;
  }

  const orderbooks = {};
  for (const sym of WHITELIST) {
    const raw = await redis.get(`orderbook:${sym}`);
    orderbooks[sym] = raw ? JSON.parse(raw) : { bids: [], asks: [] };
  }

  ws.send(JSON.stringify({ type: "welcome", prices, orderbooks }));
  logEvent("WS", `Client connected ${req.socket.remoteAddress}`);

  wsConnections.inc(); // ✅ metric

  ws.on("close", () => {
    wsConnections.dec(); // ✅ metric
  });

  ws.on("message", async (msg) => {
    try {
      const data = JSON.parse(msg.toString());

      if (data.type === "subscribe" && data.symbol) {
        const binanceSymbol = data.symbol.toUpperCase();
        ws.subscriptions.add(binanceSymbol);
        ws.send(JSON.stringify({ type: "subscribed", symbol: binanceSymbol }));

        const raw = await redis.hget("latest_prices", binanceSymbol);
        if (raw) {
          ws.send(
            JSON.stringify({ type: "price", symbol: binanceSymbol, ...JSON.parse(raw) })
          );
        }
        const ob = await redis.get(`orderbook:${binanceSymbol}`);
        if (ob) {
          ws.send(
            JSON.stringify({ type: "orderbook", symbol: binanceSymbol, ...JSON.parse(ob) })
          );
        }
      }

      if (data.type === "unsubscribe" && data.symbol) {
        const binanceSymbol = data.symbol.toUpperCase();
        ws.subscriptions.delete(binanceSymbol);
        ws.send(JSON.stringify({ type: "unsubscribed", symbol: binanceSymbol }));
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
  logEvent("STOP", "Shutting down Price Server...");
  await redis.quit();
  await redisSub.quit();
  server.close(() => process.exit(0));
});
