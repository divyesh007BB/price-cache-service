// symbolMap.js — Unified Symbols (BTCUSD, ETHUSD, XAUUSD, NIFTY, USDINR)

const { supabaseClient } = require("./supabaseClient"); // ✅ service role client

// ===== Local contract meta (defaults) =====
const CONTRACTS = {
  BTCUSD: {
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
  ETHUSD: {
    qtyStep: 0.01,
    minQty: 0.01,
    priceKey: "BINANCE:ETHUSDT",
    display: "Ethereum (ETH/USD)",
    tickValue: 100,
    convertToINR: false,
    maxLots: { Evaluation: 5, Funded: 10 },
    tradingHours: { start: 0, end: 24 },
    dailyLossLimit: 150000,
    commission: 30,
    spread: 1,
  },
  XAUUSD: {
    qtyStep: 0.01,
    minQty: 0.01,
    priceKey: "BINANCE:XAUUSDT",
    display: "Gold (XAU/USD)",
    tickValue: 1,
    convertToINR: false,
    maxLots: { Evaluation: 5, Funded: 10 },
    tradingHours: { start: 0, end: 24 },
    dailyLossLimit: 100000,
    commission: 30,
    spread: 0.5,
  },
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
  USDINR: {
    qtyStep: 1,
    minQty: 1,
    priceKey: "FX:USDINR",
    display: "USD/INR",
    tickValue: 1,
    convertToINR: false, // ✅ only used for conversion, not tradable
    maxLots: { Evaluation: 0, Funded: 0 },
    tradingHours: { start: 0, end: 24 },
    dailyLossLimit: 0,
    commission: 0,
    spread: 0,
  },
};

// ===== Feed + alias map =====
const FEED_SYMBOL_MAP = {
  // BTC
  "BINANCE:BTCUSDT": "BTCUSD",
  BTCUSD: "BTCUSD",
  BTCUSDT: "BTCUSD",
  BTC: "BTCUSD",

  // ETH
  "BINANCE:ETHUSDT": "ETHUSD",
  ETHUSD: "ETHUSD",
  ETHUSDT: "ETHUSD",

  // GOLD
  "BINANCE:XAUUSDT": "XAUUSD",
  XAUUSD: "XAUUSD",
  GOLD: "XAUUSD",

  // NIFTY
  "NSE:NIFTY": "NIFTY",
  NIFTY: "NIFTY",
  NSENIFTY: "NIFTY",

  // USDINR
  "FX:USDINR": "USDINR",
  USDINR: "USDINR",
};

// ===== Utils =====
function normalizeSymbol(symbol) {
  if (!symbol) return "";
  const upper = symbol.toUpperCase();

  if (FEED_SYMBOL_MAP[upper]) return FEED_SYMBOL_MAP[upper];

  const stripped = upper.replace(/[:_]/g, "");
  if (FEED_SYMBOL_MAP[stripped]) return FEED_SYMBOL_MAP[stripped];

  return upper;
}

function getContracts() {
  return CONTRACTS;
}

function isWithinTradingHours(symbol, now = new Date()) {
  const key = normalizeSymbol(symbol);
  const contract = CONTRACTS[key];
  if (!contract?.tradingHours) return true;

  const utcHours = now.getUTCHours() + now.getUTCMinutes() / 60;
  const { start, end } = contract.tradingHours;

  if (start <= end) {
    return utcHours >= start && utcHours < end;
  } else {
    return utcHours >= start || utcHours < end;
  }
}

async function loadContractsFromDB() {
  const { data, error } = await supabaseClient
    .from("instruments")
    .select("*")
    .eq("is_active", true);

  if (error) {
    console.error("❌ Failed to load instruments:", error.message);
    return;
  }

  if (!data || data.length === 0) {
    console.warn("⚠ No active instruments found in DB, using defaults only");
    return;
  }

  data.forEach((inst) => {
    const key = normalizeSymbol(inst.code);
    if (!key) return;

    if (CONTRACTS[key]) {
      console.warn(`⚠ Overwriting default contract for ${key} with DB values`);
    }

    CONTRACTS[key] = {
      ...CONTRACTS[key],
      qtyStep: inst.qty_step ?? CONTRACTS[key]?.qtyStep,
      minQty: inst.min_qty ?? CONTRACTS[key]?.minQty,
      priceKey: inst.price_key ?? CONTRACTS[key]?.priceKey,
      display: inst.display_name ?? CONTRACTS[key]?.display,
      tickValue: inst.tick_value ?? CONTRACTS[key]?.tickValue,
      convertToINR: inst.convert_to_inr ?? CONTRACTS[key]?.convertToINR ?? false,
      maxLots: inst.max_lots || CONTRACTS[key]?.maxLots || {},
      tradingHours: inst.trading_hours || CONTRACTS[key]?.tradingHours || null,
      dailyLossLimit: inst.daily_loss_limit ?? CONTRACTS[key]?.dailyLossLimit,
      commission: inst.commission ?? CONTRACTS[key]?.commission,
      spread: inst.spread ?? CONTRACTS[key]?.spread,
    };
  });

  console.log(`✅ Loaded ${data.length} contracts from DB`);
}

// ===== Exports =====
module.exports = {
  normalizeSymbol,
  getContracts,
  loadContractsFromDB,
  isWithinTradingHours,
  CONTRACTS,
};
