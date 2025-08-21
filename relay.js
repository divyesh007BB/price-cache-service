// relay.js — WebSocket relay for frontend clients (prop-firm style, heartbeat + per-symbol rate limiting)

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
const redisCli = new Redis(redisUrl, {
  maxRetriesPerRequest: null,
  enableReadyCheck: true,
});

redisSub.on("error", (err) => console.error("[RedisSub] ❌", err));
redisCli.on("error", (err) => console.error("[RedisCli] ❌", err));

// ===== WebSocket server =====
const server = http.createServer();
const wss = new WebSocket.Server({ server });

const PORT = process.env.RELAY_PORT || 8080;
const HEARTBEAT_INTERVAL = 30000; // 30s like real firms
const MAX_TICKS_PER_SECOND = 20;  // per symbol per client

const channels = [
  "price_ticks",
  "orderbook_BTCUSDT",
  "orderbook_ETHUSDT",
  "orderbook_XAUUSDT",
];

// Attach isAlive + per-symbol rate limit map to each client
function heartbeat() {
  this.isAlive = true;
}

wss.on("connection", async (ws) => {
  console.log("🌐 New WS client connected");
  ws.isAlive = true;

  // Rate limit trackers: { symbol: { lastTime, tickCount } }
  ws.rateLimit = {};

  ws.on("pong", heartbeat);

  // On connect: send snapshots
  try {
    const latest = await redisCli.hgetall("latest_prices");
    if (latest && Object.keys(latest).length > 0) {
      ws.send(JSON.stringify({ type: "latest_prices", data: latest }));
    }

    for (let c of channels.slice(1)) {
      const snap = await redisCli.get(c);
      if (snap) {
        ws.send(JSON.stringify({ type: c, data: JSON.parse(snap) }));
      }
    }
  } catch (err) {
    console.error("⚠️ Snapshot fetch failed", err);
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
  let parsed;
  try {
    parsed = JSON.parse(message);
  } catch (e) {
    console.error("⚠️ Invalid JSON from Redis:", message);
    return;
  }

  // Identify symbol for per-symbol rate limiting
  let symbol = "";
  if (parsed.symbol) {
    symbol = parsed.symbol.toUpperCase();
  } else if (channel.startsWith("orderbook_")) {
    symbol = channel.replace("orderbook_", "").toUpperCase();
  } else {
    symbol = channel.toUpperCase();
  }

  const payload = { type: channel, data: message };
  const now = Date.now();

  wss.clients.forEach((client) => {
    if (client.readyState !== WebSocket.OPEN) return;

    if (!client.rateLimit[symbol]) {
      client.rateLimit[symbol] = { lastTime: now, tickCount: 0 };
    }

    const rl = client.rateLimit[symbol];
    if (now - rl.lastTime > 1000) {
      rl.lastTime = now;
      rl.tickCount = 0;
    }

    rl.tickCount++;
    if (rl.tickCount > MAX_TICKS_PER_SECOND) {
      // drop tick if over limit
      return;
    }

    client.send(JSON.stringify(payload));
  });
});

// ===== Heartbeat =====
const interval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      console.log("💀 Terminating dead WS client");
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping();
  });
}, HEARTBEAT_INTERVAL);

wss.on("close", () => clearInterval(interval));

// ===== Start server =====
server.listen(PORT, () => {
  console.log(`🚀 Relay server listening on ws://localhost:${PORT}`);
});
