'use client';

import { useEffect } from 'react';
import { createClient } from '@/lib/supabase/client';

/**
 * Ensures every visitor has a Supabase session before they start a call.
 *
 * On first load, if there is no existing session we create one with an
 * anonymous sign-in (`supabase.auth.signInAnonymously()`). This mints a real
 * `auth.users` row and a JWT with zero friction — no email or password — so the
 * `/api/token` route can verify the visitor server-side and scope the agent's
 * data to their `user.id`.
 *
 * Upgrading an anonymous user to a permanent account (email, OAuth, etc.) is a
 * natural next step via `supabase.auth.updateUser()` / `linkIdentity()`.
 */
export function useSupabaseSession() {
  useEffect(() => {
    const supabase = createClient();
    let cancelled = false;

    (async () => {
      const {
        data: { session },
      } = await supabase.auth.getSession();

      if (!cancelled && !session) {
        const { error } = await supabase.auth.signInAnonymously();
        if (error) {
          console.error('Supabase anonymous sign-in failed:', error.message);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);
}
