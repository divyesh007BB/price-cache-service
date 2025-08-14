// matchingEngine.js — Real Prop Firm Execution Engine (NIFTY + BTC version, Redis-powered)

require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");
const { v4: uuidv4 } = require("uuid");
const fetch = require("node-fetch");
const { normalizeSymbol, getContracts, loadContractsFromDB } = require("./symbolMap");
const { addTick } = require("./state");
const { markSymbolActive, markSymbolInactive } = require("./feedControl");
const Redis = require("ioredis");

const redis = new Redis(process.env.REDIS_URL || "redis://localhost:6379");

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// ===== STATE =====
let wsBroadcast = () => {};
let accounts = new Map();
let pendingOrders = [];
let openTrades = [];
let sessionPnL = new Map();
let recentOrders = new Set();
let accountLocks = new Map(); // account_id -> Promise lock

// ===== SETTINGS =====
const EXECUTION_LATENCY_MS = 150;
const SLTP_GRACE_MS = 1000;
const ENABLE_PARTIAL_FILLS = false;
const PARTIAL_FILL_RATIO = 0.5;
const PRICE_STALE_MS = 3000;
const DUPLICATE_ORDER_MS = 500;

// ===== INIT =====
async function loadInitialData() {
  console.log("📦 Loading initial data from Supabase...");
  await loadContractsFromDB();

  const { data: accData, error: accErr } = await supabase.from("accounts").select("*");
  if (accErr) throw accErr;
  accData.forEach(acc => {
    accounts.set(acc.id, acc);
    sessionPnL.set(acc.id, {
      day: todayStr(),
      realized: 0,
      bestDay: acc.best_day_profit ?? 0,
      total: acc.total_profit ?? 0
    });
  });

  const { data: poData, error: poErr } = await supabase
    .from("orders")
    .select("*")
    .eq("status", "pending");
  if (poErr) throw poErr;
  pendingOrders = poData || [];

  const { data: otData, error: otErr } = await supabase
    .from("trades")
    .select("*")
    .eq("is_open", true);
  if (otErr) throw otErr;
  openTrades = otData || [];

  console.log(
    `✅ Loaded ${accounts.size} accounts, ${pendingOrders.length} pending orders, ${openTrades.length} open trades`
  );
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

function todayStr() {
  return new Date().toISOString().split("T")[0];
}

// ===== PRICE FETCH (NIFTY + BTC only) =====
async function fetchPriceNow(symbol) {
  const contracts = getContracts();
  const meta = contracts[symbol];
  if (!meta) return null;

  let price = null;

  try {
    const vendorSymbol = meta.priceKey || symbol;
    if (vendorSymbol.startsWith("NSE:")) {
      // ✅ Yahoo Finance for NIFTY
      const yahooMap = { "NSE:NIFTY": "^NSEI" };
      const yahooSymbol = yahooMap[vendorSymbol];
      if (!yahooSymbol) return null;
      const res = await fetch(
        `https://query1.finance.yahoo.com/v8/finance/chart/${yahooSymbol}?interval=1m`
      );
      const data = await res.json();
      price = data?.chart?.result?.[0]?.meta?.regularMarketPrice ?? null;
    } else if (vendorSymbol === "BINANCE:BTCUSDT") {
      // ✅ Binance REST for BTC
      const res = await fetch("https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT");
      const data = await res.json();
      price = parseFloat(data.price);
    }

    if (price && price > 0) {
      await redis.set(`price:${symbol}`, JSON.stringify({ price, ts: Date.now() }));
      addTick(symbol, price, Date.now());
      return price;
    }
  } catch (err) {
    console.error(`❌ fetchPriceNow fail ${symbol}:`, err.message);
  }
  return null;
}

// ===== PRICE TICK PROCESS =====
async function processTick(symbol, price) {
  const normSymbol = normalizeSymbol(symbol);

  await redis.set(`price:${normSymbol}`, JSON.stringify({ price, ts: Date.now() }));
  addTick(normSymbol, price, Date.now()); // ✅ push into history buffer
  wsBroadcast({ type: "price", symbol: normSymbol, price, ts: Date.now() });

  // Unrealized PnL updates
  openTrades
    .filter(t => t.symbol === normSymbol)
    .forEach(t => {
      const tickValue = getContracts()[t.symbol]?.tickValue ?? 1;
      const upnl =
        t.side === "buy"
          ? (price - t.entry_price) * t.quantity * tickValue
          : (t.entry_price - price) * t.quantity * tickValue;
      wsBroadcast({ type: "trade_upnl", trade_id: t.id, upnl });
    });

  // Limit fills
  const toFill = pendingOrders.filter(
    o =>
      o.symbol === normSymbol &&
      ((o.side === "buy" && price <= o.limit_price) ||
        (o.side === "sell" && price >= o.limit_price))
  );
  for (const order of toFill) await fillOrder(order, price);

  // SL/TP closes
  const toClose = openTrades.filter(t => {
    if (t.symbol !== normSymbol) return false;
    if (Date.now() - new Date(t.time_opened).getTime() < SLTP_GRACE_MS) return false;
    if (t.side === "buy") {
      return (
        (t.stop_loss != null && price <= t.stop_loss) ||
        (t.take_profit != null && price >= t.take_profit)
      );
    } else {
      return (
        (t.stop_loss != null && price >= t.stop_loss) ||
        (t.take_profit != null && price <= t.take_profit)
      );
    }
  });
  for (const trade of toClose) await closeTrade(trade, price);
}

// ===== CENTRAL RISK CHECK =====
async function preTradeRiskCheck(order, account) {
  if (!account) return { ok: false, reason: "ACCOUNT_NOT_FOUND" };
  if (account.status === "blown" || account.status === "paused")
    return { ok: false, reason: "ACCOUNT_INACTIVE" };

  const contract = getContracts()[order.symbol];
  if (!contract) return { ok: false, reason: "UNSUPPORTED_SYMBOL" };

  if (order.size < contract.minQty || order.size % contract.qtyStep !== 0)
    return { ok: false, reason: "INVALID_QTY" };

  if (
    contract.maxLots?.[account.account_type] &&
    order.size > contract.maxLots[account.account_type]
  )
    return { ok: false, reason: "MAX_LOT_SIZE" };

  if (await breachesLossLimits(account)) return { ok: false, reason: "DAILY_LOSS_LIMIT" };

  if (!withinTradingHours(order.symbol)) return { ok: false, reason: "MARKET_CLOSED" };

  return { ok: true };
}

// ===== PLACE ORDER =====
async function placeOrder(order) {
  order.symbol = normalizeSymbol(order.symbol);

  const hash = `${order.account_id}-${order.symbol}-${order.side}-${order.size}-${order.type}`;
  if (recentOrders.has(hash)) return rejectOrder(order, "DUPLICATE_ORDER");
  recentOrders.add(hash);
  setTimeout(() => recentOrders.delete(hash), DUPLICATE_ORDER_MS);

  const account = accounts.get(order.account_id);
  const riskCheck = await preTradeRiskCheck(order, account);
  if (!riskCheck.ok) return rejectOrder(order, riskCheck.reason);

  markSymbolActive(order.symbol);

  if (order.type === "market") {
    let cachedData = await redis.get(`price:${order.symbol}`);
    let cached = cachedData ? JSON.parse(cachedData) : null;

    if (!cached?.price || Date.now() - cached.ts > PRICE_STALE_MS) {
      const live = await fetchPriceNow(order.symbol);
      if (live) cached = { price: live, ts: Date.now() };
    }
    if (!cached?.price) return rejectOrder(order, "NO_LIVE_PRICE");

    const execPrice = await convertPrice(order.symbol, cached.price);
    const orderId = uuidv4();
    await insertOrder(orderId, order, "market");
    await fillOrder({ ...order, id: orderId }, execPrice);
  } else {
    const orderId = uuidv4();
    pendingOrders.push({ ...order, id: orderId });
    wsBroadcast({ type: "order_pending", order: { ...order, id: orderId } });
    broadcastSnapshot();
    await insertOrder(orderId, order, "limit");
  }
}

// ===== FILL ORDER =====
async function fillOrder(order, basePrice) {
  const lock = accountLocks.get(order.account_id) || Promise.resolve();
  accountLocks.set(
    order.account_id,
    lock.then(async () => {
      setTimeout(async () => {
        const contract = getContracts()[order.symbol];
        const spread = contract?.spread || 0;
        const commission = contract?.commission || 0;
        const slippage = contract?.slippage || 0;
        const execPrice =
          order.side === "buy"
            ? basePrice + spread + slippage
            : basePrice - spread - slippage;

        const sizeToFill = ENABLE_PARTIAL_FILLS
          ? Math.ceil(order.size * PARTIAL_FILL_RATIO)
          : order.size;

        const trade = {
          id: uuidv4(),
          account_id: order.account_id,
          user_id: order.user_id,
          symbol: order.symbol,
          side: order.side,
          quantity: sizeToFill,
          entry_price: execPrice,
          stop_loss: order.stop_loss ?? null,
          take_profit: order.take_profit ?? null,
          is_open: true,
          status: "open",
          time_opened: new Date().toISOString(),
          pnl: -commission * sizeToFill,
        };

        pendingOrders = pendingOrders.filter(o => o.id !== order.id);
        openTrades.push(trade);
        markSymbolActive(order.symbol);
        wsBroadcast({ type: "trade_fill", trade });
        broadcastSnapshot();

        if (order.id) {
          await supabase
            .from("orders")
            .update({
              status: "filled",
              entry_price: execPrice,
              filled_at: new Date().toISOString(),
            })
            .eq("id", order.id);
        }
        await supabase.from("trades").insert(trade);
        await auditLog("ORDER_FILLED", { order, trade });
      }, EXECUTION_LATENCY_MS);
    })
  );
}

// ===== CLOSE TRADE =====
async function closeTrade(trade, closePrice) {
  const tickValue = getContracts()[trade.symbol]?.tickValue ?? 1;
  const pnl =
    trade.side === "buy"
      ? (closePrice - trade.entry_price) * trade.quantity * tickValue
      : (trade.entry_price - closePrice) * trade.quantity * tickValue;
  const netPnL = pnl + (trade.pnl || 0);

  const closedTrade = {
    ...trade,
    is_open: false,
    status: "closed",
    time_closed: new Date().toISOString(),
    exit_price: closePrice,
    pnl: netPnL,
  };

  openTrades = openTrades.filter(t => t.id !== trade.id);
  wsBroadcast({ type: "trade_close", trade: closedTrade });
  broadcastSnapshot();
  await supabase.from("trades").update(closedTrade).eq("id", trade.id);

  const acc = accounts.get(trade.account_id);
  if (acc) {
    acc.current_balance += netPnL;

    let sess = sessionPnL.get(acc.id);
    if (!sess || sess.day !== todayStr()) {
      sess = { day: todayStr(), realized: 0, bestDay: 0, total: 0 };
    }
    sess.realized += netPnL;
    sess.total += netPnL;
    if (sess.realized > sess.bestDay) sess.bestDay = sess.realized;
    sessionPnL.set(acc.id, sess);

    if (acc.profit_target && sess.bestDay > acc.profit_target * 0.5) {
      acc.consistency_required = true;
    }

    accounts.set(acc.id, acc);
    wsBroadcast({ type: "account_update", account: acc });

    await supabase
      .from("accounts")
      .update({
        current_balance: acc.current_balance,
        best_day_profit: sess.bestDay,
        total_profit: sess.total,
        consistency_required: acc.consistency_required ?? false,
      })
      .eq("id", acc.id);

    await checkMIL(acc, closePrice);
  }

  const stillActive =
    pendingOrders.some(o => o.symbol === trade.symbol) ||
    openTrades.some(t => t.symbol === trade.symbol);
  if (!stillActive) markSymbolInactive(trade.symbol);

  await auditLog("TRADE_CLOSED", { trade: closedTrade });
}

// ===== HELPERS =====
async function breachesLossLimits(account) {
  const sess = sessionPnL.get(account.id);
  if (!sess) return false;
  if (account.max_intraday_loss && Math.abs(sess.realized) >= account.max_intraday_loss) {
    return true;
  }
  return false;
}

async function checkMIL(acc, price) {
  if (await breachesLossLimits(acc)) {
    console.log(`💀 MIL breached for account ${acc.id} — marking blown`);
    await supabase
      .from("accounts")
      .update({ status: "blown", breach_reason: "MAX_INTRADAY_LOSS" })
      .eq("id", acc.id);
    for (const pos of openTrades.filter(p => p.account_id === acc.id)) {
      await closeTrade(pos, price);
    }
  }
}

function rejectOrder(order, code) {
  wsBroadcast({ type: "order_reject", order, reason: code });
  auditLog("ORDER_REJECTED", { order, reason: code });
}

async function insertOrder(id, order, type) {
  await supabase.from("orders").insert({
    id,
    account_id: order.account_id,
    user_id: order.user_id,
    symbol: order.symbol,
    side: order.side,
    quantity: order.size,
    order_type: type,
    limit_price: order.limit_price ?? null,
    stop_loss: order.stop_loss ?? null,
    take_profit: order.take_profit ?? null,
    status: type === "market" ? "new" : "pending",
    created_at: new Date().toISOString(),
  });
}

async function auditLog(event, payload) {
  await supabase.from("trade_audit_logs").insert({
    id: uuidv4(),
    event,
    payload,
    created_at: new Date().toISOString(),
  });
}

async function convertPrice(symbol, price) {
  const meta = getContracts()[symbol];
  if (meta?.convertToINR) {
    const usdInrRaw = await redis.get("price:USDINR");
    const usdInr = usdInrRaw ? JSON.parse(usdInrRaw).price : 83;
    return price * usdInr;
  }
  return price;
}

function withinTradingHours(symbol) {
  const now = new Date();
  const nowIST = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  const hours = nowIST.getHours() + nowIST.getMinutes() / 60;
  const contract = getContracts()[symbol];
  if (!contract?.tradingHours) return true;
  return hours >= contract.tradingHours.start && hours <= contract.tradingHours.end;
}

// ===== GETTERS =====
function getOpenTrades() {
  return openTrades;
}

function getAccounts() {
  return Array.from(accounts.values());
}

function getPendingOrders() {
  return pendingOrders;
}

// ===== EXPORTS =====
module.exports = {
  loadInitialData,
  setBroadcaster,
  processTick,
  placeOrder,
  fillOrder,
  closeTrade,
  getOpenTrades,
  getAccounts,
  getPendingOrders,
};
