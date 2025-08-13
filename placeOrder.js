// placeOrder.js — production ready

const express = require("express");
const router = express.Router();
const { placeOrder } = require("./matchingEngine");
const { broadcast } = require("./websocketServer");
const { v4: uuidv4 } = require("uuid");
const { normalizeSymbol, getContracts } = require("./symbolMap");
const { priceCache, WHITELIST } = require("./state");

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
    if (!["buy", "sell"].includes(side.toLowerCase())) return res.status(400).json({ status: "error", error: "Invalid side" });
    if (!["market", "limit"].includes(order_type.toLowerCase())) return res.status(400).json({ status: "error", error: "Invalid order_type" });
    if (order_type.toLowerCase() === "limit" && !limit_price) {
      return res.status(400).json({ status: "error", error: "Limit orders require limit_price" });
    }

    // ===== Symbol normalization =====
    const normSymbol = normalizeSymbol(symbol);
    if (!getWhitelist().has(normSymbol)) {
      console.warn(`❌ Rejected order — Symbol not in whitelist: ${symbol} (${normSymbol})`);
      return res.status(400).json({ status: "error", error: `Symbol not supported: ${symbol}` });
    }

    // ===== Build base order =====
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

    // ===== MARKET ORDER =====
    if (order.type === "market") {
      const cached = priceCache.get(normSymbol);
      if (!cached || !cached.price) {
        console.warn(`❌ No live price available for ${normSymbol}`);
        return res.status(400).json({ status: "error", error: `No live price for ${normSymbol}` });
      }

      // Convert if needed
      const contractMeta = getContracts()[normSymbol];
      let finalPrice = cached.price;
      if (contractMeta?.convertToINR) {
        const usdInr = priceCache.get("USDINR")?.price ?? 83;
        finalPrice = cached.price * usdInr;
      }

      order.entry_price = Number(finalPrice);
      order.price = Number(finalPrice); // for backward compatibility
      order.status = "filled";
      order.is_open = true;
      order.time_opened = new Date().toISOString();

      console.log(`✅ Filled market order ${order.id} @ ${order.entry_price}`);

      await placeOrder(order); // matchingEngine handles DB & WS

      broadcast({ type: "order_update", data: order });

      return res.json({
        status: "success",
        message: `Market order filled at ${order.entry_price}`,
        order
      });
    }

    // ===== LIMIT ORDER =====
    order.status = "pending"; // stays pending until matchingEngine.fillOrder triggers
    await placeOrder(order);
    broadcast({ type: "order_update", data: order });

    return res.json({
      status: "success",
      message: `Limit order accepted at ${order.limit_price}`,
      order
    });

  } catch (err) {
    console.error("❌ Error in /place-order:", err);
    return res.status(500).json({ status: "error", error: err.message });
  }
});

module.exports = router;
