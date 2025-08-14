// backend/priceServer.js — Lean Feed for NIFTY + BTC only

require("dotenv").config();
const WebSocket = require("ws");
const fetch = require("node-fetch");

const { priceCache, WHITELIST } = require("./state");
const { normalizeSymbol } = require("./symbolMap");
const { processTick } = require("./matchingEngine");

// ===== CONFIG =====
const YAHOO_MAP = { "NSE:NIFTY": "^NSEI" };
const YAHOO_INTERVAL_MS = 60_000; // Yahoo free ~1min update
const BINANCE_WS_URL = "wss://stream.binance.com:9443/ws/btcusdt@trade";

// ===== INIT =====
WHITELIST.add("NIFTY");
WHITELIST.add("BINANCE:BTCUSDT");

function startFeed() {
  startYahooNifty();
  startBinanceBTC();
  console.log("✅ Lean price feed started (NIFTY + BTC only)");
}

// ===== YAHOO FINANCE (NIFTY) =====
async function fetchYahooPrice(yahooSymbol) {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${yahooSymbol}?interval=1m`;
    const res = await fetch(url);
    const data = await res.json();
    return data?.chart?.result?.[0]?.meta?.regularMarketPrice ?? null;
  } catch (err) {
    console.error(`❌ Yahoo fetch fail for ${yahooSymbol}:`, err.message);
    return null;
  }
}

function startYahooNifty() {
  const yahooSymbol = YAHOO_MAP["NSE:NIFTY"];
  if (!yahooSymbol) return console.error("❌ No Yahoo mapping for NIFTY");

  const poll = async () => {
    const price = await fetchYahooPrice(yahooSymbol);
    if (price) {
      const symbol = "NIFTY";
      priceCache.set(symbol, { price, ts: Date.now() });
      processTick(symbol, price);
    }
  };

  poll();
  setInterval(poll, YAHOO_INTERVAL_MS);
}

// ===== BINANCE (BTC) =====
function startBinanceBTC() {
  const ws = new WebSocket(BINANCE_WS_URL);

  ws.on("open", () => {
    console.log("🔗 Binance BTC feed connected");
  });

  ws.on("message", (msg) => {
    try {
      const data = JSON.parse(msg);
      if (!data.p) return;
      const price = parseFloat(data.p);
      const symbol = "BINANCE:BTCUSDT";
      priceCache.set(symbol, { price, ts: Date.now() });
      processTick(symbol, price);
    } catch (err) {
      console.error("❌ Binance BTC parse error:", err.message);
    }
  });

  ws.on("close", () => {
    console.warn("⚠ Binance BTC feed closed, reconnecting in 5s...");
    setTimeout(startBinanceBTC, 5000);
  });

  ws.on("error", (err) => {
    console.error("❌ Binance BTC feed error:", err.message);
    ws.close();
  });
}

// ===== START =====
startFeed();

module.exports = { startFeed };
