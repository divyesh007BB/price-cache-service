require("dotenv").config();
const express = require("express");
const WebSocket = require("ws");
const cors = require("cors");
const fetch = require("node-fetch");
const url = require("url");
const { createClient } = require("@supabase/supabase-js");

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

// ✅ Supabase credentials
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// ✅ Supabase Admin client for JWT validation
const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

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

// ✅ WebSocket setup
const wss = new WebSocket.Server({ noServer: true });

// WS heartbeat
function heartbeat() { this.isAlive = true; }

// ✅ Handle `/ws` path with JWT validation
server.on("upgrade", async (req, socket, head) => {
  const pathname = url.parse(req.url).pathname;
  const query = url.parse(req.url, true).query;
  const token = query?.token;

  if (pathname === "/ws") {
    // ✅ Require token in production
    if (!token && !DEV_MODE) {
      console.warn("❌ No token provided, closing connection");
      socket.destroy();
      return;
    }

    // ✅ Validate Supabase JWT if present
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

    // ✅ If token valid, accept WS
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
});

setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
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

// ✅ Price fetching
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

      // 1️⃣ Process pending orders
      await processTick(symbol, price);

      // 2️⃣ Check SL/TP
      await evaluateOpenPositions(symbol, price);

      // 3️⃣ Broadcast
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

process.on("unhandledRejection", (err) => console.error("🧯 UnhandledRejection:", err));
process.on("uncaughtException", (err) => console.error("🧯 UncaughtException:", err));
