import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import type { Database } from '@/lib/types';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabasePublishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

export const isSupabaseConfigured = Boolean(supabaseUrl && supabasePublishableKey);

// For use in Server Components, Route Handlers, and Server Actions. Reads the
// signed-in user's session from cookies so PostgREST queries run with their
// JWT (never a secret key) — required for RLS on `logs`/`telemetry`.
export function createClient() {
  if (!supabaseUrl || !supabasePublishableKey) {
    return null;
  }

  const cookieStore = cookies();

  return createServerClient<Database>(supabaseUrl, supabasePublishableKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) => {
            cookieStore.set(name, value, options);
          });
        } catch {
          // Called from a Server Component render, where cookies are
          // read-only. Safe to ignore because middleware refreshes the
          // session on every request instead.
        }
      },
    },
    global: {
      // supabase-js calls the runtime's global fetch, which in a Next.js
      // Server Component is Next's own patched fetch — it caches GET
      // requests by default regardless of whether the page itself is
      // dynamic. This is a live monitoring tool; a cached devices/logs/
      // telemetry read is a bug (stale last_seen, stale readings), never
      // a feature, so opt every request out explicitly.
      fetch: (input, init) => fetch(input, { ...init, cache: 'no-store' }),
    },
  });
}
