// symbolMap.js

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
 * Maps external feed symbols → backend contract key
 */
function normalizeSymbol(symbol) {
  if (!symbol) return "";
  const map = {
    "NSE:NIFTY": "NIFTY",
    "NSE:BANKNIFTY": "BANKNIFTY",
    "OANDA:XAU_USD": "OANDA:XAU_USD",
    "BINANCE:BTCUSDT": "BINANCE:BTCUSDT",
    "FX:USDINR": "USDINR",
  };
  return map[symbol] || symbol.toUpperCase();
}

module.exports = {
  CONTRACTS,
  normalizeSymbol,
};
