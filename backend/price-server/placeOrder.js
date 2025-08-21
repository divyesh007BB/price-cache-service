// placeOrder.js — Gateway API for order validation + persistence + audit logging
// Topstep/FTMO-grade with Supabase + Redis + Prometheus metrics

const express = require("express");
const router = express.Router();
const { placeOrder } = require("../matching-engine/matchingEngine");
const { normalizeSymbol, getContracts } = require("../shared/symbolMap");
const { WHITELIST } = require("../shared/state");
const { v4: uuidv4 } = require("uuid");
const { createClient } = require("@supabase/supabase-js");
const { preTradeRiskCheck } = require("./riskEngine");
const Redis = require("ioredis");
const client = require("prom-client");

// ✅ Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ✅ Redis
const redis = new Redis(process.env.REDIS_URL || "redis://localhost:6379", {
  maxRetriesPerRequest: null,
  enableReadyCheck: true,
  retryStrategy: (times) => Math.min(times * 200, 2000),
});

// ===== Metrics =====
const orderValidationTime = new client.Histogram({
  name: "order_validation_ms",
  help: "Order validation latency (ms)",
  buckets: [5, 10, 20, 50, 100, 200, 500],
});

const orderExecutionTime = new client.Histogram({
  name: "order_execution_ms",
  help: "Time from accept → forward to matchingEngine",
  buckets: [5, 10, 20, 50, 100, 200, 500],
});

// ===== Helpers =====
function getWhitelist() {
  return WHITELIST && WHITELIST.size > 0
    ? WHITELIST
    : new Set(Object.keys(getContracts() || {}));
}

async function getPriceFromRedis(symbol) {
  try {
    const raw = await redis.hget("latest_prices", symbol);
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    console.error("❌ Redis getPriceFromRedis error:", err);
    return null;
  }
}

async function auditLog(order) {
  try {
    await redis.lpush("audit:orders", JSON.stringify(order));
    await redis.ltrim("audit:orders", 0, 10000); // keep last 10k
  } catch (err) {
    console.error("❌ Failed auditLog:", err.message);
  }
}

// ===== Route =====
router.post("/", async (req, res) => {
  const validationTimer = orderValidationTime.startTimer();

  try {
    const {
      user_id,
      account_id,
      symbol,
      side,
      quantity,
      order_type,
      stop_loss,
      take_profit,
      limit_price,
      idempotency_key,
    } = req.body;

    console.log(
      `📝 Incoming order: user=${user_id}, acc=${account_id}, sym=${symbol}, type=${order_type}, qty=${quantity}`
    );

    // --- Validation ---
    if (!user_id) return res.status(400).json({ error: "Missing user_id" });
    if (!account_id) return res.status(400).json({ error: "Missing account_id" });
    if (!symbol) return res.status(400).json({ error: "Missing symbol" });
    if (!["buy", "sell"].includes(side?.toLowerCase()))
      return res.status(400).json({ error: "Invalid side" });
    if (!["market", "limit"].includes(order_type?.toLowerCase()))
      return res.status(400).json({ error: "Invalid order_type" });
    if (order_type.toLowerCase() === "limit" && !limit_price)
      return res.status(400).json({ error: "Limit orders require limit_price" });

    // ✅ Normalize once
    const normSymbol = normalizeSymbol(symbol);

    // --- Whitelist ---
    const whitelist = getWhitelist();
    if (!whitelist.has(normSymbol)) {
      console.error("❌ SYMBOL_NOT_SUPPORTED:", symbol, "→", normSymbol, whitelist);
      return res.status(400).json({ error: "SYMBOL_NOT_SUPPORTED" });
    }

    const contract = getContracts()[normSymbol];
    if (!contract)
      return res.status(400).json({ error: "CONTRACT_META_NOT_FOUND" });

    // --- Trading hours ---
    if (contract?.tradingHours) {
      const nowUTC = new Date();
      const hoursUTC = nowUTC.getUTCHours() + nowUTC.getUTCMinutes() / 60;
      const { start, end } = contract.tradingHours;
      if (hoursUTC < start || hoursUTC >= end) {
        return res.status(400).json({ error: "MARKET_CLOSED" });
      }
    }

    // --- Lot size ---
    if (quantity < contract.minQty || quantity % contract.qtyStep !== 0)
      return res.status(400).json({ error: "INVALID_LOT_SIZE" });

    // --- Risk engine ---
    const riskCheck = await preTradeRiskCheck(account_id, normSymbol, quantity);
    if (!riskCheck.ok)
      return res.status(400).json({ error: riskCheck.error });

    // --- Idempotency (Redis + Supabase) ---
    if (idempotency_key) {
      const dup = await redis.get(`idem:${idempotency_key}`);
      if (dup) {
        return res.status(200).json({ status: "duplicate", order_id: dup });
      }
      const { data: existingOrder } = await supabase
        .from("orders")
        .select("id, created_at")
        .eq("idempotency_key", idempotency_key)
        .maybeSingle();
      if (existingOrder) {
        return res.status(200).json({
          status: "duplicate",
          order_id: existingOrder.id,
        });
      }
    }

    // --- Market orders need latest price ---
    let entryPrice = null;
    if (order_type.toLowerCase() === "market") {
      const cached = await getPriceFromRedis(normSymbol);
      if (!cached?.price)
        return res.status(400).json({ error: "NO_LIVE_PRICE" });
      entryPrice = cached.price;
    }

    // --- Build order object ---
    const order = {
      id: uuidv4(),
      user_id,
      account_id,
      symbol: normSymbol,
      side: side.toLowerCase(),
      quantity: Number(quantity),
      type: order_type.toLowerCase(),
      stop_loss: stop_loss ? Number(stop_loss) : null,
      take_profit: take_profit ? Number(take_profit) : null,
      limit_price: limit_price ? Number(limit_price) : null,
      entry_price: entryPrice,
      idempotency_key: idempotency_key || null,
      created_at: new Date().toISOString(),
      status: "pending",
    };

    validationTimer(); // stop validation timer
    const execTimer = orderExecutionTime.startTimer();

    // 🚀 Persist to Supabase
    const { error: insertErr } = await supabase.from("orders").insert(order);
    if (insertErr) {
      console.error("❌ Supabase insert failed:", insertErr.message);
    }

    // 🚀 Audit log
    await auditLog(order);

    // 🚀 Forward to MatchingEngine
    const result = await placeOrder(order);
    execTimer();

    // --- Idempotency key persistence ---
    if (idempotency_key) {
      await redis.set(`idem:${idempotency_key}`, order.id, "EX", 60 * 5);
    }

    console.log(
      `✅ Order processed: ${order.id} (${order.type.toUpperCase()} ${order.quantity} ${order.symbol})`
    );

    return res.json({
      status: "success",
      kind: result?.kind || (order.type === "market" ? "filled_market" : "accepted_limit"),
      message:
        order.type === "market"
          ? "Market order filled"
          : `Limit order accepted at ${order.limit_price}`,
      order_id: order.id,
    });
  } catch (err) {
    console.error("❌ Error in /place-order:", err.message, req.body);
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
