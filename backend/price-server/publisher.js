// publisher.js — Production Price Publisher (Binance → KeyDB, normalized symbols only)
// Run as its own container (aroha-publisher)

require("dotenv").config();
const WebSocket = require("ws");
const Redis = require("ioredis");
const dayjs = require("dayjs");

// ===== CONFIG =====
const redisUrl = process.env.REDIS_URL || "redis://aroha-keydb:6379";
const BINANCE_PAIRS = ["BTCUSDT", "ETHUSDT", "XAUUSDT"];
const PUB_CHANNEL = "price_ticks"; // ticks
const TICK_HISTORY_LIMIT = 1000;
const ORDERBOOK_BATCH_MS = 500;
const HEARTBEAT_TIMEOUT = 15000; // 15s watchdog

// ===== Redis =====
const redis = new Redis(redisUrl, {
  maxRetriesPerRequest: null,
  enableReadyCheck: true,
  retryStrategy: (times) => Math.min(times * 200, 2000),
});

function logEvent(type, msg, extra) {
  console.log(`[${dayjs().format("YYYY-MM-DD HH:mm:ss")}] [${type}] ${msg}`, extra || "");
}

// ===== Normalization =====
function normalizeSymbol(symbol) {
  if (!symbol) return "UNKNOWN";
  const s = symbol.toUpperCase();
  if (s === "BTCUSDT") return "BTCUSD";
  if (s === "ETHUSDT") return "ETHUSD";
  if (s === "XAUUSDT") return "XAUUSD";
  return s;
}

// ===== Local caches =====
let tickHistory = {};
let latestPrices = {};
let orderbookBuffer = {};
let lastMessageTime = Date.now();

// ===== Save Tick =====
function saveTick(symbol, price) {
  const ts = Date.now();
  lastMessageTime = ts; // ✅ update heartbeat
  const normSymbol = normalizeSymbol(symbol);

  if (!tickHistory[normSymbol]) tickHistory[normSymbol] = [];
  tickHistory[normSymbol].push({ price, ts });
  if (tickHistory[normSymbol].length > TICK_HISTORY_LIMIT) {
    tickHistory[normSymbol].shift();
  }
  latestPrices[normSymbol] = { price, ts };

  logEvent("TICK", `${normSymbol} → ${price}`);

  redis
    .publish(
      PUB_CHANNEL,
      JSON.stringify({
        type: "price",
        symbol: normSymbol,
        price,
        ts,
      })
    )
    .then((count) => {
      logEvent("PUB", `Tick ${normSymbol} sent → subs: ${count}`);
    })
    .catch((err) => {
      logEvent("ERROR", `Publish tick ${normSymbol} failed`, err.message);
    });

  redis.hset("latest_prices", normSymbol, JSON.stringify({ price, ts }));
}

// ===== Buffer Orderbook =====
function bufferOrderbook(symbol, bids, asks) {
  const normSymbol = normalizeSymbol(symbol);
  orderbookBuffer[normSymbol] = { bids, asks, ts: Date.now() };
  lastMessageTime = Date.now(); // ✅ update heartbeat
}

// Batch flush orderbooks
setInterval(() => {
  const batch = { ...orderbookBuffer };
  orderbookBuffer = {};
  for (const [sym, ob] of Object.entries(batch)) {
    logEvent("OB", `Publishing orderbook for ${sym}`);
    const channel = `orderbook_${sym}`;
    redis
      .publish(
        channel,
        JSON.stringify({ type: "orderbook", symbol: sym, ...ob })
      )
      .then((count) => {
        logEvent("PUB", `Orderbook ${sym} sent → subs: ${count}`);
      })
      .catch((err) => {
        logEvent("ERROR", `Publish orderbook ${sym} failed`, err.message);
      });

    redis.set(channel, JSON.stringify(ob));
  }
}, ORDERBOOK_BATCH_MS);

// ===== Binance WS =====
function connectBinance() {
  const streams = BINANCE_PAIRS.map((s) => `${s.toLowerCase()}@ticker`).join("/");
  const obStreams = BINANCE_PAIRS.map((s) => `${s.toLowerCase()}@depth20@100ms`).join("/");
  const url = `wss://stream.binance.com:9443/stream?streams=${streams}/${obStreams}`;

  logEvent("INFO", "Connecting Binance WS:", url);
  const ws = new WebSocket(url);

  ws.on("open", () => {
    logEvent("INFO", "✅ Binance connected");
    lastMessageTime = Date.now();
  });

  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (!msg?.data) return;

      const { stream, data: payload } = msg;

      if (stream.includes("@ticker")) {
        const symbol = payload.s;
        const price = parseFloat(payload.c);
        saveTick(symbol, price);
      }

      if (stream.includes("@depth20")) {
        const rawSym = payload.s || stream.split("@")[0].toUpperCase();
        const symbol = normalizeSymbol(rawSym);
        const bids = payload.bids.map(([p, q]) => [parseFloat(p), parseFloat(q)]);
        const asks = payload.asks.map(([p, q]) => [parseFloat(p), parseFloat(q)]);
        bufferOrderbook(symbol, bids, asks);
      }
    } catch (err) {
      logEvent("ERROR", "Parse error", err.message);
    }
  });

  ws.on("close", () => {
    logEvent("WARN", "Binance WS closed, reconnecting in 5s");
    setTimeout(connectBinance, 5000);
  });

  ws.on("error", (err) => {
    logEvent("ERROR", "Binance WS error", err.message);
    ws.close();
  });

  // ✅ Watchdog: reconnect if no data for > HEARTBEAT_TIMEOUT
  setInterval(() => {
    if (Date.now() - lastMessageTime > HEARTBEAT_TIMEOUT) {
      logEvent("WARN", "⚠️ No messages in 15s, reconnecting...");
      try {
        ws.terminate();
      } catch {}
      connectBinance();
    }
  }, 5000);
}

connectBinance();
