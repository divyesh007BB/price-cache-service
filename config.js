// config.js
require("dotenv").config();

const { createClient } = require("@supabase/supabase-js");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error("SUPABASE_URL:", SUPABASE_URL);
  console.error("SUPABASE_SERVICE_KEY exists:", !!SUPABASE_SERVICE_KEY);
  throw new Error("❌ Missing SUPABASE_URL or SUPABASE_SERVICE_KEY");
}

const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

module.exports = { supabaseAdmin };
