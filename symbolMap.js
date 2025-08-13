// symbolMap.js — CommonJS dynamic loader

const { createClient } = require("@supabase/supabase-js");

let supabase = null;
if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
  supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );
} else {
  console.warn(
    "⚠️ Supabase credentials missing — CONTRACTS will remain empty until loaded."
  );
}

let CONTRACTS = {};
let FEED_SYMBOL_MAP = {};

/**
 * Load instruments from Supabase
 */
async function loadContractsFromDB() {
  if (!supabase) {
    console.warn("⚠️ Skipping instrument load — no Supabase client.");
    return;
  }

  const { data, error } = await supabase
    .from("instruments")
    .select("*")
    .eq("is_active", true);

  if (error) {
    console.error("❌ Failed to load instruments from Supabase:", error.message);
    throw error;
  }

  CONTRACTS = {};
  FEED_SYMBOL_MAP = {};

  data.forEach((row) => {
    CONTRACTS[row.code] = {
      qtyStep: row.lot_step,
      minQty: row.min_qty,
      priceKey: row.feed_code,
      display: row.display_name,
      tickValue: row.tick_value,
      convertToINR: row.convert_to_inr,
      maxLots: { Evaluation: row.max_lots_eval, Funded: row.max_lots_funded },
      tradingHours: row.trading_hours,
      dailyLossLimit: row.daily_loss_limit,
      commission: row.commission,
      spread: row.spread,
    };

    FEED_SYMBOL_MAP[row.feed_code.toUpperCase()] = row.code;
    FEED_SYMBOL_MAP[row.code.toUpperCase()] = row.code;

    FEED_SYMBOL_MAP[row.feed_code.replace(/[:_]/g, "").toUpperCase()] = row.code;
    FEED_SYMBOL_MAP[row.code.replace(/[:_]/g, "").toUpperCase()] = row.code;
  });

  console.log("✅ Loaded instruments:", Object.keys(CONTRACTS));
}

/**
 * Normalize symbol
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
 * Get display name
 */
function getDisplayName(symbol) {
  const key = normalizeSymbol(symbol);
  return CONTRACTS[key]?.display || key;
}

/**
 * Getters to avoid stale exports
 */
function getContracts() {
  return CONTRACTS;
}

function getFeedSymbolMap() {
  return FEED_SYMBOL_MAP;
}

module.exports = {
  getContracts,
  getFeedSymbolMap,
  normalizeSymbol,
  getDisplayName,
  loadContractsFromDB,
};
