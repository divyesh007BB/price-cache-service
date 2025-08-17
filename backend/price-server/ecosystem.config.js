// ecosystem.config.js — PM2 process manager config

module.exports = {
  apps: [
    {
      name: "price-server",
      script: "index.js",
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: "1G",
      env: {
        NODE_ENV: "production",

        // === API KEYS ===
        FINNHUB_API_KEY: "d2cs6u1r01qihtctab40d2cs6u1r01qihtctab4g",

        // === Supabase (Frontend) ===
        NEXT_PUBLIC_SUPABASE_URL: "https://bqagmucrlzinexnjabvf.supabase.co",
        NEXT_PUBLIC_SUPABASE_ANON_KEY:
          "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJxYWdtdWNybHppbmV4bmphYnZmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTQ5MDY0NzAsImV4cCI6MjA3MDQ4MjQ3MH0.V1eGSSfCpQTMyxyCa97HbmrqObPlgJFtLqZON08Ir3I",

        // === Supabase (Backend) ===
        SUPABASE_URL: "https://bqagmucrlzinexnjabvf.supabase.co",
        SUPABASE_SERVICE_ROLE_KEY:
          "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJxYWdtdWNybHppbmV4bmphYnZmIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc1NDkwNjQ3MCwiZXhwIjoyMDcwNDgyNDcwfQ.y8Yp1RM6T7VHCISICktyAR48rVX068i_xpdVYXyn5kY",

        // === Price Server URLs (external access) ===
        NEXT_PUBLIC_PRICE_HTTP_URL: "http://207.148.125.154:4000",
        NEXT_PUBLIC_PRICE_WS_URL: "ws://207.148.125.154:4000",
        PRICE_SERVER_BASE: "http://207.148.125.154:4000",

        // === Redis (Railway) ===
        REDIS_URL:
          "redis://default:TwrqXDnDNLAScrFoGoBusDVsHURqveIx@redis.railway.internal:6379",

        // === Upstash REST API (optional) ===
        UPSTASH_REDIS_REST_URL: "https://social-shark-31740.upstash.io",
        UPSTASH_REDIS_REST_TOKEN:
          "AXv8AAIncDE0MzRkMDc0MWE3YTc0NTEyYWE5NTIyMzI0NTJkMGE4Y3AxMzE3NDA",

        // === Node Options ===
        NODE_OPTIONS: "--dns-result-order=ipv4first",

        // === WS Auth Key ===
        FEED_API_KEY: "supersecret",
      },
    },
    {
      name: "publisher",
      script: "publisher.js",
      cwd: "backend/price-server", // ✅ ensures it runs inside correct folder
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: "512M",
      env: {
        NODE_ENV: "production",
        REDIS_URL:
          "redis://default:TwrqXDnDNLAScrFoGoBusDVsHURqveIx@redis.railway.internal:6379",
      },
    },
  ],
};
