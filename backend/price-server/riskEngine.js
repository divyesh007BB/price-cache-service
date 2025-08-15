// riskEngine.js — prop firm grade risk engine
require("dotenv").config();
const dns = require("dns").promises;

const { supabaseClient: supabase } = require("../../shared/supabaseClient");
const { getOpenTrades, getAccounts, closeTrade } = require("./matching-engine/matchingEngine");
const { getContracts } = require("../../shared/symbolMap");

const SLTP_GRACE_MS = 1000;

// DNS resolution for logging (optional)
(async () => {
  try {
    const supabaseHost = new URL(process.env.SUPABASE_URL).hostname;
    const { address } = await dns.lookup(supabaseHost);
    console.log(`🌐 DNS resolved: ${supabaseHost} → ${address}`);
  } catch (e) {
    console.error("❌ DNS resolution failed:", e);
  }
})();

// ---- Retry wrapper ----
async function supabaseQueryWithRetry(queryFn, retries = 5, delayMs = 300) {
  let lastErr;
  for (let i = 0; i < retries; i++) {
    try {
      const { data, error } = await queryFn();
      if (error) throw error;
      return data;
    } catch (err) {
      lastErr = err;
      console.warn(`⚠ Supabase query retry ${i + 1}/${retries} — ${err.message || err}`);
      await new Promise((r) => setTimeout(r, delayMs * Math.pow(2, i)));
    }
  }
  throw lastErr;
}

async function evaluateOpenPositions(symbol, tickPrice) {
  try {
    const now = Date.now();
    const todayISO = new Date().toISOString().split("T")[0];
    const openPositions = getOpenTrades();
    const accounts = getAccounts();
    const contract = getContracts()[symbol];
    if (!contract) return;

    // ---- SL/TP checks ----
    for (const pos of openPositions) {
      if (pos.symbol !== symbol) continue;
      if (now - new Date(pos.time_opened).getTime() < SLTP_GRACE_MS) continue;

      const spreadAdj = contract.spread || 0;
      let shouldClose = false;
      let reason = null;

      if (
        pos.stop_loss != null &&
        ((pos.side === "buy" && tickPrice <= pos.stop_loss - spreadAdj) ||
          (pos.side === "sell" && tickPrice >= pos.stop_loss + spreadAdj))
      ) {
        shouldClose = true;
        reason = "SL Hit";
      }
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

    // ---- Batch risk checks ----
    const accountIds = accounts.map((a) => a.id);
    if (accountIds.length === 0) return;

    const todayStart = `${todayISO}T00:00:00Z`;

    const todayClosed = await supabaseQueryWithRetry(() =>
      supabase
        .from("trades")
        .select("pnl, time_closed, account_id")
        .in("account_id", accountIds)
        .eq("status", "closed")
        .gte("time_closed", todayStart)
    );

    const closedByAccount = {};
    (todayClosed || []).forEach((t) => {
      if (!closedByAccount[t.account_id]) closedByAccount[t.account_id] = [];
      closedByAccount[t.account_id].push(t);
    });

    for (const acc of accounts) {
      if (acc.status === "blown") continue;

      if (!acc.start_of_day_equity) {
        await supabase
          .from("accounts")
          .update({ start_of_day_equity: acc.balance })
          .eq("id", acc.id);
        acc.start_of_day_equity = acc.balance;
      }

      const totalLossToday = (closedByAccount[acc.id] || [])
        .filter((t) => t.pnl < 0)
        .reduce((sum, t) => sum + t.pnl, 0);

      if (
        contract?.dailyLossLimit &&
        Math.abs(totalLossToday) >= contract.dailyLossLimit
      ) {
        await handleBreach(acc, tickPrice, "DAILY_LOSS_LIMIT");
        continue;
      }

      if (acc.max_intraday_loss) {
        const intradayDrawdown = acc.start_of_day_equity - acc.balance;
        if (intradayDrawdown >= acc.max_intraday_loss) {
          await handleBreach(acc, tickPrice, "MAX_INTRADAY_LOSS");
          continue;
        }
      }

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
    console.error(`❌ Error in evaluateOpenPositions(${symbol}):`, err);
  }
}

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

module.exports = { evaluateOpenPositions };
