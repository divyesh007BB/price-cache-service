// placeOrder.js — Prop firm grade validation before matchingEngine execution (Redis-based)

const express = require("express");
const router = express.Router();
const { placeOrder } = require("./matchingEngine");
const { normalizeSymbol, getContracts } = require("./symbolMap");
const { WHITELIST } = require("./state");
const { v4: uuidv4 } = require("uuid");
const { createClient } = require("@supabase/supabase-js");
const { preTradeRiskCheck } = require("./riskEngine");
const Redis = require("ioredis");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const redis = new Redis(process.env.REDIS_URL || "redis://localhost:6379");

// ===== Helper =====
function getWhitelist() {
  return WHITELIST && WHITELIST.size > 0
    ? WHITELIST
    : new Set(Object.keys(getContracts() || {}));
}

async function getPriceFromRedis(symbol) {
  const raw = await redis.get(`price:${symbol}`);
  return raw ? JSON.parse(raw) : null;
}

router.post("/place-order", async (req, res) => {
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
      idempotency_key
    } = req.body;

    console.log(`📝 Incoming order: ${JSON.stringify(req.body)}`);

    // ===== Basic input validation =====
    if (!user_id) return res.status(400).json({ error: "Missing user_id" });
    if (!account_id) return res.status(400).json({ error: "Missing account_id" });
    if (!symbol) return res.status(400).json({ error: "Missing symbol" });
    if (!["buy", "sell"].includes(side?.toLowerCase()))
      return res.status(400).json({ error: "Invalid side" });
    if (!["market", "limit"].includes(order_type?.toLowerCase()))
      return res.status(400).json({ error: "Invalid order_type" });
    if (order_type.toLowerCase() === "limit" && !limit_price)
      return res.status(400).json({ error: "Limit orders require limit_price" });

    // ===== Symbol whitelist check =====
    const normSymbol = normalizeSymbol(symbol);
    if (!getWhitelist().has(normSymbol))
      return res.status(400).json({ error: "SYMBOL_NOT_SUPPORTED" });

    const contract = getContracts()[normSymbol];
    if (!contract)
      return res.status(400).json({ error: "CONTRACT_META_NOT_FOUND" });

    // ===== Trading hours check (if applicable) =====
    const nowUTC = new Date();
    const hoursUTC = nowUTC.getUTCHours() + nowUTC.getUTCMinutes() / 60;
    if (contract.tradingHours) {
      const { start, end } = contract.tradingHours;
      if (hoursUTC < start || hoursUTC > end)
        return res.status(400).json({ error: "MARKET_CLOSED" });
    }

    // ===== Lot size check =====
    if (quantity < contract.minQty || quantity % contract.qtyStep !== 0)
      return res.status(400).json({ error: "INVALID_LOT_SIZE" });

    // ===== Risk engine pre-trade check =====
    const riskCheck = await preTradeRiskCheck(account_id, normSymbol, quantity);
    if (!riskCheck.ok)
      return res.status(400).json({ error: riskCheck.error });

    // ===== Idempotency check =====
    if (idempotency_key) {
      const { data: existingOrder } = await supabase
        .from("trades")
        .select("id, created_at")
        .eq("idempotency_key", idempotency_key)
        .single();
      if (existingOrder) {
        const createdTime = new Date(existingOrder.created_at).getTime();
        if (Date.now() - createdTime < 5000) {
          console.warn(`⚠ Duplicate order detected for idempotency_key ${idempotency_key}`);
          return res.status(200).json({
            status: "duplicate",
            message: "Order already processed",
            order_id: existingOrder.id
          });
        }
      }
    }

    // ===== Get latest price for market orders from Redis =====
    let entryPrice = null;
    if (order_type.toLowerCase() === "market") {
      const cached = await getPriceFromRedis(normSymbol);
      if (!cached || !cached.price) {
        return res.status(400).json({ error: "NO_LIVE_PRICE" });
      }
      entryPrice = cached.price;
    }

    // ===== Build order object =====
    const order = {
      id: uuidv4(),
      user_id,
      account_id,
      symbol: normSymbol,
      side: side.toLowerCase(),
      size: Number(quantity),
      type: order_type.toLowerCase(),
      stop_loss: stop_loss ? Number(stop_loss) : null,
      take_profit: take_profit ? Number(take_profit) : null,
      limit_price: limit_price ? Number(limit_price) : null,
      entry_price: entryPrice,
      created_at: new Date().toISOString(),
      idempotency_key: idempotency_key || null
    };

    // ===== Pass to matchingEngine =====
    await placeOrder(order);

    console.log(`✅ Order accepted: ${order.id} (${order.type.toUpperCase()} ${order.size} ${order.symbol})`);

    return res.json({
      status: "success",
      message:
        order.type === "market"
          ? "Market order sent for execution"
          : `Limit order accepted at ${order.limit_price}`,
      order
    });

  } catch (err) {
    console.error("❌ Error in /place-order:", err);
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
