// riskEngine.js
require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const { getOpenTrades, getAccounts, closeTrade } = require("./matchingEngine");

/**
 * Evaluate open positions for SL, TP, and MIL breaches.
 */
async function evaluateOpenPositions(symbol, tickPrice) {
  try {
    const openPositions = getOpenTrades();
    const accounts = getAccounts();
    const todayISO = new Date().toISOString().split("T")[0]; // today's date only

    // 1️⃣ SL / TP checks
    for (const pos of openPositions) {
      if (pos.symbol !== symbol) continue;

      let shouldClose = false;
      let reason = null;

      // Stop Loss
      if (
        pos.sl &&
        ((pos.side.toLowerCase() === "buy" && tickPrice <= pos.sl) ||
          (pos.side.toLowerCase() === "sell" && tickPrice >= pos.sl))
      ) {
        shouldClose = true;
        reason = "SL Hit";
      }

      // Take Profit
      if (
        !shouldClose &&
        pos.tp &&
        ((pos.side.toLowerCase() === "buy" && tickPrice >= pos.tp) ||
          (pos.side.toLowerCase() === "sell" && tickPrice <= pos.tp))
      ) {
        shouldClose = true;
        reason = "TP Hit";
      }

      if (shouldClose) {
        console.log(`📉 ${reason} — Closing ${pos.id} @ ${tickPrice}`);
        await closeTrade(pos, tickPrice); // matchingEngine handles DB + WS
      }
    }

    // 2️⃣ MIL (Max Intraday Loss) checks
    for (const acc of accounts) {
      if (!acc.max_intraday_loss || acc.status === "blown") continue;

      const { data: todayClosed, error } = await supabase
        .from("trades")
        .select("pnl")
        .eq("account_id", acc.id)
        .eq("status", "closed")
        .gte("closed_at", todayISO);

      if (error) {
        console.error(`❌ Error fetching trades for MIL check: ${error.message}`);
        continue;
      }

      const totalLossToday = todayClosed
        .filter(t => t.pnl < 0)
        .reduce((sum, t) => sum + t.pnl, 0);

      if (Math.abs(totalLossToday) >= acc.max_intraday_loss) {
        console.log(`💀 MIL breached for account ${acc.id} — marking blown & closing all trades`);

        // Mark account as blown
        await supabase
          .from("accounts")
          .update({ status: "blown" })
          .eq("id", acc.id);

        // Close all remaining open trades for this account
        for (const pos of getOpenTrades().filter(p => p.account_id === acc.id)) {
          await closeTrade(pos, tickPrice);
        }
      }
    }
  } catch (err) {
    console.error(`❌ Error in evaluateOpenPositions for ${symbol}:`, err.message);
  }
}

module.exports = { evaluateOpenPositions };
