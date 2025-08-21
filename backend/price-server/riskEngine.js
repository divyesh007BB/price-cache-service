// backend/price-server/riskEngine.js — Prop firm grade risk engine

require("dotenv").config();
const dns = require("dns").promises;
const Redis = require("ioredis");

const { supabaseClient: supabase } = require("../shared/supabaseClient");
const { getContracts, normalizeSymbol } = require("../shared/symbolMap");
const { getOpenTrades, getAccounts } = require("../matching-engine/tradeState");
const { closeTrade } = require("../matching-engine/matchingEngine");

// ✅ Import utils
const { supabaseQueryWithRetry, applySlippage, applyPartialFill } = require("../shared/riskUtils");

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

// ---- Redis Pub/Sub ----
const redisUrl = process.env.REDIS_URL;
const sub = new Redis(redisUrl);

sub.psubscribe("price:*", "trade_events", "order_events", (err, count) => {
  if (err) {
    console.error("❌ Failed to subscribe to Redis:", err);
  } else {
    console.log(`📡 RiskEngine subscribed to ${count} channel(s)`);
  }
});

sub.on("pmessage", async (pattern, channel, message) => {
  try {
    if (!message) return;
    const event = JSON.parse(message);

    if (channel.startsWith("price:")) {
      const { symbol, price } = event;
      const norm = normalizeSymbol(symbol);
      await evaluateOpenPositions(norm, price);
    }

    if (channel === "trade_events") {
      console.log("📡 Trade Event:", event.type, event);
      await supabase.from("trade_audit").insert({
        account_id: event.account_id,
        trade_id: event.trade_id || null,
        symbol: normalizeSymbol(event.symbol),
        side: event.side,
        size: event.size,
        price: event.execPrice,
        pnl: event.pnl || null,
        event_type: event.type,
        raw_event: event,
        created_at: new Date().toISOString()
      });

      if (event.type === "TRADE_OPEN") {
        await evaluateImmediateRisk(event.account_id, event.symbol, event.size, event.execPrice);
      }
    }

    if (channel === "order_events") {
      console.log("📡 Order Event:", event.type, event);
      await supabase.from("order_audit").insert({
        account_id: event.account_id,
        order_id: event.order_id || null,
        symbol: normalizeSymbol(event.symbol),
        side: event.side,
        size: event.size,
        order_type: event.order_type,
        price: event.limit_price || event.execPrice || null,
        status: event.status,
        reason: event.reason || null,
        event_type: event.type,
        raw_event: event,
        created_at: new Date().toISOString()
      });
    }
  } catch (err) {
    console.error("❌ Redis message parse error:", err.message || err);
  }
});

// ✅ Pre-trade risk validation
async function preTradeRiskCheck(accountId, symbol, size) {
  try {
    const norm = normalizeSymbol(symbol);

    const account = await supabaseQueryWithRetry(() =>
      supabase.from("accounts").select("*").eq("id", accountId).single()
    );

    if (!account) return { ok: false, error: "ACCOUNT_NOT_FOUND" };
    if (["blown", "suspended"].includes(account.status)) {
      return { ok: false, error: "ACCOUNT_INACTIVE" };
    }

    const contract = getContracts()[norm];
    if (!contract) return { ok: false, error: "SYMBOL_NOT_SUPPORTED" };

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
    const norm = normalizeSymbol(symbol);

    const account = await supabaseQueryWithRetry(() =>
      supabase.from("accounts").select("*").eq("id", accountId).single()
    );

    if (!account) return { ok: false, error: "ACCOUNT_NOT_FOUND" };
    if (["blown", "suspended"].includes(account.status)) {
      return { ok: false, error: "ACCOUNT_INACTIVE" };
    }

    const contract = getContracts()[norm];
    if (!contract) return { ok: false, error: "SYMBOL_NOT_SUPPORTED" };

    if (contract?.maxLots && size > contract.maxLots.Evaluation) {
      return { ok: false, error: "MAX_LOT_SIZE" };
    }

    if (account.max_loss && account.current_balance <= account.start_balance - account.max_loss) {
      console.log(`💀 Account ${account.id} FAILED MAX LOSS on fill`);
      return { ok: false, error: "MAX_LOSS" };
    }

    if (account.trail_drawdown) {
      const peak = account.peak_balance || account.start_balance;
      const ddFloor = Math.max(account.start_balance - account.trail_drawdown, peak - account.trail_drawdown);
      if (account.current_balance <= ddFloor) {
        console.log(`💀 Account ${account.id} FAILED TRAILING DD on fill`);
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
    const norm = normalizeSymbol(symbol);
    const now = Date.now();
    const openPositions = getOpenTrades();
    const accounts = getAccounts();
    const contract = getContracts()[norm];
    if (!contract) return;

    // ---- SL/TP checks ----
    await Promise.all(
      openPositions.map(async (pos) => {
        if (normalizeSymbol(pos.symbol) !== norm) return;
        if (now - new Date(pos.time_opened).getTime() < SLTP_GRACE_MS) return;

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
      })
    );

    // ---- Account-level checks ----
    for (const acc of accounts) {
      if (acc.status === "blown") continue;

      if (acc.max_loss && acc.current_balance <= acc.start_balance - acc.max_loss) {
        await handleBreach(acc, tickPrice, "MAX_LOSS"); continue;
      }

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

      if (acc.total_profit >= acc.profit_target && !["passed", "blown"].includes(acc.status)) {
        if (acc.consistency_flag) {
          console.log(`🚧 Profit target hit but consistency violated for ${acc.id}`);
          continue;
        }
        console.log(`🏆 Account ${acc.id} PASSED — Profit target + consistency achieved!`);
        await supabase.from("accounts").update({ status: "passed", trailing_dd_mode: "FROZEN" }).eq("id", acc.id);
      }
    }
  } catch (err) {
    console.error(`❌ evaluateOpenPositions(${symbol}) failed:`, err.message || err);
  }
}

async function handleBreach(account, tickPrice, reason) {
  console.log(`💀 Account ${account.id} BLOWN — Reason: ${reason}`);
  await supabase.from("accounts").update({ status: "blown", blown_reason: reason }).eq("id", account.id);

  const openForAcc = getOpenTrades().filter((p) => p.account_id === account.id);
  await Promise.all(openForAcc.map((pos) => {
    const exitPx = applySlippage(pos.entry_price, tickPrice, pos.side);
    return closeTrade(pos, exitPx, reason);
  }));
}

module.exports = {
  evaluateOpenPositions,
  preTradeRiskCheck,
  evaluateImmediateRisk
};
