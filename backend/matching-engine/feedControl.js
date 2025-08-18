// feedControl.js — centralizes WS subscription control (no circular deps)
const WebSocket = require("ws");
const { getContracts, normalizeSymbol } = require("../shared/symbolMap");

let ws = null;

// Symbol sets
const activeSymbols = new Set();
let pollOnlySymbols = new Set();

// Point to the active vendor WS from index.js
function setFinnhubWS(socket) {
  ws = socket;
}

function vendorSymbolOf(symbol) {
  const norm = normalizeSymbol(symbol);
  const meta = getContracts()?.[norm];
  return meta?.priceKey || norm;
}

function safeSend(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify(msg));
    } catch (err) {
      console.error("❌ feedControl WS send failed:", err.message);
    }
  }
}

function markSymbolActive(symbol) {
  if (!activeSymbols.has(symbol)) {
    activeSymbols.add(symbol);
    pollOnlySymbols.delete(symbol);
    const vendor = vendorSymbolOf(symbol);
    safeSend({ type: "subscribe", symbol: vendor });
    console.log(`[feedControl] 📡 Subscribed to ${vendor}`);
  }
}

function markSymbolInactive(symbol) {
  if (activeSymbols.has(symbol)) {
    activeSymbols.delete(symbol);
    pollOnlySymbols.add(symbol);
    const vendor = vendorSymbolOf(symbol);
    safeSend({ type: "unsubscribe", symbol: vendor });
    console.log(`[feedControl] 📴 Unsubscribed from ${vendor}`);
  }
}

// Helpers for index.js lifecycle
function resetSymbolSets(allSymbols) {
  activeSymbols.clear();
  pollOnlySymbols = new Set(allSymbols);
}

function getActiveSymbols() {
  return activeSymbols;
}
function getPollOnlySymbols() {
  return pollOnlySymbols;
}

module.exports = {
  setFinnhubWS,
  markSymbolActive,
  markSymbolInactive,
  resetSymbolSets,
  getActiveSymbols,
  getPollOnlySymbols,
};
