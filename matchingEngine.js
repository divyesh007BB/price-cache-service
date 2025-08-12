require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");
const { v4: uuidv4 } = require("uuid");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

let wsBroadcast = () => {};
let accounts = new Map();
let pendingOrders = [];
let openTrades = [];

// Settings
const EXECUTION_LATENCY_MS = 100; // delay to mimic real execution
const ENABLE_PARTIAL_FILLS = false;
const PARTIAL_FILL_RATIO = 0.5;

// 📦 Load accounts, orders, and trades
async function loadInitialData() {
  console.log("📦 Loading initial data from Supabase...");

  const { data: accData, error: accErr } = await supabase
    .from("accounts")
    .select("*");
  if (accErr) throw accErr;
  accData.forEach((acc) => accounts.set(acc.id, acc));

  const { data: poData, error: poErr } = await supabase
    .from("orders")
    .select("*")
    .eq("status", "pending");
  if (poErr) throw poErr;
  pendingOrders = poData || [];

  const { data: otData, error: otErr } = await supabase
    .from("trades")
    .select("*")
    .eq("status", "open");
  if (otErr) throw otErr;
  openTrades = otData || [];

  console.log(
    `✅ Loaded ${accounts.size} accounts, ${pendingOrders.length} pending orders, ${openTrades.length} open trades`
  );

  wsBroadcast({
    type: "sync_state",
    accounts: Array.from(accounts.values()),
    pendingOrders,
    openTrades,
  });
}

function setBroadcaster(broadcastFn) {
  wsBroadcast = broadcastFn;
}

// 📡 On price tick
async function processTick(symbol, price) {
  // Fill eligible limit orders
  const toFill = pendingOrders.filter(
    (o) =>
      o.symbol === symbol &&
      ((o.side === "buy" && price <= o.price) ||
        (o.side === "sell" && price >= o.price))
  );

  for (const order of toFill) {
    await fillOrder(order, price);
  }

  // Check SL/TP for open trades
  const toClose = openTrades.filter((t) => {
    if (t.symbol !== symbol) return false;
    if (t.side === "buy") {
      if (t.sl && price <= t.sl) return true;
      if (t.tp && price >= t.tp) return true;
    } else {
      if (t.sl && price >= t.sl) return true;
      if (t.tp && price <= t.tp) return true;
    }
    return false;
  });

  for (const trade of toClose) {
    await closeTrade(trade, price);
  }
}

// 📥 Place order
async function placeOrder(order) {
  if (order.type === "market") {
    const latestPrice = await getLatestPrice(order.symbol);
    if (!latestPrice) {
      console.error(`❌ No price for ${order.symbol}`);
      return;
    }
    await fillOrder(order, latestPrice);
  } else {
    const { error } = await supabase.from("orders").insert(order);
    if (error) console.error("❌ Error saving order:", error.message);
    else {
      pendingOrders.push(order);
      wsBroadcast({ type: "order_pending", order });
    }
  }
}

// 📊 Fill order
async function fillOrder(order, fillPrice) {
  setTimeout(async () => {
    console.log(`✅ Filling ${order.type} order ${order.id} @ ${fillPrice}`);

    let sizeToFill = order.size;
    if (ENABLE_PARTIAL_FILLS) {
      sizeToFill = Math.ceil(order.size * PARTIAL_FILL_RATIO);
      console.log(`⚠ Partial fill: ${sizeToFill}/${order.size}`);
    }

    const trade = {
      id: uuidv4(),
      account_id: order.account_id,
      user_id: order.user_id,
      symbol: order.symbol,
      side: order.side,
      size: sizeToFill,
      entry: fillPrice,
      sl: order.sl,
      tp: order.tp,
      status: "open",
      opened_at: new Date().toISOString(),
      pnl: 0,
    };

    await supabase.from("orders").update({ status: "filled" }).eq("id", order.id);
    await supabase.from("trades").insert(trade);

    pendingOrders = pendingOrders.filter((o) => o.id !== order.id);
    openTrades.push(trade);

    wsBroadcast({ type: "trade_fill", trade });
  }, EXECUTION_LATENCY_MS);
}

// 📉 Close trade with MIL enforcement
async function closeTrade(trade, closePrice) {
  console.log(`📉 Closing trade ${trade.id} @ ${closePrice}`);

  const pnl =
    trade.side === "buy"
      ? (closePrice - trade.entry) * trade.size
      : (trade.entry - closePrice) * trade.size;

  const closedTrade = {
    ...trade,
    status: "closed",
    closed_at: new Date().toISOString(),
    exit: closePrice,
    pnl,
  };

  await supabase.from("trades").update(closedTrade).eq("id", trade.id);

  const acc = accounts.get(trade.account_id);
  if (acc) {
    acc.current_balance += pnl;
    accounts.set(acc.id, acc);
    await supabase
      .from("accounts")
      .update({ current_balance: acc.current_balance })
      .eq("id", acc.id);

    await runRiskEngine(closedTrade, acc);

    // 💀 MIL check
    if (acc.max_intraday_loss) {
      const today = new Date().toISOString().split("T")[0];
      const { data: todayClosed, error } = await supabase
        .from("trades")
        .select("pnl")
        .eq("account_id", acc.id)
        .eq("status", "closed")
        .gte("closed_at", today);

      if (!error) {
        const totalLossToday = todayClosed
          .filter(t => t.pnl < 0)
          .reduce((sum, t) => sum + t.pnl, 0);

        if (Math.abs(totalLossToday) >= acc.max_intraday_loss) {
          console.log(`💀 MIL breached for account ${acc.id} — marking blown`);

          await supabase
            .from("accounts")
            .update({ status: "blown" })
            .eq("id", acc.id);

          for (const pos of openTrades.filter(
            p => p.account_id === acc.id && p.id !== trade.id
          )) {
            await closeTrade(pos, closePrice);
          }
        }
      }
    }

    wsBroadcast({ type: "account_update", account: acc });
  }

  openTrades = openTrades.filter((t) => t.id !== trade.id);
  wsBroadcast({ type: "trade_close", trade: closedTrade });
}

// 🌐 Risk Engine hook
async function runRiskEngine(trade, account) {
  try {
    const res = await fetch(
      `${process.env.SUPABASE_URL}/functions/v1/riskEngine`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
        },
        body: JSON.stringify({ trade, account }),
      }
    );

    if (!res.ok) {
      const errText = await res.text();
      console.error(`❌ Risk Engine failed: ${res.status} ${errText}`);
    } else {
      console.log(`📊 Risk Engine executed for account ${account.id}`);
    }
  } catch (err) {
    console.error("❌ Error calling riskEngine:", err);
  }
}

// 📈 Latest price
async function getLatestPrice(symbol) {
  const { data, error } = await supabase
    .from("latest_prices")
    .select("price")
    .eq("symbol", symbol)
    .maybeSingle();
  if (error) {
    console.error(`❌ getLatestPrice error: ${error.message}`);
    return null;
  }
  return data?.price ?? null;
}

// ✅ Exports
function getOpenTrades() {
  return openTrades;
}
function getAccounts() {
  return Array.from(accounts.values());
}

module.exports = {
  loadInitialData,
  setBroadcaster,
  processTick,
  placeOrder,
  fillOrder,
  closeTrade,
  getOpenTrades,
  getAccounts
};
