// supabaseClient.js — backend Supabase client (service role)

require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
  throw new Error("❌ Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in .env");
}

const supabaseClient = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  {
    auth: { persistSession: false },
  }
);

module.exports = { supabaseClient };
