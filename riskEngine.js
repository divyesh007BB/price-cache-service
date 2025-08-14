// riskEngine.js — Prop firm grade risk management (upgraded)

require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const { getOpenTrades, getAccounts, closeTrade } = require("./matchingEngine");
const { getContracts } = require("./symbolMap");

const SLTP_GRACE_MS = 1000; // 1s after fill before SL/TP triggers

/**
 * Evaluate all open positions for:
 * - SL/TP hits
 * - Max Intraday Loss (MIL)
 * - Daily Loss Limit
 * - Consistency Rule
 * - Profit Target
 */
async function evaluateOpenPositions(symbol, tickPrice) {
  try {
    const now = Date.now();
    const todayISO = new Date().toISOString().split("T")[0];

    const openPositions = getOpenTrades();
    const accounts = getAccounts();
    const contract = getContracts()[symbol];

    if (!contract) return;

    // 1️⃣ SL / TP checks — spread-aware
    for (const pos of openPositions) {
      if (pos.symbol !== symbol) continue;
      if (now - new Date(pos.time_opened).getTime() < SLTP_GRACE_MS) continue;

      const spreadAdj = contract.spread || 0;
      let shouldClose = false;
      let reason = null;

      // SL check
      if (
        pos.stop_loss != null &&
        ((pos.side === "buy" && tickPrice <= pos.stop_loss - spreadAdj) ||
          (pos.side === "sell" && tickPrice >= pos.stop_loss + spreadAdj))
      ) {
        shouldClose = true;
        reason = "SL Hit";
      }

      // TP check
      if (
        !shouldClose &&
        pos.take_profit != null &&
        ((pos.side === "buy" && tickPrice >= pos.take_profit + spreadAdj) ||
          (pos.side === "sell" && tickPrice <= pos.take_profit - spreadAdj))
      ) {
        shouldClose = true;
        reason = "TP Hit";
      }

      if (shouldClose) {
        console.log(`📉 ${reason} — Closing ${pos.id} @ ${tickPrice}`);
        await closeTrade(pos, tickPrice, reason);
      }
    }

    // 2️⃣ Risk checks (per account)
    for (const acc of accounts) {
      if (acc.status === "blown") continue;

      // Ensure start-of-day equity is set
      if (!acc.start_of_day_equity) {
        await supabase
          .from("accounts")
          .update({ start_of_day_equity: acc.balance })
          .eq("id", acc.id);
        acc.start_of_day_equity = acc.balance;
      }

      // Fetch today's closed trades for this account
      const { data: todayClosed, error } = await supabase
        .from("trades")
        .select("pnl, time_closed")
        .eq("account_id", acc.id)
        .eq("status", "closed")
        .gte("time_closed", todayISO);

      if (error) {
        console.error(`❌ Error fetching trades for account ${acc.id}: ${error.message}`);
        continue;
      }

      const totalLossToday = (todayClosed || [])
        .filter((t) => t.pnl < 0)
        .reduce((sum, t) => sum + t.pnl, 0);

      // === Daily Loss Limit check ===
      const dailyLossLimit =
        contract?.dailyLossLimit || acc.daily_loss_limit || null;
      if (dailyLossLimit && Math.abs(totalLossToday) >= dailyLossLimit) {
        await handleBreach(acc, tickPrice, "DAILY_LOSS_LIMIT");
        continue; // Stop other checks for this account
      }

      // === MIL check ===
      if (acc.max_intraday_loss) {
        const intradayDrawdown = acc.start_of_day_equity - acc.balance;
        if (intradayDrawdown >= acc.max_intraday_loss) {
          await handleBreach(acc, tickPrice, "MAX_INTRADAY_LOSS");
          continue;
        }
      }

      // === Consistency rule check ===
      if (
        acc.total_profit != null &&
        acc.best_day_profit != null &&
        acc.profit_target != null
      ) {
        const ratio = acc.best_day_profit / acc.profit_target;
        if (ratio > 0.5 && !acc.consistency_violated) {
          console.log(`⚠ Consistency rule violated for account ${acc.id}`);
          await supabase
            .from("accounts")
            .update({ consistency_violated: true })
            .eq("id", acc.id);
        }
      }

      // === Profit target hit ===
      if (
        acc.total_profit >= acc.profit_target &&
        acc.status !== "passed" &&
        acc.status !== "blown"
      ) {
        console.log(`🏆 Profit target achieved for account ${acc.id}`);
        await supabase
          .from("accounts")
          .update({ status: "passed" })
          .eq("id", acc.id);
      }
    }
  } catch (err) {
    console.error(`❌ Error in evaluateOpenPositions(${symbol}):`, err.message);
  }
}

/**
 * Handle MIL/Daily Loss breach
 */
async function handleBreach(account, tickPrice, reason) {
  console.log(`💀 ${reason} breached for account ${account.id} — marking blown`);

  await supabase
    .from("accounts")
    .update({ status: "blown", blown_reason: reason })
    .eq("id", account.id);

  const openForAcc = getOpenTrades().filter(
    (p) => p.account_id === account.id
  );
  await Promise.all(
    openForAcc.map((pos) => closeTrade(pos, tickPrice, reason))
  );
}

/**
 * Pre-trade risk validation
 */
async function preTradeRiskCheck(account_id, symbol, qty) {
  const { data: account, error: accErr } = await supabase
    .from("accounts")
    .select("*")
    .eq("id", account_id)
    .single();

  if (accErr || !account) return { ok: false, error: "ACCOUNT_NOT_FOUND" };
  if (account.status === "blown" || account.status === "frozen")
    return { ok: false, error: "ACCOUNT_BLOWN" };

  const contract = getContracts()[symbol];
  if (!contract) return { ok: false, error: "SYMBOL_NOT_SUPPORTED" };

  // Lot size & max lots check
  if (qty < contract.minQty || qty % contract.qtyStep !== 0)
    return { ok: false, error: "INVALID_LOT_SIZE" };
  if (
    contract.maxLots?.[account.account_type] &&
    qty > contract.maxLots[account.account_type]
  )
    return { ok: false, error: "MAX_LOT_SIZE" };

  // Daily loss pre-check
  const todayISO = new Date().toISOString().split("T")[0];
  const { data: todayTrades } = await supabase
    .from("trades")
    .select("pnl")
    .eq("account_id", account_id)
    .eq("status", "closed")
    .gte("time_closed", todayISO);

  const totalLossToday = (todayTrades || [])
    .filter((t) => t.pnl < 0)
    .reduce((sum, t) => sum + t.pnl, 0);

  if (
    contract.dailyLossLimit &&
    Math.abs(totalLossToday) >= contract.dailyLossLimit
  )
    return { ok: false, error: "DAILY_LOSS_LIMIT" };

  return { ok: true };
}

module.exports = {
  evaluateOpenPositions,
  preTradeRiskCheck,
};
