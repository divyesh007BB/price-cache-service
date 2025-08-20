// index.js — Production Price Server (Binance → Redis → Broadcast + Orderbook Snapshot)

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

function bufferPrice(symbol, price, ts) {
  priceBuffer[symbol] = JSON.stringify({ price, ts });
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

// ===== REST Endpoints =====

// latest price snapshot
app.get("/prices", async (req, res) => {
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
    res.status(500).json({ success: false, error: err.message });
  }
});

// OHLC candle history
app.get("/candles", async (req, res) => {
  try {
    const symbol = normalizeSymbol(req.query.symbol);
    const interval = req.query.interval || "1m";
    const limit = parseInt(req.query.limit || "200");

    if (!symbol) {
      return res.status(400).json({ success: false, error: "symbol required" });
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
  } catch (err) {
    logEvent("ERR", "Candle endpoint error", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ===== WS server =====
const wss = new WebSocket.Server({ noServer: true });
function heartbeat() { this.isAlive = true; }

// ===== Startup =====
const server = app.listen(PORT, "0.0.0.0", async () => {
  logEvent("START", `Price Server running on port ${PORT}`);

  setBroadcaster((msg) => throttledBroadcast(msg));

  try {
    await loadInitialData();
    logEvent("INIT", "Loaded initial data from Supabase + Redis");
  } catch (err) {
    logEvent("ERR", "Initial data load failed", err.message);
  }

  // ✅ Start Binance feeds (trade + orderbook)
  startBinanceTrade("btcusdt", "BTCUSD");
  startBinanceTrade("ethusdt", "ETHUSD");
  startBinanceTrade("xauusdt", "XAUUSD");

  startBinanceOrderbook("btcusdt", "BTCUSD");
  startBinanceOrderbook("ethusdt", "ETHUSD");
  startBinanceOrderbook("xauusdt", "XAUUSD");
});

// ===== Binance Trade Feed =====
function startBinanceTrade(binanceSymbol, internalSymbol) {
  const ws = new WebSocket(`wss://stream.binance.com:9443/ws/${binanceSymbol}@trade`);
  ws.on("open", () => logEvent("FEED", `Connected Trade ${internalSymbol}`));
  ws.on("message", async (msg) => {
    try {
      const data = JSON.parse(msg);
      const price = parseFloat(data.p);
      const tick = { symbol: internalSymbol, price, ts: Date.now() };

      bufferPrice(internalSymbol, price, tick.ts);
      addTick(internalSymbol, price, tick.ts);
      saveTickHistoryThrottled(internalSymbol, price, tick.ts);
      throttledBroadcast({ type: "price", ...tick });
      processTick(internalSymbol, price);

      await redis.publish("price_ticks", JSON.stringify(tick));
    } catch (e) {
      logEvent("ERR", "Binance trade parse failed", e.message);
    }
  });
  ws.on("close", () => logEvent("FEED", `Trade ${internalSymbol} closed`));
}

// ===== Binance Orderbook Feed =====
function startBinanceOrderbook(binanceSymbol, internalSymbol) {
  const ws = new WebSocket(`wss://stream.binance.com:9443/ws/${binanceSymbol}@depth10@100ms`);
  ws.on("open", () => logEvent("FEED", `Connected OB ${internalSymbol}`));
  ws.on("message", async (msg) => {
    try {
      const data = JSON.parse(msg);
      const ob = {
        bids: data.bids.map(([price, qty]) => [parseFloat(price), parseFloat(qty)]),
        asks: data.asks.map(([price, qty]) => [parseFloat(price), parseFloat(qty)]),
        ts: Date.now(),
      };

      await redis.set(`orderbook:${internalSymbol}`, JSON.stringify(ob), "EX", 10);
      throttledBroadcast({ type: "orderbook", symbol: internalSymbol, ...ob });
    } catch (e) {
      logEvent("ERR", "Binance orderbook parse failed", e.message);
    }
  });
  ws.on("close", () => logEvent("FEED", `OB ${internalSymbol} closed`));
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
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  } else socket.destroy();
});

// ===== Handle WS connections =====
wss.on("connection", async (ws, req) => {
  ws.isAlive = true;
  ws.subscriptions = new Set();
  ws.on("pong", heartbeat);

  // ✅ Get all latest prices
  const prices = {};
  for (const sym of WHITELIST) {
    const raw = await redis.hget("latest_prices", sym);
    prices[sym] = raw ? JSON.parse(raw) : null;
  }

  // ✅ Get mini orderbook snapshot
  const orderbooks = {};
  for (const sym of WHITELIST) {
    const raw = await redis.get(`orderbook:${sym}`);
    orderbooks[sym] = raw ? JSON.parse(raw) : { bids: [], asks: [] };
  }

  // ✅ Send welcome packet with both prices + orderbooks
  ws.send(JSON.stringify({ type: "welcome", prices, orderbooks }));

  logEvent("WS", `Client connected ${req.socket.remoteAddress}`);

  ws.on("message", async (msg) => {
    try {
      const data = JSON.parse(msg.toString());

      if (data.type === "subscribe" && data.symbol) {
        const sym = normalizeSymbol(data.symbol);
        ws.subscriptions.add(sym);
        ws.send(JSON.stringify({ type: "subscribed", symbol: sym }));

        // ✅ Send latest cached price + orderbook for this symbol
        const raw = await redis.hget("latest_prices", sym);
        if (raw) {
          ws.send(JSON.stringify({ type: "price", symbol: sym, ...JSON.parse(raw) }));
        }
        const ob = await redis.get(`orderbook:${sym}`);
        if (ob) {
          ws.send(JSON.stringify({ type: "orderbook", symbol: sym, ...JSON.parse(ob) }));
        }
      }

      if (data.type === "unsubscribe" && data.symbol) {
        const sym = normalizeSymbol(data.symbol);
        ws.subscriptions.delete(sym);
        ws.send(JSON.stringify({ type: "unsubscribed", symbol: sym }));
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
