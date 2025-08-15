// supabaseClient.js — Service-role Supabase client for backend services
require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");

// ===== Ensure fetch exists (Node <18 compatibility) =====
if (typeof fetch === "undefined") {
  global.fetch = (...args) =>
    import("node-fetch").then(({ default: fetch }) => fetch(...args));
}

// ===== Env validation =====
function requireEnv(varName) {
  const value = process.env[varName];
  if (!value) throw new Error(`❌ Missing ${varName} in environment variables`);
  return value;
}

const SUPABASE_URL = requireEnv("SUPABASE_URL");
// ✅ Use SERVICE_ROLE_KEY from .env
const SUPABASE_SERVICE_KEY = requireEnv("SUPABASE_SERVICE_ROLE_KEY");

// ===== Masked logging (optional) =====
function maskKey(key) {
  return key.length > 8 ? `${key.slice(0, 4)}...${key.slice(-4)}` : key;
}
if (process.env.DEBUG_SUPABASE === "true") {
  console.log("🔑 SUPABASE_URL:", SUPABASE_URL);
  console.log("🔑 SUPABASE_SERVICE_ROLE_KEY:", maskKey(SUPABASE_SERVICE_KEY));
}

// ===== Supabase client creation with retry =====
async function safeFetch(...args) {
  let attempts = 0;
  while (true) {
    try {
      return await fetch(...args);
    } catch (err) {
      attempts++;
      if (attempts >= 3) throw err;
      console.warn(`⚠ Supabase fetch retry ${attempts}:`, err.message);
      await new Promise((res) => setTimeout(res, 500 * attempts));
    }
  }
}

const supabaseClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false },
  global: { fetch: safeFetch },
});

module.exports = { supabaseClient };
