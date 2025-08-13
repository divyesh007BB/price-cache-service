/**
 * Contract meta info for each tradable instrument.
 */
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
  "OANDA:XAU_USD": {
    qtyStep: 0.01,
    minQty: 0.01,
    priceKey: "OANDA:XAU_USD",
    display: "Gold",
    tickValue: 1000,
    convertToINR: true,
    maxLots: { Evaluation: 5, Funded: 10 },
    tradingHours: { start: 0, end: 23 },
    dailyLossLimit: 200000,
    commission: 50,
    spread: 0.3,
  },
  "BINANCE:BTCUSDT": {
    qtyStep: 0.01,
    minQty: 0.01,
    priceKey: "BINANCE:BTCUSDT",
    display: "Bitcoin",
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
};

/**
 * Maps external feed symbols & UI aliases → backend contract key
 */
function normalizeSymbol(symbol) {
  if (!symbol) return "";
  const map = {
    // Feed symbols
    "NSE:NIFTY": "NIFTY",
    "NSENIFTY": "NIFTY",
    "NSE:BANKNIFTY": "BANKNIFTY",
    "NSEBANKNIFTY": "BANKNIFTY",
    "OANDA:XAU_USD": "OANDA:XAU_USD",
    "OANDAXAUUSD": "OANDA:XAU_USD",
    "BINANCE:BTCUSDT": "BINANCE:BTCUSDT",
    "BINANCEBTCUSDT": "BINANCE:BTCUSDT",
    "FX:USDINR": "USDINR",
    "FXUSDINR": "USDINR",

    // UI aliases
    "NIFTY": "NIFTY",
    "BANKNIFTY": "BANKNIFTY",
    "USDINR": "USDINR",
    "XAUUSD": "OANDA:XAU_USD",
    "BTCUSD": "BINANCE:BTCUSDT",
  };

  const upper = symbol.toUpperCase();
  if (map[upper]) return map[upper];

  const stripped = upper.replace(/[:_]/g, "");
  if (map[stripped]) return map[stripped];

  return upper;
}

module.exports = {
  CONTRACTS,
  normalizeSymbol,
};
