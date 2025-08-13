// symbolMap.js (works for backend + supabase + frontend if imported correctly)

// ✅ Contract meta info
const CONTRACTS = {
  NIFTY: {
    qtyStep: 1,
    minQty: 1,
    priceKey: "NSE:NIFTY",
    display: "NIFTY",
    tickValue: 50,
    convertToINR: true,
    maxLots: { Evaluation: 20, Funded: 50 },
    tradingHours: { start: 3.5, end: 10.5 }, // UTC hours
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

// ✅ Map external feed & UI symbols → backend normalized keys
const FEED_SYMBOL_MAP = {
  // Feed symbols
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
  BTCUSD: "BINANCE:BTCUSDT",
};

// ✅ Normalize any incoming symbol to match CONTRACTS keys
function normalizeSymbol(symbol) {
  if (!symbol) return "";
  const upper = symbol.toUpperCase();
  if (FEED_SYMBOL_MAP[upper]) return FEED_SYMBOL_MAP[upper];
  const stripped = upper.replace(/[:_]/g, "");
  if (FEED_SYMBOL_MAP[stripped]) return FEED_SYMBOL_MAP[stripped];
  return upper;
}

// ✅ Get display name
function getDisplayName(symbol) {
  const key = normalizeSymbol(symbol);
  return CONTRACTS[key]?.display || key;
}

module.exports = {
  CONTRACTS,
  normalizeSymbol,
  getDisplayName,
};
