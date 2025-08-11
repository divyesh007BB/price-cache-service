require("dotenv").config();
const express = require("express");
const WebSocket = require("ws");
const cors = require("cors");
const fetch = require("node-fetch");
const url = require("url");

const { loadInitialData, processTick, setBroadcaster } = require("./matchingEngine");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 4000;
const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY;
const DEV_MODE = process.env.NODE_ENV !== "production";

const WHITELIST = new Set(["BTCUSD"]);
const FEED_MAP = { BTCUSD: "BINANCE:BTCUSDT" };

function normalizeToCanonical(sym) {
  if (!sym) return null;
  const u = String(sym).trim().toUpperCase();
  if (WHITELIST.has(u)) return u;
  switch (u) {
    case "BINANCE:BTCUSDT":
    case "BTCUSDT":
      return "BTCUSD";
    default:
      return null;
  }
}

const priceCache = new Map();
["BTCUSD"].forEach((s) => priceCache.set(s, { price: 0, ts: Date.now() }));

const server = app.listen(PORT, async () => {
  console.log(`🚀 Price server running on port ${PORT}`);
  try {
    await loadInitialData();
  } catch (err) {
    console.error("❌ Failed to load initial data:", err?.message || err);
  }
});

const wss = new WebSocket.Server({ noServer: true });

// ✅ Handle WS upgrade
server.on("upgrade", (req, socket, head) => {
  const { query } = url.parse(req.url, true);
  const token = query.token;

  // Dev mode → no token check
  if (DEV_MODE || token) {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  } else {
    socket.destroy();
  }
});

function heartbeat() {
  this.isAlive = true;
}

wss.on("connection", (ws) => {
  ws.isAlive = true;
  ws.on("pong", heartbeat);

  console.log("🔌 WS client connected");
  ws.send(JSON.stringify({ type: "welcome", symbols: Array.from(WHITELIST) }));

  ws.on("message", (msg) => {
    try {
      const parsed = JSON.parse(msg);
      if (parsed.type === "subscribe" && parsed.symbol) {
        console.log(`📡 Client subscribed to ${parsed.symbol}`);
      }
    } catch (err) {
      console.error("❌ WS parse error:", err.message);
    }
  });

  ws.on("close", () => console.log("⚠️ WS client disconnected"));
  ws.on("error", (err) => console.error("❌ WS client error:", err.message));
});

// ✅ Ping clients to keep alive
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) {
      console.log("⏹ Terminating dead WS");
      return ws.terminate();
    }
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

// REST endpoints
app.get("/health", (_req, res) => res.json({ ok: true }));

app.get("/latest-price/:symbol", (req, res) => {
  const canonical = normalizeToCanonical(req.params.symbol);
  if (!canonical || !WHITELIST.has(canonical)) {
    return res.status(400).json({ error: "Symbol not supported" });
  }
  const row = priceCache.get(canonical);
  if (!row) return res.status(404).json({ error: "No price yet" });
  res.json({ symbol: canonical, price: row.price, ts: row.ts });
});

app.get("/prices", (_req, res) => {
  const out = {};
  for (const [k, v] of priceCache.entries()) out[k] = v;
  res.json(out);
});

// Price polling
async function fetchPrice(symbol) {
  const vendorSymbol = FEED_MAP[symbol];
  if (!vendorSymbol) return;
  try {
    const url = `https://finnhub.io/api/v1/quote?symbol=${vendorSymbol}&token=${FINNHUB_API_KEY}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    if (data && typeof data.c === "number" && data.c > 0) {
      const price = data.c;
      const ts = Date.now();
      priceCache.set(symbol, { price, ts });

      processTick(symbol, price);
      broadcast({ type: "price", symbol, price, ts });
      console.log(`💹 ${symbol}: ${price}`);
    }
  } catch (err) {
    console.error(`❌ Price fetch fail ${symbol}:`, err.message);
  }
}

function startPolling() {
  setInterval(() => fetchPrice("BTCUSD"), 5000);
}
startPolling();

process.on("unhandledRejection", (err) => console.error("🧯 UnhandledRejection:", err));
process.on("uncaughtException", (err) => console.error("🧯 UncaughtException:", err));
