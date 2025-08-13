// matchingEngine.js — Real prop firm style execution (with live-fetch fallback)

require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");
const { v4: uuidv4 } = require("uuid");
const fetch = require("node-fetch");
const { normalizeSymbol, getContracts, loadContractsFromDB } = require("./symbolMap");
const { priceCache } = require("./state");

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

let wsBroadcast = () => {};
let accounts = new Map();
let pendingOrders = [];
let openTrades = [];

// ===== SETTINGS =====
const EXECUTION_LATENCY_MS = 150;
const ENABLE_PARTIAL_FILLS = false;
const PARTIAL_FILL_RATIO = 0.5;
const SLTP_GRACE_MS = 1000;
const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY;
// ====================

// 📦 Load initial state from DB
async function loadInitialData() {
  console.log("📦 Loading initial data from Supabase...");
  await loadContractsFromDB();

  const { data: accData, error: accErr } = await supabase.from("accounts").select("*");
  if (accErr) throw accErr;
  accData.forEach(acc => accounts.set(acc.id, acc));

  const { data: poData, error: poErr } = await supabase.from("orders").select("*").eq("status", "pending");
  if (poErr) throw poErr;
  pendingOrders = (poData || []).map(o => ({ ...o, symbol: normalizeSymbol(o.symbol) }));

  const { data: otData, error: otErr } = await supabase.from("trades").select("*").eq("is_open", true);
  if (otErr) throw otErr;
  openTrades = (otData || []).map(t => ({ ...t, symbol: normalizeSymbol(t.symbol) }));

  console.log(`✅ Loaded ${accounts.size} accounts, ${pendingOrders.length} pending orders, ${openTrades.length} open trades`);
  broadcastSnapshot();
}

function setBroadcaster(broadcastFn) {
  wsBroadcast = broadcastFn;
}

function broadcastSnapshot() {
  wsBroadcast({
    type: "sync_state",
    accounts: Array.from(accounts.values()),
    pendingOrders,
    openTrades,
  });
}

// 📡 Live fetch fallback for price
async function fetchPriceNow(symbol) {
  const contracts = getContracts();
  const meta = contracts[symbol];
  if (!meta) return null;

  const ts = Date.now();
  let price = null;
  const vendorSymbol = meta.priceKey || symbol;

  try {
    if (vendorSymbol.startsWith("NSE:")) {
      const yahooMap = {
        "NSE:NIFTY": "^NSEI",
        "NSE:BANKNIFTY": "^NSEBANK"
      };
      const yahooSymbol = yahooMap[vendorSymbol];
      if (!yahooSymbol) return null;
      const res = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${yahooSymbol}?interval=1m`);
      if (!res.ok) throw new Error(`Yahoo HTTP ${res.status}`);
      const data = await res.json();
      price = data?.chart?.result?.[0]?.meta?.regularMarketPrice ?? null;
    } else {
      const res = await fetch(`https://finnhub.io/api/v1/quote?symbol=${vendorSymbol}&token=${FINNHUB_API_KEY}`);
      if (!res.ok) throw new Error(`Finnhub HTTP ${res.status}`);
      const data = await res.json();
      if (typeof data.c === "number" && data.c > 0) price = data.c;
    }

    if (price && price > 0) {
      priceCache.set(symbol, { price, ts });
      return price;
    }
  } catch (err) {
    console.error(`❌ fetchPriceNow fail ${symbol}:`, err.message);
  }
  return null;
}

// 📡 Price tick handler
async function processTick(symbol, price) {
  const normSymbol = normalizeSymbol(symbol);
  priceCache.set(normSymbol, { price, ts: Date.now() });

  wsBroadcast({ type: "price", symbol: normSymbol, price, ts: Date.now() });

  // Fill pending limits
  const toFill = pendingOrders.filter(o =>
    o.symbol === normSymbol &&
    ((o.side === "buy" && price <= o.limit_price) ||
     (o.side === "sell" && price >= o.limit_price))
  );
  for (const order of toFill) {
    await fillOrder(order, price);
  }

  // SL/TP checks
  const toClose = openTrades.filter(t => {
    if (t.symbol !== normSymbol) return false;
    if (Date.now() - new Date(t.time_opened).getTime() < SLTP_GRACE_MS) return false;
    if (t.side === "buy") {
      if (t.stop_loss != null && price <= t.stop_loss) return true;
      if (t.take_profit != null && price >= t.take_profit) return true;
    } else {
      if (t.stop_loss != null && price >= t.stop_loss) return true;
      if (t.take_profit != null && price <= t.take_profit) return true;
    }
    return false;
  });
  for (const trade of toClose) {
    await closeTrade(trade, price);
  }
}

// 📥 Place new order
async function placeOrder(order) {
  order.symbol = normalizeSymbol(order.symbol);
  const account = accounts.get(order.account_id);
  const contract = getContracts()[order.symbol];
  if (!contract) return console.warn(`❌ Symbol not supported: ${order.symbol}`);
  if (!withinTradingHours(order.symbol)) return console.warn(`❌ Market closed for ${order.symbol}`);

  if (account && contract.maxLots?.[account.account_type]) {
    const maxAllowed = contract.maxLots[account.account_type];
    if (order.size > maxAllowed) {
      return console.warn(`❌ Order exceeds max lots for ${order.symbol} (${order.size} > ${maxAllowed})`);
    }
  }

  if (order.type === "market") {
    let cached = priceCache.get(order.symbol);
    if (!cached?.price) {
      console.warn(`⚠ No cached price for ${order.symbol}, fetching live...`);
      const live = await fetchPriceNow(order.symbol);
      if (live) cached = { price: live, ts: Date.now() };
    }
    if (!cached?.price) return console.error(`❌ Still no live price for ${order.symbol}`);
    const execPrice = convertPrice(order.symbol, cached.price);
    const orderId = order.id || uuidv4();

    supabase.from("orders").insert({
      id: orderId,
      account_id: order.account_id,
      user_id: order.user_id,
      symbol: order.symbol,
      side: order.side,
      quantity: order.size,
      order_type: "market",
      status: "new",
      created_at: new Date().toISOString()
    }).catch(err => console.error("Order insert error:", err));

    await fillOrder({ ...order, id: orderId }, execPrice);
  } else {
    const orderId = order.id || uuidv4();
    pendingOrders.push({ ...order, id: orderId });
    wsBroadcast({ type: "order_pending", order: { ...order, id: orderId } });
    broadcastSnapshot();

    supabase.from("orders").insert({
      id: orderId,
      account_id: order.account_id,
      user_id: order.user_id,
      symbol: order.symbol,
      side: order.side,
      quantity: order.size,
      order_type: "limit",
      limit_price: order.limit_price,
      stop_loss: order.sl ?? null,
      take_profit: order.tp ?? null,
      status: "pending",
      created_at: new Date().toISOString(),
    }).catch(err => console.error("Limit order insert error:", err));
  }
}

// 📊 Fill order into a trade
async function fillOrder(order, basePrice) {
  order.symbol = normalizeSymbol(order.symbol);
  setTimeout(() => {
    const contract = getContracts()[order.symbol];
    const spread = contract?.spread || 0;
    const commission = contract?.commission || 0;
    const execPrice = order.side === "buy" ? basePrice + spread : basePrice - spread;
    const sizeToFill = ENABLE_PARTIAL_FILLS ? Math.ceil(order.size * PARTIAL_FILL_RATIO) : order.size;

    const trade = {
      id: uuidv4(),
      account_id: order.account_id,
      user_id: order.user_id,
      symbol: order.symbol,
      side: order.side,
      quantity: sizeToFill,
      entry_price: execPrice,
      stop_loss: order.sl ?? null,
      take_profit: order.tp ?? null,
      is_open: true,
      status: "open",
      time_opened: new Date().toISOString(),
      pnl: -commission * sizeToFill
    };

    pendingOrders = pendingOrders.filter(o => o.id !== order.id);
    openTrades.push(trade);

    wsBroadcast({ type: "trade_fill", trade });
    broadcastSnapshot();

    if (order.id) {
      supabase.from("orders").update({
        status: "filled",
        entry_price: execPrice,
        filled_at: new Date().toISOString()
      }).eq("id", order.id).catch(err => console.error("Order update error:", err));
    }
    supabase.from("trades").insert(trade).catch(err => console.error("Trade insert error:", err));

    console.log(`✅ Filled order ${order.id} at ${execPrice}`);
  }, EXECUTION_LATENCY_MS);
}

// 📉 Close a trade
async function closeTrade(trade, closePrice) {
  trade.symbol = normalizeSymbol(trade.symbol);
  const tickValue = getContracts()[trade.symbol]?.tickValue ?? 1;
  const pnl = trade.side === "buy"
    ? (closePrice - trade.entry_price) * trade.quantity * tickValue
    : (trade.entry_price - closePrice) * trade.quantity * tickValue;
  const netPnL = pnl + (trade.pnl || 0);

  const closedTrade = { ...trade, is_open: false, status: "closed", time_closed: new Date().toISOString(), exit_price: closePrice, pnl: netPnL };

  openTrades = openTrades.filter(t => t.id !== trade.id);
  wsBroadcast({ type: "trade_close", trade: closedTrade });
  broadcastSnapshot();

  supabase.from("trades").update(closedTrade).eq("id", trade.id).catch(err => console.error("Trade update error:", err));

  const acc = accounts.get(trade.account_id);
  if (acc) {
    acc.current_balance += netPnL;
    accounts.set(acc.id, acc);
    wsBroadcast({ type: "account_update", account: acc });

    supabase.from("accounts").update({ current_balance: acc.current_balance }).eq("id", acc.id).catch(err => console.error("Account update error:", err));
    runRiskEngine(closedTrade, acc);

    if (acc.max_intraday_loss) {
      const today = new Date().toISOString().split("T")[0];
      supabase.from("trades")
        .select("pnl")
        .eq("account_id", acc.id)
        .eq("status", "closed")
        .gte("time_closed", today)
        .then(({ data, error }) => {
          if (!error) {
            const totalLossToday = data.filter(t => t.pnl < 0).reduce((sum, t) => sum + t.pnl, 0);
            if (Math.abs(totalLossToday) >= acc.max_intraday_loss) {
              console.log(`💀 MIL breached for account ${acc.id} — marking blown`);
              supabase.from("accounts").update({ status: "blown" }).eq("id", acc.id);
              for (const pos of openTrades.filter(p => p.account_id === acc.id)) {
                closeTrade(pos, closePrice);
              }
            }
          }
        });
    }
  }
}

// 🌐 Risk Engine hook
async function runRiskEngine(trade, account) {
  try {
    const res = await fetch(`${process.env.SUPABASE_URL}/functions/v1/riskEngine`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
      },
      body: JSON.stringify({ trade, account }),
    });
    if (!res.ok) console.error(`❌ Risk Engine failed: ${res.status} ${await res.text()}`);
    else console.log(`📊 Risk Engine executed for account ${account.id}`);
  } catch (err) {
    console.error("❌ Error calling riskEngine:", err);
  }
}

function convertPrice(symbol, price) {
  const meta = getContracts()[symbol];
  if (meta?.convertToINR) {
    const usdInr = priceCache.get("USDINR")?.price ?? 83;
    return price * usdInr;
  }
  return price;
}

function withinTradingHours(symbol) {
  const nowUTC = new Date();
  const hours = nowUTC.getUTCHours() + nowUTC.getUTCMinutes() / 60;
  const contract = getContracts()[symbol];
  if (!contract?.tradingHours) return true;
  return hours >= contract.tradingHours.start && hours <= contract.tradingHours.end;
}

function getOpenTrades() {
  return openTrades;
}
function getAccounts() {
  return Array.from(accounts.values());
}
function getPendingOrders() {
  return pendingOrders;
}

module.exports = {
  loadInitialData,
  setBroadcaster,
  processTick,
  placeOrder,
  fillOrder,
  closeTrade,
  getOpenTrades,
  getAccounts,
  getPendingOrders
};
