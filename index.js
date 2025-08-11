require("dotenv").config();
const express = require("express");
const WebSocket = require("ws");
const cors = require("cors");
const fetch = require("node-fetch");
const url = require("url");

const { loadInitialData, processTick, setBroadcaster } = require("./matchingEngine");
const { updateAccountRiskOnTradeClose } = require("./riskEngine");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 4000;
const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY;
const DEV_MODE = process.env.NODE_ENV !== "production";

// ✅ Supported symbols
const WHITELIST = new Set(["BTCUSD", "NIFTY", "BANKNIFTY"]);
const FEED_MAP = {
  BTCUSD: "BINANCE:BTCUSDT"
};

// ✅ Price cache
const priceCache = new Map();
WHITELIST.forEach((s) => priceCache.set(s, { price: 0, ts: Date.now() }));

// ✅ Start server
const server = app.listen(PORT, async () => {
  console.log(`🚀 Price server running on port ${PORT}`);
  try {
    await loadInitialData();
  } catch (err) {
    console.error("❌ Failed to load initial data:", err?.message || err);
  }
});

// ✅ WebSocket
const wss = new WebSocket.Server({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  const { query } = url.parse(req.url, true);
  const token = query.token;
  if (DEV_MODE || token) {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  } else {
    socket.destroy();
  }
});

function heartbeat() { this.isAlive = true; }
wss.on("connection", (ws) => {
  ws.isAlive = true;
  ws.on("pong", heartbeat);
  console.log("🔌 WS client connected");
  ws.send(JSON.stringify({ type: "welcome", symbols: Array.from(WHITELIST) }));
});

setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 25000);

function broadcast(msg) {
  try {
    const data = JSON.stringify(msg);
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data);
      }
    }
  } catch (err) {
    console.error("❌ Broadcast error:", err.message);
  }
}
setBroadcaster(broadcast);

// ✅ REST endpoints
app.get("/health", (_req, res) => res.json({ ok: true }));

app.get("/latest-price/:symbol", (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  if (!WHITELIST.has(symbol)) {
    return res.status(400).json({ error: "Symbol not supported" });
  }
  const row = priceCache.get(symbol);
  if (!row) return res.status(404).json({ error: "No price yet" });
  res.json({ symbol, price: row.price, ts: row.ts });
});

app.get("/prices", (_req, res) => {
  const out = {};
  for (const [k, v] of priceCache.entries()) out[k] = v;
  res.json(out);
});

// ✅ Price polling (BTC from Finnhub, NIFTY & BANKNIFTY from Yahoo)
async function fetchPrice(symbol) {
  const ts = Date.now();
  let price = null;

  try {
    if (symbol === "NIFTY") {
      const res = await fetch("https://query1.finance.yahoo.com/v8/finance/chart/^NSEI?interval=1m");
      if (!res.ok) throw new Error(`Yahoo HTTP ${res.status}`);
      const data = await res.json();
      price = data?.chart?.result?.[0]?.meta?.regularMarketPrice ?? null;
    } else if (symbol === "BANKNIFTY") {
      const res = await fetch("https://query1.finance.yahoo.com/v8/finance/chart/^NSEBANK?interval=1m");
      if (!res.ok) throw new Error(`Yahoo HTTP ${res.status}`);
      const data = await res.json();
      price = data?.chart?.result?.[0]?.meta?.regularMarketPrice ?? null;
    } else if (symbol === "BTCUSD") {
      const vendorSymbol = FEED_MAP[symbol];
      const res = await fetch(`https://finnhub.io/api/v1/quote?symbol=${vendorSymbol}&token=${FINNHUB_API_KEY}`);
      if (!res.ok) throw new Error(`Finnhub HTTP ${res.status}`);
      const data = await res.json();
      if (typeof data.c === "number" && data.c > 0) {
        price = data.c;
      }
    }

    if (price && price > 0) {
      priceCache.set(symbol, { price, ts });
      await processTick(symbol, price);
      broadcast({ type: "price", symbol, price, ts });
      console.log(`💹 ${symbol}: ${price}`);
    }
  } catch (err) {
    console.error(`❌ Price fetch fail ${symbol}:`, err.message);
  }
}

// ✅ Poll every 5 seconds
function startPolling() {
  WHITELIST.forEach(sym => {
    setInterval(() => fetchPrice(sym), 5000);
  });
}
startPolling();

// ✅ Risk Engine
async function handleTradeClose(trade, account) {
  await updateAccountRiskOnTradeClose(trade, account);
  broadcast({ type: "trade_closed", trade });
}

setBroadcaster((msg) => {
  if (msg.type === "trade_closed") {
    handleTradeClose(msg.trade, msg.account);
  } else {
    broadcast(msg);
  }
});

process.on("unhandledRejection", (err) => console.error("🧯 UnhandledRejection:", err));
process.on("uncaughtException", (err) => console.error("🧯 UncaughtException:", err));
