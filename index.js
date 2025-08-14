// index.js — Lean Price Server (NIFTY + BTC Launch, Redis-based live prices)

require("dotenv").config();
const express = require("express");
const WebSocket = require("ws");
const cors = require("cors");
const fetch = require("node-fetch");
const url = require("url");
const { Redis } = require("@upstash/redis"); // ✅ Upstash REST client
const dayjs = require("dayjs");
const utc = require("dayjs/plugin/utc");
const timezone = require("dayjs/plugin/timezone");
dayjs.extend(utc);
dayjs.extend(timezone);

const {
  loadInitialData,
  processTick,
  setBroadcaster,
  getAccounts,
  getOpenTrades,
  getPendingOrders
} = require("./matchingEngine");
const { evaluateOpenPositions } = require("./riskEngine");
const placeOrderRoute = require("./placeOrder");
const { getContracts, normalizeSymbol } = require("./symbolMap");
const { WHITELIST, addTick, getTicks } = require("./state");

// ===== CONFIG =====
const PORT = process.env.PORT || 4000;
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const TICK_HISTORY_LIMIT = 1000;
const MAX_BROADCAST_TPS = 20;
const TPS_BUCKET = { count: 0, ts: Date.now() };

// ===== Instruments: Only NIFTY + BTC =====
const CONTRACTS = getContracts();
WHITELIST.clear();
WHITELIST.add("NIFTY");
WHITELIST.add("BINANCE:BTCUSDT");

const YAHOO_MAP = { "NIFTY": "^NSEI" };
const BINANCE_WS_URL = "wss://stream.binance.com:9443/ws/btcusdt@trade";

// ===== Helpers =====
function logEvent(type, msg, extra) {
  console.log(`[${dayjs().format("YYYY-MM-DD HH:mm:ss")}] [${type}] ${msg}`, extra || "");
}

async function savePrice(symbol, price, ts) {
  await redis.set(`price:${symbol}`, JSON.stringify({ price, ts }));
}

async function getPrice(symbol) {
  const raw = await redis.get(`price:${symbol}`);
  return raw ? JSON.parse(raw) : null;
}

async function saveTickHistory(symbol, price, ts) {
  try {
    const key = `ticks:${symbol}`;
    await redis.lpush(key, JSON.stringify({ ts, price }));
    await redis.ltrim(key, 0, TICK_HISTORY_LIMIT - 1);
  } catch (err) {
    logEvent("ERR", `Failed to save tick for ${symbol}`, err.message);
  }
}

async function getRecentTicks(symbol, limit = 50) {
  const buf = getTicks(symbol);
  if (buf.length > 0) return buf.slice(-limit);
  try {
    const key = `ticks:${symbol}`;
    const entries = await redis.lrange(key, 0, limit - 1);
    return entries.map(e => JSON.parse(e)).reverse();
  } catch (err) {
    logEvent("ERR", `Failed to get recent ticks for ${symbol}`, err.message);
    return [];
  }
}

// ===== Price Feeds =====
function startFeeds() {
  startYahooNifty();
  startBinanceBTC();
  logEvent("START", "Lean price feeds started (NIFTY + BTC only)");
}

async function fetchYahooPrice(yahooSymbol) {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${yahooSymbol}?interval=1m`;
    const res = await fetch(url);
    const data = await res.json();
    return data?.chart?.result?.[0]?.meta?.regularMarketPrice ?? null;
  } catch {
    return null;
  }
}

function startYahooNifty() {
  const poll = async () => {
    const price = await fetchYahooPrice(YAHOO_MAP["NIFTY"]);
    if (price) publishPrice("NIFTY", price);
  };
  poll();
  setInterval(poll, 60_000); // Yahoo free ~1min update
}

function startBinanceBTC() {
  const ws = new WebSocket(BINANCE_WS_URL);
  ws.on("open", () => logEvent("INFO", "Connected to Binance BTC"));
  ws.on("message", (msg) => {
    try {
      const data = JSON.parse(msg);
      if (!data.p) return;
      publishPrice("BINANCE:BTCUSDT", parseFloat(data.p));
    } catch {}
  });
  ws.on("close", () => setTimeout(startBinanceBTC, 5000));
}

// ===== Price Publish =====
function publishPrice(symbol, price) {
  const normSymbol = normalizeSymbol(symbol);
  const ts = Date.now();

  // Save to Redis
  savePrice(normSymbol, price, ts);

  // Keep tick history
  addTick(normSymbol, price, ts);
  saveTickHistory(normSymbol, price, ts);

  // Broadcast to clients
  throttledBroadcast({ type: "price", symbol: normSymbol, price, ts });

  // Matching engine + risk
  processTick(normSymbol, price);
  evaluateOpenPositions(normSymbol, price);

  // Redis pub/sub for other services
  redis.publish("prices", JSON.stringify({ symbol: normSymbol, price, ts }));
}

// ===== Broadcast =====
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
app.use("/", placeOrderRoute);

const wss = new WebSocket.Server({ noServer: true });
function heartbeat() { this.isAlive = true; }
function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(data);
  }
}
setBroadcaster(broadcast);

const server = app.listen(PORT, async () => {
  logEvent("START", `Server running on port ${PORT}`);
  await loadInitialData();
  startFeeds();
});

server.on("upgrade", async (req, socket, head) => {
  const pathname = url.parse(req.url).pathname;
  if (pathname === "/ws") {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  } else socket.destroy();
});

wss.on("connection", async (ws) => {
  ws.isAlive = true;
  ws.on("pong", heartbeat);
  logEvent("WS", "Client connected");
  ws.send(JSON.stringify({ type: "welcome", symbols: Array.from(WHITELIST) }));
  ws.send(JSON.stringify({
    type: "sync_state",
    accounts: getAccounts(),
    pendingOrders: getPendingOrders(),
    openTrades: getOpenTrades()
  }));
  for (const sym of WHITELIST) {
    const cached = await getPrice(sym);
    if (cached) ws.send(JSON.stringify({ type: "price", symbol: sym, price: cached.price, ts: cached.ts }));
    const history = await getRecentTicks(sym, 50);
    if (history.length > 0) {
      ws.send(JSON.stringify({ type: "history", symbol: sym, ticks: history }));
    }
  }
});

setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 25000);

process.on("unhandledRejection", (err) => logEvent("FATAL", "UnhandledRejection", err));
process.on("uncaughtException", (err) => logEvent("FATAL", "UncaughtException", err));
