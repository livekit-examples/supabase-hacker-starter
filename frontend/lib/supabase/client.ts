import { createBrowserClient } from '@supabase/ssr';

/**
 * Browser-side Supabase client. Reads/writes the auth session from cookies so
 * it stays in sync with the server (the Next.js middleware refreshes the token
 * on every request). Uses the public publishable key — never the service role key.
 */
export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!
  );
}
