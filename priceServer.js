// backend/priceServer.js — Lean Binance feed (multi-symbol, free)

require("dotenv").config();
const WebSocket = require("ws");
const { priceCache, WHITELIST, addTick } = require("./backend/state");
const { normalizeSymbol } = require("./backend/symbolMap");
const { processTick } = require("./backend/matchingEngine");

// ===== CONFIG =====
const BINANCE_WS_BASE = "wss://stream.binance.com:9443/stream?streams=";

// ===== INIT WHITELIST =====
WHITELIST.clear();
WHITELIST.add("BINANCE:BTCUSDT"); // ✅ Start BTC only
// later: WHITELIST.add("BINANCE:XAUUSDT"), WHITELIST.add("BINANCE:ETHUSDT"), etc.

function startFeed() {
  const streams = Array.from(WHITELIST)
    .filter((s) => s.startsWith("BINANCE:"))
    .map((s) => `${s.split(":")[1].toLowerCase()}@trade`)
    .join("/");

  const wsUrl = BINANCE_WS_BASE + streams;
  const ws = new WebSocket(wsUrl);

  ws.on("open", () => {
    console.log(`🔗 Binance feed connected for: ${Array.from(WHITELIST).join(", ")}`);
  });

  ws.on("message", (msg) => {
    try {
      const parsed = JSON.parse(msg);
      const stream = parsed.stream;
      const price = parseFloat(parsed.data.p);
      if (!price) return;

      const binanceSymbol = stream.split("@")[0].toUpperCase();
      const symbol = `BINANCE:${binanceSymbol}`;
      priceCache.set(symbol, { price, ts: Date.now() });
      addTick(symbol, price);
      processTick(symbol, price);
    } catch (err) {
      console.error("❌ Binance parse error:", err.message);
    }
  });

  ws.on("close", () => {
    console.warn("⚠ Binance feed closed, reconnecting in 5s...");
    setTimeout(startFeed, 5000);
  });

  ws.on("error", (err) => {
    console.error("❌ Binance feed error:", err.message);
    ws.close();
  });
}

// ===== START =====
startFeed();

module.exports = { startFeed };
