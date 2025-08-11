require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");
const { v4: uuidv4 } = require("uuid");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY // service role key (keep in env, not in repo)
);

let wsBroadcast = () => {};
let accounts = new Map();
let pendingOrders = [];
let openTrades = [];

// 📦 Load accounts, orders, and trades at startup
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
}

function setBroadcaster(broadcastFn) {
  wsBroadcast = broadcastFn;
}

// 📡 Called on every price tick
async function processTick(symbol, price) {
  // Fill pending orders
  const toFill = pendingOrders.filter(
    (o) =>
      o.symbol === symbol &&
      ((o.side === "buy" && price <= o.price) ||
        (o.side === "sell" && price >= o.price))
  );

  for (const order of toFill) {
    await fillOrder(order, price);
  }

  // Close trades hitting SL/TP
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

async function fillOrder(order, fillPrice) {
  console.log(`✅ Filling order ${order.id} @ ${fillPrice}`);

  const trade = {
    id: uuidv4(),
    account_id: order.account_id,
    user_id: order.user_id,
    symbol: order.symbol,
    side: order.side,
    size: order.size,
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
}

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

    // 🔹 Call Risk Engine remotely
    await runRiskEngine(closedTrade, acc);

    wsBroadcast({ type: "account_update", account: acc });
  }

  openTrades = openTrades.filter((t) => t.id !== trade.id);

  wsBroadcast({ type: "trade_close", trade: closedTrade });
}

// 🌐 Call the Supabase Edge Function for Risk Engine
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

module.exports = {
  loadInitialData,
  setBroadcaster,
  processTick,
};
