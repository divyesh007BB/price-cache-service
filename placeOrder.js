// placeOrder.js — streamlined to use matchingEngine directly

const express = require("express");
const router = express.Router();
const { placeOrder } = require("./matchingEngine");
const { normalizeSymbol, getContracts } = require("./symbolMap");
const { WHITELIST } = require("./state");
const { v4: uuidv4 } = require("uuid");

// ✅ Use matchingEngine for all execution — no manual fills here
function getWhitelist() {
  return WHITELIST && WHITELIST.size > 0
    ? WHITELIST
    : new Set(Object.keys(getContracts() || {}));
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

    // ===== Validation =====
    if (!user_id) return res.status(400).json({ status: "error", error: "Missing user_id" });
    if (!account_id) return res.status(400).json({ status: "error", error: "Missing account_id" });
    if (!symbol) return res.status(400).json({ status: "error", error: "Missing symbol" });
    if (!["buy", "sell"].includes(side.toLowerCase())) {
      return res.status(400).json({ status: "error", error: "Invalid side" });
    }
    if (!["market", "limit"].includes(order_type.toLowerCase())) {
      return res.status(400).json({ status: "error", error: "Invalid order_type" });
    }
    if (order_type.toLowerCase() === "limit" && !limit_price) {
      return res.status(400).json({ status: "error", error: "Limit orders require limit_price" });
    }

    // ===== Symbol normalization & whitelist check =====
    const normSymbol = normalizeSymbol(symbol);
    if (!getWhitelist().has(normSymbol)) {
      console.warn(`❌ Rejected order — Symbol not in whitelist: ${symbol} (${normSymbol})`);
      return res.status(400).json({ status: "error", error: `Symbol not supported: ${symbol}` });
    }

    // ===== Build the order object for matchingEngine =====
    const order = {
      id: uuidv4(),
      user_id,
      account_id,
      symbol: normSymbol,
      side: side.toLowerCase(),
      size: Number(quantity),
      type: order_type.toLowerCase(),
      sl: stop_loss ? Number(stop_loss) : null,
      tp: take_profit ? Number(take_profit) : null,
      limit_price: limit_price ? Number(limit_price) : null,
      entry_price: null,
      created_at: new Date().toISOString(),
      idempotency_key: idempotency_key || null
    };

    // ===== Pass to matchingEngine =====
    await placeOrder(order);

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
    return res.status(500).json({ status: "error", error: err.message });
  }
});

module.exports = router;
