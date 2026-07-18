'use client';

import { createBrowserClient } from '@supabase/ssr';
import type { Database } from '@/lib/types';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabasePublishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

export const isSupabaseConfigured = Boolean(supabaseUrl && supabasePublishableKey);

export function createClient() {
  if (!supabaseUrl || !supabasePublishableKey) {
    return null;
  }

  return createBrowserClient<Database>(supabaseUrl, supabasePublishableKey);
}
