// backend/symbolMap.js — restricted to NIFTY + BTC for launch
const { supabaseClient } = require("./supabaseClient"); // service role client

// ✅ Local contract meta (only NIFTY + BTC)
const CONTRACTS = {
  NIFTY: {
    qtyStep: 1,
    minQty: 1,
    priceKey: "NSE:NIFTY",
    display: "NIFTY",
    tickValue: 50,
    convertToINR: true,
    maxLots: { Evaluation: 20, Funded: 50 },
    tradingHours: { start: 3.5, end: 10.5 }, // IST hours
    dailyLossLimit: 100000,
    commission: 50,
    spread: 0.5,
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
};

// ✅ Feed + alias map
const FEED_SYMBOL_MAP = {
  "NSE:NIFTY": "NIFTY",
  NSENIFTY: "NIFTY",
  NIFTY: "NIFTY",

  "BINANCE:BTCUSDT": "BINANCE:BTCUSDT",
  BINANCEBTCUSDT: "BINANCE:BTCUSDT",
  BTCUSD: "BINANCE:BTCUSDT",
  BTC: "BINANCE:BTCUSDT",
};

/**
 * Normalize any incoming symbol to internal CONTRACTS key
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
 * Check if a given symbol is tradable at the current time
 */
function isWithinTradingHours(symbol, now = new Date()) {
  const key = normalizeSymbol(symbol);
  const contract = CONTRACTS[key];
  if (!contract?.tradingHours) return true; // default to tradable if no hours set

  const utcHours = now.getUTCHours() + now.getUTCMinutes() / 60;
  return utcHours >= contract.tradingHours.start && utcHours <= contract.tradingHours.end;
}

/**
 * Load all active instruments from Supabase into CONTRACTS
 * — Will still load only NIFTY and BTC if more exist in DB
 */
async function loadContractsFromDB() {
  const { data, error } = await supabaseClient
    .from("instruments")
    .select("*")
    .in("code", ["NIFTY", "BINANCE:BTCUSDT"]) // ✅ only these
    .eq("is_active", true);

  if (error) {
    console.error("❌ Failed to load instruments:", error.message);
    return;
  }

  data.forEach((inst) => {
    const key = inst.code.toUpperCase();
    if (CONTRACTS[key]) {
      console.warn(`⚠ Overwriting default contract for ${key} with DB values`);
    }
    CONTRACTS[key] = {
      ...CONTRACTS[key], // keep defaults for missing fields
      qtyStep: inst.qty_step ?? CONTRACTS[key]?.qtyStep,
      minQty: inst.min_qty ?? CONTRACTS[key]?.minQty,
      priceKey: inst.price_key ?? CONTRACTS[key]?.priceKey,
      display: inst.display_name ?? CONTRACTS[key]?.display,
      tickValue: inst.tick_value ?? CONTRACTS[key]?.tickValue,
      convertToINR: inst.convert_to_inr ?? CONTRACTS[key]?.convertToINR,
      maxLots: inst.max_lots || CONTRACTS[key]?.maxLots || {},
      tradingHours: inst.trading_hours || CONTRACTS[key]?.tradingHours || null,
      dailyLossLimit: inst.daily_loss_limit ?? CONTRACTS[key]?.dailyLossLimit,
      commission: inst.commission ?? CONTRACTS[key]?.commission,
      spread: inst.spread ?? CONTRACTS[key]?.spread,
    };
  });

  console.log(`✅ Loaded ${data.length} contracts from DB (restricted)`);
}

module.exports = {
  normalizeSymbol,
  getContracts,
  loadContractsFromDB,
  isWithinTradingHours,
};
