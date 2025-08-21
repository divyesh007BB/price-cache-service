// relay.js — WebSocket relay for frontend clients

require("dotenv").config();
const WebSocket = require("ws");
const Redis = require("ioredis");
const http = require("http");

const redisUrl = process.env.REDIS_URL || "redis://127.0.0.1:6379";

// ===== Redis connections =====
const redisSub = new Redis(redisUrl, {
  maxRetriesPerRequest: null,
  enableReadyCheck: true,
});
const redisCli = new Redis(redisUrl);

redisSub.on("error", (err) => console.error("[RedisSub] ❌", err));
redisCli.on("error", (err) => console.error("[RedisCli] ❌", err));

// ===== WebSocket server =====
const server = http.createServer();
const wss = new WebSocket.Server({ server });

const PORT = process.env.RELAY_PORT || 8080;
const channels = ["price_ticks", "orderbook_BTCUSDT", "orderbook_ETHUSDT", "orderbook_XAUUSDT"];

wss.on("connection", async (ws) => {
  console.log("🌐 New WS client connected");

  // On connect: send latest snapshots
  try {
    const latest = await redisCli.hgetall("latest_prices");
    ws.send(JSON.stringify({ type: "latest_prices", data: latest }));

    for (let c of channels.slice(1)) {
      const snap = await redisCli.get(c);
      if (snap) ws.send(JSON.stringify({ type: c, data: JSON.parse(snap) }));
    }
  } catch (err) {
    console.error("⚠️ Failed to fetch initial data", err);
  }

  ws.on("close", () => console.log("❌ WS client disconnected"));
});

// ===== Redis subscriber =====
redisSub.subscribe(...channels, (err, count) => {
  if (err) {
    console.error("❌ Failed to subscribe:", err);
  } else {
    console.log(`📡 Subscribed to ${count} Redis channels`);
  }
});

redisSub.on("message", (channel, message) => {
  const payload = { type: channel, data: JSON.parse(message) };
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(payload));
    }
  });
});

// ===== Start server =====
server.listen(PORT, () => {
  console.log(`🚀 Relay server listening on ws://localhost:${PORT}`);
});
