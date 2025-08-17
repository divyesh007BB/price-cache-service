// riskEngine.js — Prop firm grade risk engine (Topstep style)
// Rules: Trailing Drawdown, Static Max Loss, Daily Loss Limit (toggle), Consistency Rule, Slippage, Partial Fills
require("dotenv").config();
const dns = require("dns").promises;

const { supabaseClient: supabase } = require("../../shared/supabaseClient");
const { getOpenTrades, getAccounts, closeTrade } = require("../matching-engine/matchingEngine");
const { getContracts } = require("../../shared/symbolMap");

const SLTP_GRACE_MS = 1000;

// DNS resolution logging
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

// ✅ Slippage model (realistic)
function applySlippage(entryPrice, tickPrice, side, liquidityGap = 0) {
  let slippage = entryPrice * 0.0001; // 0.01%
  if (liquidityGap > 0) slippage += liquidityGap * 0.25;
  return side === "buy" ? tickPrice + slippage : tickPrice - slippage;
}

// ✅ Partial fill model
function applyPartialFill(size, contract) {
  if (!contract?.allowPartialFills) return { filled: size, remaining: 0 };
  const ratio = contract.partialFillRatio || 0.5;
  const filled = Math.max(1, Math.floor(size * ratio));
  const remaining = size - filled;
  return { filled, remaining };
}

// ✅ Pre-trade risk validation
async function preTradeRiskCheck(accountId, symbol, size) {
  try {
    const { data: account, error } = await supabase
      .from("accounts")
      .select("*")
      .eq("id", accountId)
      .single();

    if (error || !account) return { ok: false, error: "ACCOUNT_NOT_FOUND" };
    if (["blown", "suspended"].includes(account.status)) {
      return { ok: false, error: "ACCOUNT_INACTIVE" };
    }

    // Lot size check
    const contract = getContracts()[symbol];
    if (contract?.maxLots && size > contract.maxLots.Evaluation) {
      return { ok: false, error: "MAX_LOT_SIZE" };
    }

    // Trading hours check
    if (contract?.tradingHours) {
      const now = new Date();
      const hour = now.getUTCHours();
      const { start, end } = contract.tradingHours;
      if (hour < start || hour >= end) {
        return { ok: false, error: "MARKET_CLOSED" };
      }
    }

    return { ok: true };
  } catch (err) {
    console.error("❌ preTradeRiskCheck error:", err);
    return { ok: false, error: "RISK_ENGINE_ERROR" };
  }
}

// ✅ Immediate risk evaluation after a fill
async function evaluateImmediateRisk(accountId, symbol, size, execPrice) {
  try {
    const { data: account, error } = await supabase
      .from("accounts")
      .select("*")
      .eq("id", accountId)
      .single();

    if (error || !account) return { ok: false, error: "ACCOUNT_NOT_FOUND" };
    if (["blown", "suspended"].includes(account.status)) {
      return { ok: false, error: "ACCOUNT_INACTIVE" };
    }

    // Lot size check
    const contract = getContracts()[symbol];
    if (contract?.maxLots && size > contract.maxLots.Evaluation) {
      return { ok: false, error: "MAX_LOT_SIZE" };
    }

    // Static Max Loss
    if (account.max_loss && account.current_balance <= account.start_balance - account.max_loss) {
      return { ok: false, error: "MAX_LOSS" };
    }

    // Trailing Drawdown
    if (account.trail_drawdown) {
      const peak = account.peak_balance || account.start_balance;
      const ddFloor = Math.max(
        account.start_balance - account.trail_drawdown,
        peak - account.trail_drawdown
      );
      if (account.current_balance <= ddFloor) {
        return { ok: false, error: "TRAILING_DRAWDOWN" };
      }
    }

    return { ok: true };
  } catch (err) {
    console.error("❌ evaluateImmediateRisk error:", err);
    return { ok: false, error: "RISK_ENGINE_ERROR" };
  }
}

// ✅ Runtime evaluation of open positions + risk checks
async function evaluateOpenPositions(symbol, tickPrice) {
  try {
    const now = Date.now();
    const openPositions = getOpenTrades();
    const accounts = getAccounts();
    const contract = getContracts()[symbol];
    if (!contract) return;

    // ---- SL/TP checks ----
    for (const pos of openPositions) {
      if (pos.symbol !== symbol) continue;
      if (now - new Date(pos.time_opened).getTime() < SLTP_GRACE_MS) continue;

      let shouldClose = false;
      let reason = null;

      if (
        pos.stop_loss != null &&
        ((pos.side === "buy" && tickPrice <= pos.stop_loss) ||
          (pos.side === "sell" && tickPrice >= pos.stop_loss))
      ) {
        shouldClose = true;
        reason = "SL Hit";
      }
      if (
        !shouldClose &&
        pos.take_profit != null &&
        ((pos.side === "buy" && tickPrice >= pos.take_profit) ||
          (pos.side === "sell" && tickPrice <= pos.take_profit))
      ) {
        shouldClose = true;
        reason = "TP Hit";
      }

      if (shouldClose) {
        const exitPx = applySlippage(pos.entry_price, tickPrice, pos.side);
        console.log(`📉 ${reason} — Closing ${pos.id} @ ${exitPx}`);
        await closeTrade(pos, exitPx, reason);
      }
    }

    // ---- Account-level risk checks ----
    for (const acc of accounts) {
      if (acc.status === "blown") continue;

      // Static Max Loss
      if (acc.max_loss && acc.balance <= acc.start_balance - acc.max_loss) {
        await handleBreach(acc, tickPrice, "MAX_LOSS");
        continue;
      }

      // Daily Loss Limit
      if (acc.daily_loss_limit && acc.daily_loss_limit > 0) {
        const today = new Date().toISOString().split("T")[0];
        const { data: pnlData } = await supabase
          .from("trades")
          .select("SUM(pnl) as dayPnl")
          .eq("account_id", acc.id)
          .gte("closed_at", `${today}T00:00:00.000Z`)
          .lte("closed_at", `${today}T23:59:59.999Z`);

        const dayPnl = pnlData?.[0]?.dayPnl ?? 0;
        if (dayPnl <= -acc.daily_loss_limit) {
          await handleBreach(acc, tickPrice, "DAILY_LOSS_LIMIT");
          continue;
        }
      }

      // Trailing Drawdown
      if (acc.trail_drawdown) {
        let ddLevel;
        if (acc.status === "passed" || acc.trailing_dd_mode === "FROZEN") {
          ddLevel = (acc.peak_balance || acc.start_balance) - acc.trail_drawdown;
        } else {
          const peak = acc.peak_balance || acc.start_balance;
          const newPeak = Math.max(peak, acc.balance);
          if (newPeak !== peak) {
            await supabase.from("accounts").update({ peak_balance: newPeak }).eq("id", acc.id);
            acc.peak_balance = newPeak;
          }
          const ddFloor = acc.start_balance - acc.trail_drawdown;
          ddLevel = Math.max(ddFloor, newPeak - acc.trail_drawdown);
        }
        if (acc.balance <= ddLevel) {
          await handleBreach(acc, tickPrice, "TRAILING_DRAWDOWN");
          continue;
        }
      }

      // Consistency Rule
      const bestDay = acc.best_day_profit || 0;
      const consistencyFlag =
        acc.profit_target > 0 && bestDay > acc.profit_target * 0.5;

      if (consistencyFlag && !acc.consistency_flag) {
        console.log(`⚠ Consistency violation flagged for account ${acc.id}`);
        await supabase.from("accounts").update({ consistency_flag: true }).eq("id", acc.id);
        acc.consistency_flag = true;
      } else if (!consistencyFlag && acc.consistency_flag) {
        console.log(`✅ Consistency restored for account ${acc.id}`);
        await supabase.from("accounts").update({ consistency_flag: false }).eq("id", acc.id);
        acc.consistency_flag = false;
      }

      // Profit Target
      if (
        acc.total_profit >= acc.profit_target &&
        acc.status !== "passed" &&
        acc.status !== "blown"
      ) {
        if (acc.consistency_flag) {
          console.log(`🚧 Profit target hit but consistency violated for ${acc.id}`);
          continue;
        }
        console.log(`🏆 Profit target + consistency achieved for account ${acc.id}`);
        await supabase
          .from("accounts")
          .update({ status: "passed", trailing_dd_mode: "FROZEN" })
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

  const openForAcc = getOpenTrades().filter((p) => p.account_id === account.id);
  await Promise.all(
    openForAcc.map((pos) => {
      const exitPx = applySlippage(pos.entry_price, tickPrice, pos.side);
      return closeTrade(pos, exitPx, reason);
    })
  );
}

module.exports = { 
  evaluateOpenPositions, 
  preTradeRiskCheck, 
  evaluateImmediateRisk,   // ✅ added
  applySlippage, 
  applyPartialFill 
};
