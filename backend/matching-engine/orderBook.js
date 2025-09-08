// backend/matching-engine/orderBook.js — Depth-based execution engine

const orderBooks = new Map(); // { symbol: { bids: [[px, qty]], asks: [[px, qty]] } }

function updateOrderBook(symbol, bids, asks) {
  orderBooks.set(symbol, {
    bids: bids.sort((a, b) => b[0] - a[0]), // high → low
    asks: asks.sort((a, b) => a[0] - b[0])  // low → high
  });
}

function matchOrder(order) {
  const ob = orderBooks.get(order.symbol);
  if (!ob) return { fills: [], remaining: order.quantity };

  const fills = [];
  let remaining = order.quantity;

  if (order.side === "buy") {
    for (const [price, qty] of ob.asks) {
      if (remaining <= 0) break;
      const take = Math.min(remaining, qty);
      fills.push({ price, qty: take });
      remaining -= take;
    }
  } else if (order.side === "sell") {
    for (const [price, qty] of ob.bids) {
      if (remaining <= 0) break;
      const take = Math.min(remaining, qty);
      fills.push({ price, qty: take });
      remaining -= take;
    }
  }

  return { fills, remaining };
}

function getOrderBook(symbol) {
  return orderBooks.get(symbol) || { bids: [], asks: [] };
}

module.exports = {
  updateOrderBook,
  matchOrder,
  getOrderBook
};
