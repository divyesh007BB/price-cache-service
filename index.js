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
const { loadContractsFromDB, getContracts } = require("./symbolMap");

// ✅ Shared state
const { priceCache, WHITELIST } = require("./state");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 4000;
const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY;
const DEV_MODE = process.env.NODE_ENV !== "production";

// ✅ Feed map for fetching vendor prices
let FEED_MAP = {};

// ✅ Load symbols from DB and populate shared state
async function refreshInstruments() {
  await loadContractsFromDB();
  const CONTRACTS = getContracts();
  if (!CONTRACTS || Object.keys(CONTRACTS).length === 0) {
    console.warn("❌ No contracts loaded from DB");
    return;
  }
  WHITELIST.clear();
  Object.keys(CONTRACTS).forEach(code => WHITELIST.add(code));
  FEED_MAP = {};
  for (const [code, meta] of Object.entries(CONTRACTS)) {
    FEED_MAP[code] = meta.priceKey;
    FEED_MAP[meta.priceKey] = meta.priceKey;
  }
  console.log("✅ Instruments loaded into price server:", Array.from(WHITELIST));
}

// ✅ Token verification middleware
async function verifyAuth(req, res, next) {
  if (DEV_MODE) return next();
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: "Missing Authorization" });

  const token = authHeader.replace("Bearer ", "");
  try {
    const { data, error } = await supabaseAdmin.auth.getUser(token);
    if (error || !data?.user) {
      return res.status(401).json({ error: "Invalid token" });
    }
    req.user = data.user;
    next();
  } catch (err) {
    res.status(401).json({ error: err.message });
  }
}

// ✅ Routes
app.use("/", placeOrderRoute);                 // existing root
app.use("/executeOrder", verifyAuth, placeOrderRoute); // direct endpoint with auth

// ✅ WebSocket setup
const wss = new WebSocket.Server({ noServer: true });
function heartbeat() { this.isAlive = true; }

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

// ✅ Server start
const server = app.listen(PORT, async () => {
  console.log(`🚀 Price server running on port ${PORT}`);
  try {
    await refreshInstruments();
    await loadInitialData();
    startPolling();
    setInterval(refreshInstruments, 10 * 60 * 1000);
  } catch (err) {
    console.error("❌ Failed during startup:", err?.message || err);
  }
});

// ✅ WebSocket authentication
server.on("upgrade", async (req, socket, head) => {
  const pathname = url.parse(req.url).pathname;
  const query = url.parse(req.url, true).query;
  const token = query?.token;

  if (pathname === "/ws") {
    if (!token && !DEV_MODE) {
      socket.destroy();
      return;
    }
    if (token && !DEV_MODE) {
      try {
        const { data, error } = await supabaseAdmin.auth.getUser(token);
        if (error || !data?.user) {
          socket.destroy();
          return;
        }
        console.log(`✅ Authenticated user: ${data.user.id}`);
      } catch (err) {
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

  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg?.type === "ping") {
        ws.isAlive = true;
        ws.send(JSON.stringify({ type: "pong" }));
      }
    } catch {}
  });

  ws.on("close", (code, reason) => {
    console.log(`⚠️ WS closed — Code: ${code} Reason: ${reason.toString() || "N/A"}`);
  });
});

setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 25000);

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

// ✅ Start polling prices
function startPolling() {
  if (!WHITELIST || WHITELIST.size === 0) {
    console.warn("⚠️ No symbols in WHITELIST — skipping polling");
    return;
  }
  console.log("📡 Starting price polling for:", Array.from(WHITELIST));
  WHITELIST.forEach(sym => {
    setInterval(() => fetchPrice(sym), 5000);
  });
}

process.on("unhandledRejection", (err) => console.error("🧯 UnhandledRejection:", err));
process.on("uncaughtException", (err) => console.error("🧯 UncaughtException:", err));
