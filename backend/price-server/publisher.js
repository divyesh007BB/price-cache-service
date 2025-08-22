// publisher.js — Production Price Publisher (Binance → Redis)
// ✅ Run this as a separate service, NOT inside price-server.

require("dotenv").config();
const WebSocket = require("ws");
const Redis = require("ioredis");
const fetch = require("node-fetch");
const dayjs = require("dayjs");

// ===== CONFIG =====
const redisUrl = process.env.REDIS_URL;
const BINANCE_PAIRS = ["BTCUSDT", "ETHUSDT", "XAUUSDT"]; // add more later
const PUB_CHANNEL = "price_ticks";
const ORDERBOOK_CHANNEL = "orderbook_updates";
const TICK_HISTORY_LIMIT = 1000; // keep last 1000 ticks per symbol
const ORDERBOOK_BATCH_MS = 500;  // batch orderbook updates every 500ms

// ===== Redis =====
const redis = new Redis(redisUrl, {
  maxRetriesPerRequest: null,
  enableReadyCheck: true,
  retryStrategy: (times) => Math.min(times * 200, 2000),
});

function logEvent(type, msg, extra) {
  console.log(`[${dayjs().format("YYYY-MM-DD HH:mm:ss")}] [${type}] ${msg}`, extra || "");
}

// ===== Price History Cache =====
const tickHistory = {}; // { symbol: [ {price, ts}, ... ] }
const latestPrices = {}; // { symbol: {price, ts} }
const orderbookBuffer = {}; // batch OB updates

// ===== Save tick to Redis =====
async function saveTick(symbol, price) {
  const ts = Date.now();
  const normSymbol = `BINANCE:${symbol}`;

  // keep memory cache
  if (!tickHistory[normSymbol]) tickHistory[normSymbol] = [];
  tickHistory[normSymbol].push({ price, ts });
  if (tickHistory[normSymbol].length > TICK_HISTORY_LIMIT) {
    tickHistory[normSymbol].shift();
  }
  latestPrices[normSymbol] = { price, ts };

  // publish to Redis
  await redis.publish(
    PUB_CHANNEL,
    JSON.stringify({ type: "price", symbol: normSymbol, price, ts })
  );

  // save latest to hash for new clients
  await redis.hset("latest_prices", normSymbol, JSON.stringify({ price, ts }));
}

// ===== Save orderbook to Redis (batched) =====
function bufferOrderbook(symbol, bids, asks) {
  const normSymbol = `BINANCE:${symbol}`;
  orderbookBuffer[normSymbol] = { bids, asks, ts: Date.now() };
}

setInterval(async () => {
  const batch = { ...orderbookBuffer };
  orderbookBuffer = {};
  for (const [sym, ob] of Object.entries(batch)) {
    await redis.publish(
      ORDERBOOK_CHANNEL,
      JSON.stringify({ type: "orderbook", symbol: sym, ...ob })
    );
  }
}, ORDERBOOK_BATCH_MS);

// ===== Connect to Binance WS =====
function connectBinance() {
  const streams = BINANCE_PAIRS.map((s) => `${s.toLowerCase()}@ticker`).join("/");
  const obStreams = BINANCE_PAIRS.map((s) => `${s.toLowerCase()}@depth20@100ms`).join("/");
  const url = `wss://stream.binance.com:9443/stream?streams=${streams}/${obStreams}`;

  logEvent("INFO", "Connecting Binance WS:", url);
  const ws = new WebSocket(url);

  ws.on("open", () => {
    logEvent("INFO", "✅ Binance connected");
  });

  ws.on("message", async (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (!msg?.data) return;

      const stream = msg.stream;
      const payload = msg.data;

      // --- Ticker ---
      if (stream.includes("@ticker")) {
        const symbol = payload.s;
        const price = parseFloat(payload.c);
        await saveTick(symbol, price);
      }

      // --- Orderbook ---
      if (stream.includes("@depth20")) {
        const symbol = payload.s;
        const bids = payload.bids.map(([p, q]) => [parseFloat(p), parseFloat(q)]);
        const asks = payload.asks.map(([p, q]) => [parseFloat(p), parseFloat(q)]);
        bufferOrderbook(symbol, bids, asks);
      }
    } catch (err) {
      logEvent("ERROR", "Parse error", err);
    }
  });

  ws.on("close", () => {
    logEvent("WARN", "Binance WS closed, reconnecting in 5s");
    setTimeout(connectBinance, 5000);
  });

  ws.on("error", (err) => {
    logEvent("ERROR", "Binance WS error", err);
    ws.close();
  });
}

connectBinance();
