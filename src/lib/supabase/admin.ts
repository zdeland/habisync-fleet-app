import 'server-only';
import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/types';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

export const isSupabaseAdminConfigured = Boolean(supabaseUrl && serviceRoleKey);

// Bypasses RLS entirely (service_role, never exposed to the browser — the
// `server-only` import makes bundling this into a Client Component a build
// error instead of a leaked secret). Only for the invite-a-user Server
// Action, which itself gates on requireUser() first: this app has no
// per-tenant isolation (docs/monitoring-webapp-plan.md §6), so "an existing
// signed-in user" is the only privilege tier there is to check.
export function createAdminClient() {
  if (!supabaseUrl || !serviceRoleKey) return null;

  return createSupabaseClient<Database>(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
