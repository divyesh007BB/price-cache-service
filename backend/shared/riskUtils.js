// backend/shared/riskUtils.js
// Common risk engine utilities: retry wrapper, slippage, partial fills

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
  let slippage = entryPrice * 0.0001; // 1bp default
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

module.exports = {
  supabaseQueryWithRetry,
  applySlippage,
  applyPartialFill
};
