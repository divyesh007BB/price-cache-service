// state.js — Shared in-memory state between price server and order routes
// Redis handles all live prices; this file only stores tick history & tradable symbol whitelist

// ===== In-memory structures =====
const WHITELIST = new Set(); // Allowed tradable symbols (normalized)
const tickBuffers = new Map(); // symbol -> array of { ts, price }

// ===== Helper =====
function norm(sym) {
  return typeof sym === "string" ? sym.trim().toUpperCase() : "";
}

// ===== Tick handling =====
function addTick(symbol, price, ts, limit = 50) {
  const sym = norm(symbol);
  if (!sym || typeof price !== "number" || !Number.isFinite(price)) return; // skip invalid ticks

  if (!tickBuffers.has(sym)) {
    tickBuffers.set(sym, []);
  }
  const buf = tickBuffers.get(sym);
  buf.push({ ts: ts || Date.now(), price });
  if (buf.length > limit) buf.shift(); // keep only last 'limit'
}

function getTicks(symbol) {
  const sym = norm(symbol);
  if (!sym) return [];
  return tickBuffers.get(sym) || [];
}

// ===== Whitelist handling =====
function setWhitelist(symbols = []) {
  WHITELIST.clear();
  symbols.forEach((s) => {
    const sym = norm(s);
    if (sym) WHITELIST.add(sym);
  });
}

// ===== Exports =====
module.exports = {
  WHITELIST,
  tickBuffers,
  addTick,
  getTicks,
  setWhitelist,
  norm, // exported for reuse
};
