import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/types';

// Favorited device_ids for the signed-in user. No explicit user_id filter —
// supabase/favorite_devices.sql's RLS (auth.uid() = user_id) already
// restricts this to the caller's own rows, the first genuinely per-user
// policy in this app (see that file's comment).
export async function getFavoriteDeviceIds(supabase: SupabaseClient<Database>): Promise<Set<string>> {
  const { data, error } = await supabase.from('favorite_devices').select('device_id');
  if (error) throw error;
  return new Set((data ?? []).map((row) => row.device_id));
}
