// Supabase secret-key client singleton.
//
// The agent runs server-side and talks to Postgres through PostgREST and RPC
// using the Supabase SECRET key (sb_secret_...), which bypasses row-level
// security. Identity is established upstream: the Next.js token route verifies
// the Supabase session and passes the verified user_id to the agent via
// dispatch metadata, and the agent scopes every query by that id. RLS still
// protects the browser client (which uses the publishable key).
//
// supabase-js is stateless over HTTP, so there is no connection pool to manage
// or close — a single shared client is reused across the process.
import { type SupabaseClient, createClient } from '@supabase/supabase-js';

let client: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
  if (client) {
    return client;
  }
  const url = process.env.SUPABASE_URL;
  if (!url) {
    throw new Error('SUPABASE_URL environment variable is not set.');
  }
  const secretKey = process.env.SUPABASE_SECRET_KEY;
  if (!secretKey) {
    throw new Error('SUPABASE_SECRET_KEY environment variable is not set.');
  }
  client = createClient(url, secretKey, {
    auth: {
      // Server-side worker: never persist or refresh a browser session.
      persistSession: false,
      autoRefreshToken: false,
    },
  });
  return client;
}
