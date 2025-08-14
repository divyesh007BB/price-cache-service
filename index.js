// index.js — Price server + order matching + prop firm grade upgrades
require("dotenv").config();
const express = require("express");
const WebSocket = require("ws");
const cors = require("cors");
const fetch = require("node-fetch");
const url = require("url");

// ✅ dayjs + plugins
const dayjs = require("dayjs");
const utc = require("dayjs/plugin/utc");
const timezone = require("dayjs/plugin/timezone");
dayjs.extend(utc);
dayjs.extend(timezone);

const { supabaseAdmin } = require("./config");

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
const { loadContractsFromDB, getContracts } = require("./symbolMap");
const { priceCache, WHITELIST } = require("./state");
const feedControl = require("./feedControl");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 4000;
const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY;
const DEV_MODE = process.env.NODE_ENV !== "production";

// Feed state
let FEED_MAP = {};
let yahooIntervals = new Map();
let finnhubWS = null;

let backoffMap = new Map();
let lastPriceTimestamp = new Map();
let marketOpenCache = new Map();

// ===== CONFIG =====
const STALE_PRICE_MS = 20_000;
const MAX_BROADCAST_TPS = 20;
const TPS_BUCKET = { count: 0, ts: Date.now() };
const MARKET_HOURS_ENFORCEMENT = true;
const MAX_RECONNECT_ATTEMPTS = 20;
let reconnectAttempts = 0;
// ==================

// Structured log
function logEvent(type, msg, extra) {
  console.log(`[${dayjs().format("YYYY-MM-DD HH:mm:ss")}] [${type}] ${msg}`, extra || "");
}

// ===== INSTRUMENTS =====
async function refreshInstruments() {
  await loadContractsFromDB();
  const CONTRACTS = getContracts();
  if (!CONTRACTS || Object.keys(CONTRACTS).length === 0) {
    logEvent("ERR", "No contracts loaded from DB");
    return;
  }
  WHITELIST.clear();
  Object.keys(CONTRACTS).forEach(code => WHITELIST.add(code));
  FEED_MAP = {};
  for (const [code, meta] of Object.entries(CONTRACTS)) {
    FEED_MAP[code] = meta.priceKey;
    FEED_MAP[meta.priceKey] = meta.priceKey;
  }
  logEvent("INFO", "Instruments loaded", Array.from(WHITELIST));

  feedControl.resetSymbolSets(Array.from(WHITELIST));
  ["BINANCE:BTCUSDT", "EURUSD", "USDINR"].forEach(feedControl.markSymbolActive);

  restartFeeds();
}

// ===== FEEDS =====
function restartFeeds() {
  yahooIntervals.forEach(clearInterval);
  yahooIntervals.clear();
  if (finnhubWS) finnhubWS.close();
  startFinnhubWS();

  WHITELIST.forEach(sym => {
    if (sym.startsWith("NSE:")) {
      fetchYahoo(sym);
      const intv = setInterval(() => fetchYahoo(sym), 5000);
      yahooIntervals.set(sym, intv);
    }
  });

  setInterval(() => {
    feedControl.getPollOnlySymbols().forEach(sym => fetchRestPrice(sym));
  }, 5000);
}

function startFinnhubWS() {
  if (reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
    logEvent("FATAL", "Max reconnect attempts reached for Finnhub WS");
    return;
  }

  finnhubWS = new WebSocket(`wss://ws.finnhub.io?token=${FINNHUB_API_KEY}`);
  feedControl.setFinnhubWS(finnhubWS);

  finnhubWS.on("open", () => {
    reconnectAttempts = 0;
    logEvent("INFO", "Connected to Finnhub WS");
    feedControl.getActiveSymbols().forEach(sym => {
      const vendorSymbol = FEED_MAP[sym] || sym;
      finnhubWS.send(JSON.stringify({ type: "subscribe", symbol: vendorSymbol }));
    });
  });

  finnhubWS.on("message", async (msg) => {
    const data = JSON.parse(msg);
    if (data.type === "trade" && Array.isArray(data.data)) {
      for (const t of data.data) {
        const symbol = Object.keys(FEED_MAP).find(k => FEED_MAP[k] === t.s) || t.s;
        if (MARKET_HOURS_ENFORCEMENT && !isMarketOpen(symbol)) continue;
        const now = Date.now();
        if (now - t.t > STALE_PRICE_MS) continue;
        lastPriceTimestamp.set(symbol, now);
        priceCache.set(symbol, { price: t.p, ts: t.t });
        await processTick(symbol, t.p);
        await evaluateOpenPositions(symbol, t.p);
        throttledBroadcast({ type: "price", symbol, price: t.p, ts: t.t });
      }
    }
  });

  finnhubWS.on("close", () => {
    reconnectAttempts++;
    const delay = Math.min(5000 * reconnectAttempts, 60000);
    logEvent("WARN", `Finnhub WS closed — retrying in ${delay / 1000}s`);
    setTimeout(startFinnhubWS, delay);
  });

  finnhubWS.on("error", (err) => {
    logEvent("ERR", "Finnhub WS error", err.message);
    finnhubWS.close();
  });
}

async function fetchYahoo(symbol) {
  try {
    const yahooMap = { "NSE:NIFTY": "^NSEI", "NSE:BANKNIFTY": "^NSEBANK" };
    const yahooSymbol = yahooMap[symbol];
    const res = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${yahooSymbol}?interval=1m`);
    if (!res.ok) throw new Error(`Yahoo HTTP ${res.status}`);
    const data = await res.json();
    const price = data?.chart?.result?.[0]?.meta?.regularMarketPrice ?? null;
    if (price && price > 0) {
      if (MARKET_HOURS_ENFORCEMENT && !isMarketOpen(symbol)) return;
      priceCache.set(symbol, { price, ts: Date.now() });
      await processTick(symbol, price);
      await evaluateOpenPositions(symbol, price);
      throttledBroadcast({ type: "price", symbol, price, ts: Date.now() });
    }
  } catch (err) {
    logEvent("ERR", `Yahoo fetch fail ${symbol}`, err.message);
  }
}

async function fetchRestPrice(symbol) {
  const now = Date.now();
  if (backoffMap.has(symbol) && now < backoffMap.get(symbol)) return;
  try {
    const meta = getContracts()[symbol];
    if (!meta) return;
    const vendorSymbol = meta.priceKey || symbol;
    const res = await fetch(`https://finnhub.io/api/v1/quote?symbol=${vendorSymbol}&token=${FINNHUB_API_KEY}`);
    if (res.status === 429) {
      const nextTry = now + 30000;
      backoffMap.set(symbol, nextTry);
      logEvent("WARN", `Backoff ${symbol} until ${new Date(nextTry).toISOString()}`);
      return;
    }
    if (!res.ok) throw new Error(`Finnhub HTTP ${res.status}`);
    const data = await res.json();
    if (typeof data.c === "number" && data.c > 0) {
      if (MARKET_HOURS_ENFORCEMENT && !isMarketOpen(symbol)) return;
      priceCache.set(symbol, { price: data.c, ts: Date.now() });
      await processTick(symbol, data.c);
      await evaluateOpenPositions(symbol, data.c);
      throttledBroadcast({ type: "price", symbol, price: data.c, ts: Date.now() });
    }
  } catch (err) {
    logEvent("ERR", `REST fetch fail ${symbol}`, err.message);
  }
}

// ===== MARKET HOURS =====
function isMarketOpen(symbol) {
  const cache = marketOpenCache.get(symbol);
  const now = Date.now();
  if (cache && now - cache.ts < 60000) return cache.isOpen;

  const meta = getContracts()[symbol];
  if (!meta?.tradingHours) return true;
  const nowIST = dayjs().tz("Asia/Kolkata");
  const nowHour = nowIST.hour() + nowIST.minute() / 60;
  const open = nowHour >= meta.tradingHours.start && nowHour <= meta.tradingHours.end;
  marketOpenCache.set(symbol, { ts: now, isOpen: open });
  return open;
}

// ===== THROTTLED BROADCAST =====
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

// ===== AUTH =====
async function verifyAuth(req, res, next) {
  if (DEV_MODE) return next();
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: "Missing Authorization" });
  const token = authHeader.replace("Bearer ", "");
  try {
    const { data, error } = await supabaseAdmin.auth.getUser(token);
    if (error || !data?.user) return res.status(401).json({ error: "Invalid token" });
    req.user = data.user;
    next();
  } catch (err) {
    res.status(401).json({ error: err.message });
  }
}

// ===== ROUTES =====
app.use("/", placeOrderRoute);
app.use("/executeOrder", verifyAuth, placeOrderRoute);

// ===== WS =====
const wss = new WebSocket.Server({ noServer: true });
function heartbeat() { this.isAlive = true; }
function broadcast(msg) {
  try {
    const data = JSON.stringify(msg);
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(data);
    }
  } catch (err) {
    logEvent("ERR", "Broadcast error", err.message);
  }
}
setBroadcaster(broadcast);

// ===== SERVER START =====
const server = app.listen(PORT, async () => {
  logEvent("START", `Price server running on port ${PORT}`);
  try {
    await refreshInstruments();
    await loadInitialData();
    setInterval(refreshInstruments, 10 * 60 * 1000);
  } catch (err) {
    logEvent("ERR", "Startup fail", err.message);
  }
});

server.on("upgrade", async (req, socket, head) => {
  const pathname = url.parse(req.url).pathname;
  const query = url.parse(req.url, true).query;
  const token = query?.token;
  if (pathname === "/ws") {
    if (!token && !DEV_MODE) return socket.destroy();
    if (token && !DEV_MODE) {
      try {
        const { data, error } = await supabaseAdmin.auth.getUser(token);
        if (error || !data?.user) return socket.destroy();
        logEvent("AUTH", `WS user ${data.user.id}`);
      } catch {
        return socket.destroy();
      }
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  } else socket.destroy();
});

wss.on("connection", (ws) => {
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
  WHITELIST.forEach(sym => {
    const cached = priceCache.get(sym);
    if (cached) ws.send(JSON.stringify({ type: "price", symbol: sym, price: cached.price, ts: cached.ts }));
  });
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

module.exports = { markSymbolActive: feedControl.markSymbolActive, markSymbolInactive: feedControl.markSymbolInactive };
