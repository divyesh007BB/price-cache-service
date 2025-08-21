// index.js — Production Price Server (Topstep-level hardened)
// Binance → Redis → Broadcast + Orderbook + Persistence + Metrics

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
const { WHITELIST, addTick, setWhitelist } = require("../shared/state");
const { processTick, setBroadcaster } = require("../matching-engine/matchingEngine");
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
      logEvent("ERR", "Failed to flush prices", err.message);
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

async function preloadTicks(symbols) {
  for (const sym of symbols) {
    const ticks = await redis.lrange(`ticks:${sym}`, 0, 1);
    if (ticks.length > 0) {
      const last = JSON.parse(ticks[0]);
      bufferPrice(sym, last.price, last.ts);
    }
  }
  logEvent("INIT", "Preloaded ticks from Redis");
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
    if (!client.subscriptions || client.subscriptions.has(msg.symbol)) {
      if (client.bufferedAmount < 1e6) {
        client.send(data);
      }
    }
  }
}

// ===== Express =====
const app = express();
app.use(cors());
app.use(express.json());

app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
  })
);

app.use("/place-order", placeOrderRoute);

// ===== API Key Middleware =====
function requireApiKey(req, res, next) {
  const queryKey = req.query.key || req.query.token;
  const headerKey = req.headers["x-api-key"];
  const token = headerKey || queryKey;
  if (token !== FEED_API_KEY) {
    return res.status(403).json({ success: false, error: "Forbidden" });
  }
  next();
}

// ===== REST =====
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

// ===== Resilient Feeds =====
function resilientWS(url, onMessage, label, normSymbol, exchange) {
  let ws;
  function connect() {
    ws = new WebSocket(url);
    ws.on("open", () => {
      logEvent("FEED", `Connected ${label}`);
      feedHealth.set({ symbol: normSymbol, exchange }, 1);
    });
    ws.on("message", onMessage);
    ws.on("close", () => {
      logEvent("FEED", `${label} closed. Reconnecting...`);
      feedHealth.set({ symbol: normSymbol, exchange }, 0);
      setTimeout(connect, 3000);
    });
    ws.on("error", (err) => {
      logEvent("ERR", `${label} error`, err.message);
      ws.close();
    });
  }
  connect();
}

function startBinanceTrade(binanceSymbol) {
  const norm = normalizeSymbol(`BINANCE:${binanceSymbol}`);
  resilientWS(
    `wss://stream.binance.com:9443/ws/${binanceSymbol.toLowerCase()}@trade`,
    async (msg) => {
      try {
        const data = JSON.parse(msg);
        const price = parseFloat(data.p);
        const ts = Date.now();
        if (!CONTRACTS[norm]) return;
        const tick = { symbol: norm, raw: binanceSymbol, price, ts };
        bufferPrice(norm, price, ts);
        addTick(norm, price, ts);
        saveTickHistoryThrottled(norm, price, ts);
        throttledBroadcast({ type: "price", ...tick });
        processTick(norm, price);
        ticksPublished.inc({ symbol: norm });
        await redis.publish("price_ticks", JSON.stringify(tick));
      } catch (e) {
        logEvent("ERR", "Binance trade parse failed", e.message);
      }
    },
    `Trade ${binanceSymbol}`,
    norm,
    "binance"
  );
}

function startBinanceOrderbook(binanceSymbol) {
  const norm = normalizeSymbol(`BINANCE:${binanceSymbol}`);
  resilientWS(
    `wss://stream.binance.com:9443/ws/${binanceSymbol.toLowerCase()}@depth10@100ms`,
    async (msg) => {
      try {
        const data = JSON.parse(msg);
        const ts = Date.now();
        if (!CONTRACTS[norm]) return;
        const ob = {
          bids: data.bids.map(([p, q]) => [parseFloat(p), parseFloat(q)]),
          asks: data.asks.map(([p, q]) => [parseFloat(p), parseFloat(q)]),
          ts, symbol: norm, raw: binanceSymbol,
        };
        await redis.set(`orderbook:${norm}`, JSON.stringify(ob), "EX", 10);
        await redis.publish(`orderbook_${norm}`, JSON.stringify(ob));
        throttledBroadcast({ type: "orderbook", ...ob });
      } catch (e) {
        logEvent("ERR", "Binance orderbook parse failed", e.message);
      }
    },
    `OB ${binanceSymbol}`,
    norm,
    "binance"
  );
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
      setWhitelist(["BTCUSD", "ETHUSD", "XAUUSD"]);
    }
    logEvent("INIT", `Whitelist: ${Array.from(WHITELIST).join(", ")}`);
  } catch (err) {
    logEvent("ERR", "Failed to init whitelist", err.message);
  }
}

// ===== Startup =====
const server = app.listen(PORT, "0.0.0.0", async () => {
  logEvent("START", `Price Server running on ${PORT}`);
  setBroadcaster((msg) => throttledBroadcast(msg));

  try {
    await initWhitelist();
    const { data: instruments } = await supabase
      .from("instruments")
      .select("feed_code")
      .eq("is_active", true);
    const syms = instruments?.map((i) => i.feed_code) || [];
    await preloadTicks(syms);
    for (const inst of syms) {
      const [ex, pair] = inst.split(":");
      if (ex === "BINANCE") {
        startBinanceTrade(pair.toUpperCase());
        startBinanceOrderbook(pair.toUpperCase());
      }
    }
  } catch (err) {
    logEvent("ERR", "Init failed", err.message);
  }
});

// ===== WS Auth =====
server.on("upgrade", (req, socket, head) => {
  const query = url.parse(req.url, true).query;
  const queryKey = query.key || query.token;
  const headerKey = req.headers["sec-websocket-protocol"];
  const token = headerKey || queryKey;
  if (token !== FEED_API_KEY) {
    socket.destroy();
    return;
  }
  if (url.parse(req.url).pathname === "/ws") {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  } else socket.destroy();
});

wss.on("connection", async (ws, req) => {
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

  ws.send(JSON.stringify({ type: "welcome", prices, orderbooks })); // ✅ FIXED
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
