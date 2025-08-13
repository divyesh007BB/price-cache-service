// backend/symbolMap.js — unified mapping for backend

const { supabaseClient } = require("./supabaseClient"); // service role client if needed

// ✅ Local contract meta (fallback if DB not loaded yet)
const CONTRACTS = {
  NIFTY: {
    qtyStep: 1,
    minQty: 1,
    priceKey: "NSE:NIFTY",
    display: "NIFTY",
    tickValue: 50,
    convertToINR: true,
    maxLots: { Evaluation: 20, Funded: 50 },
    tradingHours: { start: 3.5, end: 10.5 },
    dailyLossLimit: 100000,
    commission: 50,
    spread: 0.5,
  },
  BANKNIFTY: {
    qtyStep: 1,
    minQty: 1,
    priceKey: "NSE:BANKNIFTY",
    display: "BANKNIFTY",
    tickValue: 25,
    convertToINR: true,
    maxLots: { Evaluation: 10, Funded: 30 },
    tradingHours: { start: 3.5, end: 10.5 },
    dailyLossLimit: 150000,
    commission: 50,
    spread: 1,
  },
  "BINANCE:BTCUSDT": {
    qtyStep: 0.01,
    minQty: 0.01,
    priceKey: "BINANCE:BTCUSDT",
    display: "Bitcoin (BTC/USD)",
    tickValue: 2000,
    convertToINR: false,
    maxLots: { Evaluation: 2, Funded: 5 },
    tradingHours: { start: 0, end: 24 },
    dailyLossLimit: 250000,
    commission: 50,
    spread: 5,
  },
  USDINR: {
    qtyStep: 1,
    minQty: 1,
    priceKey: "FX:USDINR",
    display: "USD/INR",
    tickValue: 1000,
    convertToINR: true,
    maxLots: { Evaluation: 50, Funded: 100 },
    tradingHours: { start: 2, end: 10.5 },
    dailyLossLimit: 80000,
    commission: 50,
    spread: 0.02,
  },
  EURUSD: {
    qtyStep: 1,
    minQty: 1,
    priceKey: "FX:EURUSD",
    display: "EUR/USD",
    tickValue: 1000,
    convertToINR: false,
    maxLots: { Evaluation: 50, Funded: 100 },
    tradingHours: { start: 0, end: 24 },
    dailyLossLimit: 100000,
    commission: 50,
    spread: 0.0002,
  },
};

// ✅ Feed + alias map for backend
const FEED_SYMBOL_MAP = {
  "NSE:NIFTY": "NIFTY",
  "NSENIFTY": "NIFTY",
  "NSE:BANKNIFTY": "BANKNIFTY",
  "NSEBANKNIFTY": "BANKNIFTY",
  "FX:USDINR": "USDINR",
  "FXUSDINR": "USDINR",
  "FX:EURUSD": "EURUSD",
  "FXEURUSD": "EURUSD",
  "BINANCE:BTCUSDT": "BINANCE:BTCUSDT",
  "BINANCEBTCUSDT": "BINANCE:BTCUSDT",

  // UI aliases
  NIFTY: "NIFTY",
  BANKNIFTY: "BANKNIFTY",
  USDINR: "USDINR",
  EURUSD: "EURUSD",
  BTCUSD: "BINANCE:BTCUSDT", // important for frontend alias
};

/**
 * Normalize any symbol to internal CONTRACTS key
 */
function normalizeSymbol(symbol) {
  if (!symbol) return "";
  const upper = symbol.toUpperCase();
  if (FEED_SYMBOL_MAP[upper]) return FEED_SYMBOL_MAP[upper];
  const stripped = upper.replace(/[:_]/g, "");
  if (FEED_SYMBOL_MAP[stripped]) return FEED_SYMBOL_MAP[stripped];
  return upper;
}

/**
 * Get all contracts loaded in memory
 */
function getContracts() {
  return CONTRACTS;
}

/**
 * Load all active instruments from Supabase into CONTRACTS
 */
async function loadContractsFromDB() {
  const { data, error } = await supabaseClient
    .from("instruments")
    .select("*")
    .eq("is_active", true);

  if (error) {
    console.error("❌ Failed to load instruments:", error.message);
    return;
  }

  data.forEach((inst) => {
    CONTRACTS[inst.code] = {
      qtyStep: inst.qty_step,
      minQty: inst.min_qty,
      priceKey: inst.price_key,
      display: inst.display_name,
      tickValue: inst.tick_value,
      convertToINR: inst.convert_to_inr,
      maxLots: inst.max_lots || {},
      tradingHours: inst.trading_hours || null,
      dailyLossLimit: inst.daily_loss_limit,
      commission: inst.commission,
      spread: inst.spread,
    };
  });

  console.log(`✅ Loaded ${data.length} contracts from DB`);
}

module.exports = {
  normalizeSymbol,
  getContracts,
  loadContractsFromDB,
};
