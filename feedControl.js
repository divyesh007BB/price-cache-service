// feedControl.js — centralizes WS subscription control (no circular deps)
const WebSocket = require("ws");
const { getContracts } = require("./symbolMap");

let ws = null;

// Symbol sets
const activeSymbols = new Set();
let pollOnlySymbols = new Set();

// Point to the active Finnhub WS from index.js
function setFinnhubWS(socket) {
  ws = socket;
}

function vendorSymbolOf(symbol) {
  const meta = getContracts()?.[symbol];
  return meta?.priceKey || symbol;
}

function markSymbolActive(symbol) {
  if (!activeSymbols.has(symbol)) {
    activeSymbols.add(symbol);
    pollOnlySymbols.delete(symbol);
    if (ws && ws.readyState === WebSocket.OPEN) {
      const vendor = vendorSymbolOf(symbol);
      ws.send(JSON.stringify({ type: "subscribe", symbol: vendor }));
      console.log(`📡 Subscribed to ${vendor} on WS`);
    }
  }
}

function markSymbolInactive(symbol) {
  if (activeSymbols.has(symbol)) {
    activeSymbols.delete(symbol);
    pollOnlySymbols.add(symbol);
    if (ws && ws.readyState === WebSocket.OPEN) {
      const vendor = vendorSymbolOf(symbol);
      ws.send(JSON.stringify({ type: "unsubscribe", symbol: vendor }));
      console.log(`📴 Unsubscribed from ${vendor} on WS`);
    }
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
