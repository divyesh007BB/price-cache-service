// relay.js — WebSocket relay for frontend clients (normalized symbols only, clean payloads)

require("dotenv").config();
const WebSocket = require("ws");
const Redis = require("ioredis");
const http = require("http");
const url = require("url");

const redisUrl = process.env.REDIS_URL || "redis://127.0.0.1:6379";
const FEED_API_KEY = process.env.FEED_API_KEY || "supersecret";

// ===== Redis connections =====
const redisSub = new Redis(redisUrl, { maxRetriesPerRequest: null, enableReadyCheck: true });
const redisCli = new Redis(redisUrl, { maxRetriesPerRequest: null, enableReadyCheck: true });

redisSub.on("error", (err) => console.error("[RedisSub] ❌", err));
redisCli.on("error", (err) => console.error("[RedisCli] ❌", err));

// ===== WebSocket server =====
const server = http.createServer();
const wss = new WebSocket.Server({ noServer: true });

const PORT = process.env.RELAY_PORT || 8080;
const HEARTBEAT_INTERVAL = 30000;
const MAX_TICKS_PER_SECOND = 20;

// ✅ Normalized channels (match publisher)
const channels = [
  "price_ticks",
  "orderbook_BTCUSD",
  "orderbook_ETHUSD",
  "orderbook_XAUUSD",
];

// ===== Heartbeat =====
function heartbeat() {
  this.isAlive = true;
}

// ===== Upgrade handler with API key auth =====
server.on("upgrade", (req, socket, head) => {
  const query = url.parse(req.url, true).query;
  const headerKey = req.headers["sec-websocket-protocol"];

  // ✅ Accept ?api_key=, ?key=, ?token=, or header
  const token = query.key || query.token || query.api_key || headerKey;

  if (token !== FEED_API_KEY) {
    console.warn("🚫 WS auth failed:", req.socket.remoteAddress);
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req);
  });
});

// ===== Connections =====
wss.on("connection", async (ws) => {
  console.log("🌐 New WS client connected");
  ws.isAlive = true;
  ws.rateLimit = {};
  ws.on("pong", heartbeat);

  try {
    // ✅ Snapshot of latest prices
    const latest = await redisCli.hgetall("latest_prices");
    if (latest && Object.keys(latest).length > 0) {
      const parsed = {};
      Object.entries(latest).forEach(([sym, str]) => {
        try {
          parsed[sym] = JSON.parse(str);
        } catch {
          parsed[sym] = str;
        }
      });
      ws.send(JSON.stringify({ type: "latest_prices", data: parsed }));
    }

    // ✅ Snapshot of orderbooks
    for (let c of channels.slice(1)) {
      const snap = await redisCli.get(c);
      if (snap) {
        const symbol = c.split("_")[1]; // e.g. orderbook_BTCUSD → BTCUSD
        ws.send(JSON.stringify({ type: "orderbook", symbol, ...JSON.parse(snap) }));
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

  if (channel === "price_ticks") {
    const payload = {
      type: "price",
      symbol: parsed.symbol, // already normalized
      price: parsed.price,
      ts: parsed.ts,
    };
    broadcast(payload, parsed.symbol);
  } else if (channel.startsWith("orderbook_")) {
    const symbol = channel.split("_")[1];
    const payload = { type: "orderbook", symbol, ...parsed };
    broadcast(payload, symbol);
  }
});

// ===== Broadcast with per-symbol rate limiting =====
function broadcast(payload, symbol = "") {
  const now = Date.now();
  wss.clients.forEach((client) => {
    if (client.readyState !== WebSocket.OPEN) return;

    if (symbol) {
      if (!client.rateLimit[symbol]) {
        client.rateLimit[symbol] = { lastTime: now, tickCount: 0 };
      }
      const rl = client.rateLimit[symbol];
      if (now - rl.lastTime > 1000) {
        rl.lastTime = now;
        rl.tickCount = 0;
      }
      rl.tickCount++;
      if (rl.tickCount > MAX_TICKS_PER_SECOND) return;
    }

    client.send(JSON.stringify(payload));
  });
}

// ===== Heartbeat loop =====
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
  console.log(`🚀 Relay server listening on ws://localhost:${PORT} (auth required)`);
});
