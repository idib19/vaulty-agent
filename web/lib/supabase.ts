import { createClient } from "@supabase/supabase-js";

if (!process.env.SUPABASE_URL) throw new Error("Missing SUPABASE_URL");
if (!process.env.SUPABASE_ANON_KEY) throw new Error("Missing SUPABASE_ANON_KEY");

// Server-side Supabase client using the anon key.
// Auth operations (signIn, getUser, refreshSession) work with the anon key.
// user_profiles queries work as long as your RLS policy allows
// users to read their own row (the Supabase default).
export const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
);
