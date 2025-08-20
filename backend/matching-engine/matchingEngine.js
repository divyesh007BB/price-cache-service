// backend/matching-engine/matchingEngine.js — Real Prop Firm Execution Engine (Topstep/FTMO style)

require("dotenv").config();
const { v4: uuidv4 } = require("uuid");
const fetch = require("node-fetch");
const Redis = require("ioredis");

const redis = new Redis(process.env.REDIS_URL || "redis://127.0.0.1:6379", {
  maxRetriesPerRequest: null,
  enableReadyCheck: true,
  retryStrategy: (times) => Math.min(times * 200, 2000),
});

const { normalizeSymbol, getContracts, loadContractsFromDB } = require("../shared/symbolMap");
const { addTick } = require("../shared/state");
const { markSymbolActive, markSymbolInactive } = require("./feedControl");
const { supabaseClient: supabase } = require("../shared/supabaseClient");

// ✅ Centralized risk logic
const { evaluateOpenPositions, preTradeRiskCheck, evaluateImmediateRisk } = require("../price-server/riskEngine");

// ✅ Shared trade/account state
const {
  getOpenTrades,
  setOpenTrades,
  getAccounts,
  setAccounts,
  addOpenTrade,
  removeOpenTrade,
  updateAccount,
} = require("./tradeState");

// ---------- Local State ----------
let wsBroadcast = () => {};
let pendingOrders = [];
let sessionPnL = new Map();
let recentOrders = new Set();
let accountLocks = new Map();
const latestPrices = {};

// ---------- Constants ----------
const EXECUTION_LATENCY_MS = 150;
const SLTP_GRACE_MS = 1000;
const ENABLE_PARTIAL_FILLS = true;
const PRICE_STALE_MS = 5000;
const DUPLICATE_ORDER_MS = 500;

// ---------- Helpers ----------
function todayStr() {
  return new Date().toISOString().split("T")[0];
}
const safeParse = (raw) => {
  try {
    if (!raw) return null;
    return typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
};

// ===================================
// INIT
// ===================================
async function loadInitialData() {
  console.log("📦 Loading initial data from Supabase...");
  await loadContractsFromDB();

  const { data: accData, error: accErr } = await supabase.from("accounts").select("*");
  if (accErr) throw accErr;
  const accMap = new Map();
  accData.forEach((acc) => {
    accMap.set(acc.id, acc);
    sessionPnL.set(acc.id, {
      day: todayStr(),
      realized: 0,
      bestDay: acc.best_day_profit ?? 0,
      total: acc.total_profit ?? 0,
    });
  });
  setAccounts(Array.from(accMap.values()));

  const { data: poData } = await supabase.from("orders").select("*").eq("status", "pending");
  pendingOrders = poData || [];

  const { data: otData } = await supabase.from("trades").select("*").eq("is_open", true);
  setOpenTrades(otData || []);

  try {
    const all = await redis.hgetall("latest_prices");
    for (const [symbol, val] of Object.entries(all)) {
      latestPrices[symbol] = JSON.parse(val);
    }
    console.log(`✅ Loaded ${Object.keys(latestPrices).length} prices from Redis/KeyDB`);
  } catch (err) {
    console.error("❌ Failed to load initial prices from Redis/KeyDB", err);
  }

  subscribePriceFeed();
  console.log(
    `✅ Loaded ${getAccounts().length} accounts, ${pendingOrders.length} pending orders, ${getOpenTrades().length} open trades`
  );
  broadcastSnapshot();

  // ✅ FIX: return state summary so caller won't see undefined
  return {
    accounts: getAccounts(),
    pendingOrders,
    openTrades: getOpenTrades(),
    prices: latestPrices,
  };
}

function setBroadcaster(fn) {
  wsBroadcast = fn;
}

function broadcastSnapshot() {
  try {
    wsBroadcast({
      type: "sync_state",
      accounts: getAccounts(),
      pendingOrders,
      openTrades: getOpenTrades(),
    });
  } catch {}
}

// ===================================
// PRICE SUBSCRIPTION (Redis Pub/Sub)
// ===================================
async function subscribePriceFeed() {
  const sub = redis.duplicate();
  await sub.subscribe("price_ticks");
  sub.on("message", async (ch, msg) => {
    if (ch === "price_ticks") {
      try {
        const { symbol, price, ts } = JSON.parse(msg);
        latestPrices[symbol] = { price, ts };
        await processTick(symbol, price);
      } catch (err) {
        console.error("❌ Failed to process price tick:", err);
      }
    }
  });
  console.log("📡 Subscribed to Redis/KeyDB 'price_ticks'");
}

// ===================================
// PRICE FETCH (fallback)
// ===================================
async function fetchPriceNow(symbol) {
  const meta = getContracts()[symbol];
  if (!meta) return null;
  let price = null;
  try {
    const vendorSymbol = meta.priceKey || symbol;
    if (vendorSymbol.startsWith("BINANCE:")) {
      const pair = vendorSymbol.replace("BINANCE:", "").toUpperCase();
      const r = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${pair}`);
      const d = await r.json();
      if (d?.price) price = parseFloat(d.price);
    }
    if (price && price > 0) {
      latestPrices[symbol] = { price, ts: Date.now() };
      addTick(symbol, price, Date.now());
      return price;
    }
  } catch (err) {
    console.error(`❌ fetchPriceNow ${symbol}:`, err.message);
  }
  return null;
}

// ===================================
// PROCESS TICK
// ===================================
async function processTick(symbol, price) {
  const norm = normalizeSymbol(symbol);
  const prev = latestPrices[norm]?.price ?? price;
  latestPrices[norm] = { price, ts: Date.now() };
  addTick(norm, price, Date.now());
  try {
    wsBroadcast({ type: "price", symbol: norm, price, ts: Date.now() });
  } catch {}

  // Update unrealized PnL
  getAccounts().forEach((acc) => {
    const accTrades = getOpenTrades().filter((t) => t.account_id === acc.id);
    acc.upnl = accTrades.reduce((sum, t) => {
      const tickVal = getContracts()[t.symbol]?.tickValue ?? 1;
      return (
        sum +
        (t.side === "buy"
          ? (price - t.entry_price) * t.quantity * tickVal
          : (t.entry_price - price) * t.quantity * tickVal)
      );
    }, 0);
    try {
      wsBroadcast({ type: "account_upnl", account_id: acc.id, upnl: acc.upnl });
    } catch {}
  });

  // Fill limit orders
  const toFill = pendingOrders.filter(
    (o) =>
      o.symbol === norm &&
      ((o.side === "buy" && price <= o.limit_price) ||
        (o.side === "sell" && price >= o.limit_price))
  );
  for (const order of toFill) await fillOrder(order, price, prev);

  // SL/TP auto-close
  const toClose = getOpenTrades().filter((t) => {
    if (t.symbol !== norm) return false;
    if (Date.now() - new Date(t.time_opened).getTime() < SLTP_GRACE_MS) return false;
    if (t.side === "buy")
      return (
        (t.stop_loss != null && price <= t.stop_loss) ||
        (t.take_profit != null && price >= t.take_profit)
      );
    return (
      (t.stop_loss != null && price >= t.stop_loss) ||
      (t.take_profit != null && price <= t.take_profit)
    );
  });
  for (const t of toClose) await closeTrade(t, price, "SLTP Trigger");

  await evaluateOpenPositions(norm, price);
}

// ===================================
// PLACE ORDER
// ===================================
async function placeOrder(order) {
  order.symbol = normalizeSymbol(order.symbol);

  const hash = `${order.account_id}-${order.symbol}-${order.side}-${order.quantity}-${order.type}`;
  if (recentOrders.has(hash)) return rejectOrder(order, "DUPLICATE_ORDER");
  recentOrders.add(hash);
  setTimeout(() => recentOrders.delete(hash), DUPLICATE_ORDER_MS);

  const riskCheck = await preTradeRiskCheck(order.account_id, order.symbol, order.quantity);
  if (!riskCheck.ok) return rejectOrder(order, riskCheck.error);

  markSymbolActive(order.symbol);

  if (order.type === "market") {
    let cached = latestPrices[order.symbol];
    if (!cached?.price || Date.now() - cached.ts > PRICE_STALE_MS) {
      const live = await fetchPriceNow(order.symbol);
      if (live) cached = { price: live, ts: Date.now() };
    }
    if (!cached?.price) return rejectOrder(order, "NO_LIVE_PRICE");

    const execPrice = await convertPrice(order.symbol, cached.price);
    const orderId = uuidv4();

    try {
      await supabase.from("orders").insert({
        id: orderId,
        account_id: order.account_id,
        user_id: order.user_id,
        symbol: order.symbol,
        side: order.side,
        quantity: order.quantity,
        order_type: "market",
        entry_price: execPrice,
        status: "filled",
        created_at: new Date().toISOString(),
        filled_at: new Date().toISOString(),
      });
    } catch (err) {
      console.error("❌ Supabase insert orders:", err.message);
    }

    const postRisk = await evaluateImmediateRisk(order.account_id, order.symbol, order.quantity, execPrice);
    if (!postRisk.ok) return rejectOrder(order, postRisk.error);

    await fillOrder({ ...order, id: orderId }, execPrice, cached.price);
  } else {
    const orderId = uuidv4();
    const newOrder = { ...order, id: orderId };
    pendingOrders.push(newOrder);
    try {
      wsBroadcast({ type: "order_pending", order: newOrder });
      await redis.publish("order_events", JSON.stringify({ type: "ORDER_PENDING", order: newOrder }));
    } catch {}
    broadcastSnapshot();
    try {
      await supabase.from("orders").insert({
        id: orderId,
        account_id: order.account_id,
        user_id: order.user_id,
        symbol: order.symbol,
        side: order.side,
        quantity: order.quantity,
        order_type: "limit",
        limit_price: order.limit_price,
        status: "pending",
        created_at: new Date().toISOString(),
      });
    } catch (err) {
      console.error("❌ Supabase insert limit order:", err.message);
    }
  }
}

// ===================================
// FILL ORDER
// ===================================
async function fillOrder(order, basePrice, prevPrice) {
  const lock = accountLocks.get(order.account_id) || Promise.resolve();
  accountLocks.set(
    order.account_id,
    lock.then(async () => {
      await new Promise((r) => setTimeout(r, EXECUTION_LATENCY_MS));

      const c = getContracts()[order.symbol];
      const spread = c?.spread || 0;
      const commission = c?.commission || 0;
      const gap = Math.abs(basePrice - (prevPrice || basePrice));
      const slippage = gap > 0 ? Math.min(gap * 0.2, c?.maxSlippage || 5) : 0;

      const execPrice = order.side === "buy"
        ? basePrice + spread + slippage
        : basePrice - spread - slippage;

      const risk = await evaluateImmediateRisk(order.account_id, order.symbol, order.quantity, execPrice);
      if (!risk.ok) return rejectOrder(order, risk.error);

      const fillQty = ENABLE_PARTIAL_FILLS
        ? Math.max(1, Math.floor(order.quantity * (Math.random() * 0.5 + 0.5)))
        : order.quantity;

      const remainingQty = order.quantity - fillQty;

      const trade = {
        id: uuidv4(),
        account_id: order.account_id,
        user_id: order.user_id,
        symbol: order.symbol,
        side: order.side,
        quantity: fillQty,
        entry_price: execPrice,
        stop_loss: order.stop_loss ?? null,
        take_profit: order.take_profit ?? null,
        is_open: true,
        status: "open",
        time_opened: new Date().toISOString(),
        pnl: -commission * fillQty,
        order_id: order.id,
      };

      pendingOrders = pendingOrders.filter((o) => o.id !== order.id);
      addOpenTrade(trade);

      try {
        wsBroadcast({ type: "trade_fill", trade });
        await redis.publish("trade_events", JSON.stringify({ type: "TRADE_OPENED", trade }));
        await redis.publish("order_events", JSON.stringify({ type: "ORDER_FILLED", order, trade }));
      } catch {}
      broadcastSnapshot();

      try {
        await supabase.from("orders").update({
          status: remainingQty > 0 ? "partially_filled" : "filled",
          entry_price: execPrice,
          filled_at: new Date().toISOString(),
        }).eq("id", order.id);
        await supabase.from("trades").insert(trade);
      } catch (err) {
        console.error("❌ Supabase trade insert:", err.message);
      }

      await auditLog("ORDER_FILLED", { order, trade });

      if (remainingQty > 0) {
        const restOrder = { ...order, id: uuidv4(), quantity: remainingQty };
        pendingOrders.push(restOrder);
        try {
          wsBroadcast({ type: "order_pending", order: restOrder });
          await redis.publish("order_events", JSON.stringify({ type: "ORDER_PENDING", order: restOrder }));
        } catch {}
      }
    })
  );
}

// ===================================
// CLOSE TRADE
// ===================================
async function closeTrade(trade, closePrice, reason = null) {
  const tickValue = getContracts()[trade.symbol]?.tickValue ?? 1;
  const pnl = trade.side === "buy"
    ? (closePrice - trade.entry_price) * trade.quantity * tickValue
    : (trade.entry_price - closePrice) * trade.quantity * tickValue;
  const netPnL = pnl + (trade.pnl || 0);

  const closed = {
    ...trade,
    is_open: false,
    status: "closed",
    exit_price: closePrice,
    pnl: netPnL,
    exit_reason: reason || trade.exit_reason || null,
    time_closed: new Date().toISOString(),
  };

  removeOpenTrade(trade.id);

  try {
    wsBroadcast({ type: "trade_close", trade: closed });
    await redis.publish("trade_events", JSON.stringify({ type: "TRADE_CLOSED", trade: closed, reason }));
  } catch {}
  broadcastSnapshot();

  try {
    await supabase.from("trades").update(closed).eq("id", trade.id);
    if (trade.order_id) {
      await supabase.from("orders").update({
        status: "closed",
        exit_price: closePrice,
        closed_at: new Date().toISOString(),
        exit_reason: reason || null,
      }).eq("id", trade.order_id);
    }
  } catch (err) {
    console.error("❌ Supabase update trade/order:", err.message);
  }

  // update account stats
  const acc = getAccounts().find((a) => a.id === trade.account_id);
  if (acc) {
    acc.current_balance += netPnL;
    let sess = sessionPnL.get(acc.id);
    if (!sess || sess.day !== todayStr()) sess = { day: todayStr(), realized: 0, bestDay: 0, total: 0 };
    sess.realized += netPnL;
    sess.total += netPnL;
    if (sess.realized > sess.bestDay) sess.bestDay = sess.realized;
    sessionPnL.set(acc.id, sess);

    updateAccount(acc.id, acc);

    try {
      wsBroadcast({ type: "account_update", account: acc });
    } catch {}
    try {
      await supabase.from("accounts").update({
        current_balance: acc.current_balance,
        best_day_profit: sess.bestDay,
        total_profit: sess.total,
      }).eq("id", acc.id);
    } catch (err) {
      console.error("❌ Supabase update account:", err.message);
    }
  }

  const stillActive =
    pendingOrders.some((o) => o.symbol === trade.symbol) ||
    getOpenTrades().some((t) => t.symbol === trade.symbol);
  if (!stillActive) markSymbolInactive(trade.symbol);

  await auditLog("TRADE_CLOSED", { trade: closed, reason });
}

// ===================================
// UTILS
// ===================================
function rejectOrder(order, reason) {
  try {
    wsBroadcast({ type: "order_reject", order, reason });
    redis.publish("order_events", JSON.stringify({ type: "ORDER_REJECTED", order, reason }));
  } catch {}
  auditLog("ORDER_REJECTED", { order, reason });
  return { ok: false, reason };
}

async function auditLog(event, payload) {
  try {
    await supabase.from("trade_audit_logs").insert({
      id: uuidv4(),
      event,
      payload: JSON.stringify(payload),
      created_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error("❌ auditLog insert failed:", err.message);
  }
}

async function convertPrice(symbol, price) {
  const meta = getContracts()[symbol];
  if (meta?.convertToINR) {
    const usdInrRaw = latestPrices["USDINR"] || safeParse(await redis.get("price:USDINR"));
    const usdInr = usdInrRaw?.price ?? 83;
    return price * usdInr;
  }
  return price;
}

// ===================================
// EXPORTS
// ===================================
module.exports = {
  loadInitialData,
  setBroadcaster,
  processTick,
  placeOrder,
  fillOrder,
  closeTrade,
  getOpenTrades,
  getAccounts,
};
