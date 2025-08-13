const express = require("express");
const router = express.Router();
const { placeOrder } = require("./matchingEngine");
const { broadcast } = require("./websocketServer");
const { v4: uuidv4 } = require("uuid");
const { normalizeSymbol, getContracts } = require("./symbolMap");

// ✅ Shared state from price server
const { priceCache, WHITELIST } = require("./state");

// ✅ Fallback in case WHITELIST isn't populated yet
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
    if (!["buy", "sell"].includes(side)) return res.status(400).json({ status: "error", error: "Invalid side" });
    if (!["market", "limit"].includes(order_type)) return res.status(400).json({ status: "error", error: "Invalid order_type" });

    // ===== Symbol normalization & whitelist check =====
    const normSymbol = normalizeSymbol(symbol);
    if (!getWhitelist().has(normSymbol)) {
      console.warn(`❌ Rejected order — Symbol not in whitelist: ${symbol} (${normSymbol})`);
      return res.status(400).json({ status: "error", error: `Symbol not supported: ${symbol}` });
    }

    // ===== Build base order object =====
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
      price: limit_price ? Number(limit_price) : null,
      created_at: new Date().toISOString(),
      idempotency_key: idempotency_key || null
    };

    // ===== MARKET ORDER — fill instantly from price cache =====
    if (order.type === "market") {
      const cached = priceCache.get(normSymbol);
      if (!cached || !cached.price) {
        console.warn(`❌ No live price available for ${normSymbol}`);
        return res.status(400).json({ status: "error", error: `No live price for ${normSymbol}` });
      }
      order.price = cached.price;
      order.status = "filled";
      console.log(`✅ Filled market order ${order.id} @ ${order.price}`);

      // Process through matching engine for PnL and record keeping
      await placeOrder(order);

      // Push update to all WS clients
      broadcast({ type: "order_update", data: order });

      return res.json({
        status: "success",
        message: `Market order filled at ${order.price}`,
        order
      });
    }

    // ===== LIMIT ORDER — queue in matching engine =====
    order.status = "pending";
    await placeOrder(order);
    broadcast({ type: "order_update", data: order });

    return res.json({
      status: "success",
      message: `Limit order accepted at ${order.price || limit_price}`,
      order
    });

  } catch (err) {
    console.error("❌ Error in /place-order:", err);
    return res.status(500).json({ status: "error", error: err.message });
  }
});

module.exports = router;
