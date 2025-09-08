// dailyReset.js — Resets accounts daily (Prop firm style, FTMO/Topstep grade)

require("dotenv").config();
const { v4: uuidv4 } = require("uuid");
const dayjs = require("dayjs");
const utc = require("dayjs/plugin/utc");
dayjs.extend(utc);

const { supabaseClient: supabase } = require("../shared/supabaseClient");
const { getAccounts, updateAccount, getOpenTrades } = require("../matching-engine/tradeState");
const { closeTrade } = require("../matching-engine/matchingEngine");

async function resetAccounts() {
  const today = dayjs().utc().format("YYYY-MM-DD");
  console.log(`🔄 Running daily reset @ ${today}`);

  const accounts = getAccounts();

  for (const acc of accounts) {
    if (!acc) continue;

    // ✅ Force-close all open trades if overnight not allowed
    const openTrades = getOpenTrades().filter((t) => t.account_id === acc.id);
    for (const t of openTrades) {
      try {
        const exitPx = t.current_price || t.entry_price;
        await closeTrade(t, exitPx, "DAILY_RESET");
        await supabase.from("trade_audit_logs").insert({
          id: uuidv4(),
          account_id: acc.id,
          event: "DAILY_RESET_CLOSE",
          payload: JSON.stringify({
            trade_id: t.id,
            symbol: t.symbol,
            side: t.side,
            entry: t.entry_price,
            exit: exitPx,
          }),
          created_at: new Date().toISOString(),
        });
      } catch (err) {
        console.error(`❌ Failed to close trade ${t.id} for account ${acc.id}`, err.message);
      }
    }

    // ✅ Reset daily metrics
    acc.daily_loss = 0;
    acc.sessionPnL = {
      day: today,
      realized: 0,
      bestDay: 0,
      total: acc.total_profit ?? 0,
    };

    updateAccount(acc.id, acc);

    try {
      await supabase.from("accounts")
        .update({
          daily_loss: 0,
          session_day: today,
        })
        .eq("id", acc.id);

      // ✅ Insert audit log for reset
      await supabase.from("trade_audit_logs").insert({
        id: uuidv4(),
        account_id: acc.id,
        event: "DAILY_RESET",
        payload: JSON.stringify({
          day: today,
          account: acc.id,
          balance: acc.current_balance,
        }),
        created_at: new Date().toISOString(),
      });
    } catch (err) {
      console.error("❌ Failed to reset account in Supabase or log audit:", acc.id, err.message);
    }
  }

  console.log(`✅ Daily reset done for ${accounts.length} accounts`);
}

// Schedule job (midnight UTC)
function startDailyReset() {
  const now = dayjs().utc();
  const next = now.endOf("day").add(1, "second");
  const delay = next.diff(now);

  setTimeout(async () => {
    await resetAccounts();
    startDailyReset(); // reschedule
  }, delay);

  console.log(`⏰ Daily reset scheduled for ${next.toISOString()}`);
}

module.exports = {
  startDailyReset,
  resetAccounts,
};
