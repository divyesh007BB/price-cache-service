// placeOrder.js
const express = require("express");
const router = express.Router();
const { placeOrder } = require("./matchingEngine"); // ✅ same folder
const { broadcast } = require("./websocketServer"); // ✅ ensure websocketServer.js exists and exports broadcast
const { v4: uuidv4 } = require("uuid");

/**
 * POST /place-order
 * Handles incoming order requests from Supabase Edge Function executeOrder
 */
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

    // ✅ Basic validation
    if (!user_id) {
      return res.status(400).json({ status: "error", error: "Missing user_id" });
    }
    if (!account_id) {
      return res.status(400).json({ status: "error", error: "Missing account_id" });
    }
    if (!symbol) {
      return res.status(400).json({ status: "error", error: "Missing symbol" });
    }
    if (!["buy", "sell"].includes(side)) {
      return res.status(400).json({ status: "error", error: "Invalid side" });
    }
    if (!["market", "limit"].includes(order_type)) {
      return res.status(400).json({ status: "error", error: "Invalid order_type" });
    }

    // ✅ Build order object for matchingEngine
    const order = {
      id: uuidv4(),
      user_id,
      account_id,
      symbol: symbol.toUpperCase(),
      side: side.toLowerCase(),
      size: Number(quantity),
      type: order_type.toLowerCase(),
      sl: stop_loss ?? null,
      tp: take_profit ?? null,
      price: limit_price ?? null,
      created_at: new Date().toISOString(),
      idempotency_key: idempotency_key ?? null
    };

    // ✅ Call your core matching engine logic
    await placeOrder(order);

    // 📡 Broadcast to all WS clients that a new order was placed
    broadcast({
      type: "order_update",
      data: {
        ...order,
        status: order.type === "market" ? "filled" : "pending"
      }
    });

    return res.json({
      status: "success",
      message: `Order accepted (${order.type})`,
      order
    });

  } catch (err) {
    console.error("❌ Error in /place-order:", err);
    return res.status(500).json({ status: "error", error: err.message });
  }
});

module.exports = router;
