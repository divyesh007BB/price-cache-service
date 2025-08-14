// state.js — Shared in-memory state between price server and order routes
// Redis handles all live prices, this file now only handles tick history & whitelisted symbols

// ===== In-memory structures =====
const WHITELIST = new Set();    // allowed tradable symbols
const tickBuffers = new Map();  // symbol -> array of { ts, price }

// ===== Functions =====
function addTick(symbol, price, ts, limit = 50) {
  if (!symbol || typeof price !== "number" || !Number.isFinite(price)) {
    // Invalid tick, ignore
    return;
  }
  if (!tickBuffers.has(symbol)) {
    tickBuffers.set(symbol, []);
  }
  const buf = tickBuffers.get(symbol);
  buf.push({ ts: ts || Date.now(), price });
  if (buf.length > limit) buf.shift(); // keep only 'limit' most recent
}

function getTicks(symbol) {
  if (!symbol) return [];
  return tickBuffers.get(symbol) || [];
}

// ===== Exports =====
module.exports = {
  WHITELIST,
  tickBuffers,
  addTick,
  getTicks
};
