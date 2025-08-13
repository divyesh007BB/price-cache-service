// priceServer.js
require("dotenv").config();
const express = require("express");
const WebSocket = require("ws");
const cors = require("cors");
const fetch = require("node-fetch");
const url = require("url");
const { supabaseAdmin } = require("./config");

const {
  loadInitialData,
  processTick,
  setBroadcaster
} = require("./matchingEngine");
const { evaluateOpenPositions } = require("./riskEngine");
const placeOrderRoute = require("./placeOrder");

const app = express();
app.use(cors());
app.use(express.json());

// ✅ Routes
app.use("/", placeOrderRoute);

const PORT = process.env.PORT || 4000;
const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY;
const DEV_MODE = process.env.NODE_ENV !== "production";

// ✅ Supported symbols (NO GOLD)
const WHITELIST = new Set([
  "BTCUSD",
  "BINANCE:BTCUSDT",
  "NIFTY",
  "BANKNIFTY",
  "USDINR",
  "EURUSD"
]);

// ✅ Map internal/alias → vendor feed symbol
const FEED_MAP = {
  BTCUSD: "BINANCE:BTCUSDT",
  "BINANCE:BTCUSDT": "BINANCE:BTCUSDT",
  NIFTY: "NSE:NIFTY",
  BANKNIFTY: "NSE:BANKNIFTY",
  USDINR: "FX:USDINR",
  EURUSD: "FX:EURUSD"
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

// ✅ WebSocket setup
const wss = new WebSocket.Server({ noServer: true });
function heartbeat() { this.isAlive = true; }

// ✅ WS Auth
server.on("upgrade", async (req, socket, head) => {
  const pathname = url.parse(req.url).pathname;
  const query = url.parse(req.url, true).query;
  const token = query?.token;

  if (pathname === "/ws") {
    if (!token && !DEV_MODE) {
      console.warn("❌ No token provided, closing connection");
      socket.destroy();
      return;
    }

    if (token && !DEV_MODE) {
      try {
        const { data, error } = await supabaseAdmin.auth.getUser(token);
        if (error || !data?.user) {
          console.warn("❌ Invalid token, closing WS");
          socket.destroy();
          return;
        }
        console.log(`✅ Authenticated user: ${data.user.id}`);
      } catch (err) {
        console.error("❌ Token validation error:", err.message);
        socket.destroy();
        return;
      }
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  } else {
    socket.destroy();
  }
});

wss.on("connection", (ws) => {
  ws.isAlive = true;
  ws.on("pong", heartbeat);

  console.log("🔌 WS client connected");
  ws.send(JSON.stringify({ type: "welcome", symbols: Array.from(WHITELIST) }));

  // ✅ Handle JSON pings as backup heartbeat
  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg?.type === "ping") {
        ws.isAlive = true; // treat as manual heartbeat
        ws.send(JSON.stringify({ type: "pong" })); // optional ack for logs
      }
    } catch {
      // Ignore non-JSON messages (likely binary pings)
    }
  });

  ws.on("close", (code, reason) => {
    console.log(`⚠️ WS closed — Code: ${code} Reason: ${reason.toString() || "N/A"}`);
  });
});

// ✅ Server-driven binary ping
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping(); // browser auto-pongs
  });
}, 25000);

// ✅ Broadcast helper
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

// ✅ Normalize incoming request symbols
function normalizeIncomingSymbol(symbol) {
  const upper = symbol.toUpperCase();
  if (WHITELIST.has(upper)) return upper;
  if (FEED_MAP[upper]) return upper;
  return upper;
}

// ✅ REST endpoints
app.get("/health", (_req, res) => res.json({ ok: true }));

app.get("/latest-price/:symbol", (req, res) => {
  let symbol = normalizeIncomingSymbol(req.params.symbol);
  if (!WHITELIST.has(symbol)) {
    return res.status(400).json({ error: `Symbol not supported: ${symbol}` });
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

// ✅ Price fetching logic
async function fetchPrice(symbol) {
  const ts = Date.now();
  let price = null;

  try {
    const vendorSymbol = FEED_MAP[symbol] || symbol;

    if (vendorSymbol.startsWith("NSE:")) {
      const yahooMap = {
        "NSE:NIFTY": "^NSEI",
        "NSE:BANKNIFTY": "^NSEBANK"
      };
      const yahooSymbol = yahooMap[vendorSymbol];
      const res = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${yahooSymbol}?interval=1m`);
      if (!res.ok) throw new Error(`Yahoo HTTP ${res.status}`);
      const data = await res.json();
      price = data?.chart?.result?.[0]?.meta?.regularMarketPrice ?? null;
    } else {
      const res = await fetch(`https://finnhub.io/api/v1/quote?symbol=${vendorSymbol}&token=${FINNHUB_API_KEY}`);
      if (!res.ok) throw new Error(`Finnhub HTTP ${res.status}`);
      const data = await res.json();
      if (typeof data.c === "number" && data.c > 0) price = data.c;
    }

    if (price && price > 0) {
      priceCache.set(symbol, { price, ts });
      await processTick(symbol, price);
      await evaluateOpenPositions(symbol, price);
      broadcast({ type: "price", symbol, price, ts });
      console.log(`💹 ${symbol}: ${price}`);
    }
  } catch (err) {
    console.error(`❌ Price fetch fail ${symbol}:`, err.message);
  }
}

// ✅ Poll all symbols in WHITELIST
function startPolling() {
  WHITELIST.forEach(sym => {
    setInterval(() => fetchPrice(sym), 5000);
  });
}
startPolling();

process.on("unhandledRejection", (err) => console.error("🧯 UnhandledRejection:", err));
process.on("uncaughtException", (err) => console.error("🧯 UncaughtException:", err));
