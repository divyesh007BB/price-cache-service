// backend/price-server/riskEngine.js — Prop firm grade risk engine (Topstep/FTMO style)
// Rules: Trailing Drawdown, Static Max Loss, Daily Loss Limit, Consistency Rule, Slippage, Partial Fills

require("dotenv").config();
const dns = require("dns").promises;

// ✅ Correct import paths (case-sensitive fix)
const matchingEngine = require("../matching-engine/matchingEngine");
const { supabaseClient: supabase } = require("../shared/supabaseClient");
const { getContracts } = require("../shared/symbolMap");

// Destructure with safety
const { getOpenTrades, getAccounts, closeTrade } = matchingEngine;

// Debug log to confirm exports
console.log("🔍 matchingEngine exports:", Object.keys(matchingEngine));

const SLTP_GRACE_MS = 1000;

// ---- DNS resolution logging ----
(async () => {
  try {
    const supabaseHost = new URL(process.env.SUPABASE_URL).hostname;
    const { address } = await dns.lookup(supabaseHost);
    console.log(`🌐 DNS resolved: ${supabaseHost} → ${address}`);
  } catch (e) {
    console.error("❌ DNS resolution failed:", e.message || e);
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
  console.error("❌ Supabase query failed after retries:", lastErr.message || lastErr);
  throw lastErr;
}

// ✅ Slippage model
function applySlippage(entryPrice, tickPrice, side, liquidityGap = 0) {
  let slippage = entryPrice * 0.0001; // base 0.01%
  if (liquidityGap > 0) slippage += liquidityGap * 0.25;
  return side === "buy" ? tickPrice + slippage : tickPrice - slippage;
}

// ✅ Partial fill model
function applyPartialFill(size, contract) {
  if (!contract?.allowPartialFills) return { filled: size, remaining: 0 };
  const ratio = contract.partialFillRatio || 0.5;
  const filled = Math.max(1, Math.floor(size * ratio));
  return { filled, remaining: size - filled };
}

// ✅ Pre-trade risk validation
async function preTradeRiskCheck(accountId, symbol, size) {
  try {
    const account = await supabaseQueryWithRetry(() =>
      supabase.from("accounts").select("*").eq("id", accountId).single()
    );

    if (!account) return { ok: false, error: "ACCOUNT_NOT_FOUND" };
    if (["blown", "suspended"].includes(account.status)) {
      return { ok: false, error: "ACCOUNT_INACTIVE" };
    }

    const contract = getContracts()[symbol];
    if (contract?.maxLots && size > contract.maxLots.Evaluation) {
      return { ok: false, error: "MAX_LOT_SIZE" };
    }

    if (contract?.tradingHours) {
      const hour = new Date().getUTCHours();
      if (hour < contract.tradingHours.start || hour >= contract.tradingHours.end) {
        return { ok: false, error: "MARKET_CLOSED" };
      }
    }

    return { ok: true };
  } catch (err) {
    console.error("❌ preTradeRiskCheck error:", err.message || err);
    return { ok: false, error: "RISK_ENGINE_ERROR" };
  }
}

// ✅ Immediate risk evaluation after a fill
async function evaluateImmediateRisk(accountId, symbol, size, execPrice) {
  try {
    const account = await supabaseQueryWithRetry(() =>
      supabase.from("accounts").select("*").eq("id", accountId).single()
    );

    if (!account) return { ok: false, error: "ACCOUNT_NOT_FOUND" };
    if (["blown", "suspended"].includes(account.status)) {
      return { ok: false, error: "ACCOUNT_INACTIVE" };
    }

    const contract = getContracts()[symbol];
    if (contract?.maxLots && size > contract.maxLots.Evaluation) {
      return { ok: false, error: "MAX_LOT_SIZE" };
    }

    // ✅ Static Max Loss
    if (account.max_loss && account.current_balance <= account.start_balance - account.max_loss) {
      return { ok: false, error: "MAX_LOSS" };
    }

    // ✅ Trailing Drawdown
    if (account.trail_drawdown) {
      const peak = account.peak_balance || account.start_balance;
      const ddFloor = Math.max(account.start_balance - account.trail_drawdown, peak - account.trail_drawdown);
      if (account.current_balance <= ddFloor) {
        return { ok: false, error: "TRAILING_DRAWDOWN" };
      }
    }

    return { ok: true };
  } catch (err) {
    console.error("❌ evaluateImmediateRisk error:", err.message || err);
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

      if (pos.stop_loss != null &&
        ((pos.side === "buy" && tickPrice <= pos.stop_loss) ||
         (pos.side === "sell" && tickPrice >= pos.stop_loss))) {
        shouldClose = true; reason = "SL Hit";
      }

      if (!shouldClose &&
        pos.take_profit != null &&
        ((pos.side === "buy" && tickPrice >= pos.take_profit) ||
         (pos.side === "sell" && tickPrice <= pos.take_profit))) {
        shouldClose = true; reason = "TP Hit";
      }

      if (shouldClose) {
        const exitPx = applySlippage(pos.entry_price, tickPrice, pos.side);
        console.log(`📉 ${reason} — Closing ${pos.id} @ ${exitPx}`);
        await closeTrade(pos, exitPx, reason);
      }
    }

    // ---- Account-level checks ----
    for (const acc of accounts) {
      if (acc.status === "blown") continue;

      // Static Max Loss
      if (acc.max_loss && acc.current_balance <= acc.start_balance - acc.max_loss) {
        await handleBreach(acc, tickPrice, "MAX_LOSS"); continue;
      }

      // Daily Loss Limit
      if (acc.daily_loss_limit && acc.daily_loss_limit > 0) {
        const today = new Date().toISOString().split("T")[0];
        const trades = await supabaseQueryWithRetry(() =>
          supabase.from("trades")
            .select("pnl, closed_at")
            .eq("account_id", acc.id)
            .gte("closed_at", `${today}T00:00:00.000Z`)
            .lte("closed_at", `${today}T23:59:59.999Z`)
        );
        const dayPnl = (trades || []).reduce((s, t) => s + (t.pnl || 0), 0);
        if (dayPnl <= -acc.daily_loss_limit) {
          await handleBreach(acc, tickPrice, "DAILY_LOSS_LIMIT"); continue;
        }
      }

      // Trailing Drawdown
      if (acc.trail_drawdown) {
        let ddLevel;
        if (acc.status === "passed" || acc.trailing_dd_mode === "FROZEN") {
          ddLevel = (acc.peak_balance || acc.start_balance) - acc.trail_drawdown;
        } else {
          const peak = acc.peak_balance || acc.start_balance;
          const newPeak = Math.max(peak, acc.current_balance);
          if (newPeak !== peak) {
            await supabase.from("accounts").update({ peak_balance: newPeak }).eq("id", acc.id);
            acc.peak_balance = newPeak;
          }
          ddLevel = Math.max(acc.start_balance - acc.trail_drawdown, newPeak - acc.trail_drawdown);
        }
        if (acc.current_balance <= ddLevel) {
          await handleBreach(acc, tickPrice, "TRAILING_DRAWDOWN"); continue;
        }
      }

      // Consistency Rule
      const bestDay = acc.best_day_profit || 0;
      const consistencyViolated = acc.profit_target > 0 && bestDay > acc.profit_target * 0.5;

      if (consistencyViolated && !acc.consistency_flag) {
        const extraNeeded = (acc.total_profit || 0) - bestDay * 2;
        const newTarget = (acc.total_profit || 0) + extraNeeded;
        console.log(`⚠ Consistency violation flagged for ${acc.id}`);
        await supabase.from("accounts").update({
          consistency_flag: true,
          consistency_extra_needed: extraNeeded,
          consistency_new_target: newTarget
        }).eq("id", acc.id);
        acc.consistency_flag = true;
      } else if (!consistencyViolated && acc.consistency_flag) {
        console.log(`✅ Consistency restored for ${acc.id}`);
        await supabase.from("accounts").update({ consistency_flag: false }).eq("id", acc.id);
        acc.consistency_flag = false;
      }

      // Profit Target
      if (acc.total_profit >= acc.profit_target && !["passed", "blown"].includes(acc.status)) {
        if (acc.consistency_flag) {
          console.log(`🚧 Profit target hit but consistency violated for ${acc.id}`);
          continue;
        }
        console.log(`🏆 Profit target + consistency achieved for ${acc.id}`);
        await supabase.from("accounts").update({ status: "passed", trailing_dd_mode: "FROZEN" }).eq("id", acc.id);
      }
    }
  } catch (err) {
    console.error(`❌ evaluateOpenPositions(${symbol}) failed:`, err.message || err);
  }
}

async function handleBreach(account, tickPrice, reason) {
  console.log(`💀 ${reason} breached for account ${account.id} — marking blown`);
  await supabase.from("accounts").update({ status: "blown", blown_reason: reason }).eq("id", account.id);

  const openForAcc = getOpenTrades().filter((p) => p.account_id === account.id);
  await Promise.all(openForAcc.map((pos) => {
    const exitPx = applySlippage(pos.entry_price, tickPrice, pos.side);
    return closeTrade(pos, exitPx, reason);
  }));
}

// ===================================
// EXPORTS
// ===================================
module.exports = {
  evaluateOpenPositions,
  preTradeRiskCheck,
  evaluateImmediateRisk,
  applySlippage,
  applyPartialFill
};
