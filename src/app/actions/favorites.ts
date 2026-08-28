'use server';

import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';

function requireSupabase() {
  const supabase = createClient();
  if (!supabase) throw new Error('Supabase is not configured');
  return supabase;
}

// Toggles a favorite_devices row for the signed-in user. RLS (auth.uid() =
// user_id, see supabase/favorite_devices.sql) does the actual scoping —
// this always uses the caller's own session client, never the admin client.
export async function toggleFavoriteDevice(deviceId: string, isFavorite: boolean): Promise<void> {
  const supabase = requireSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error('Not signed in');

  if (isFavorite) {
    const { error } = await supabase.from('favorite_devices').insert({ user_id: user.id, device_id: deviceId });
    // 23505 = already favorited (e.g. a double-click race) — not an error.
    if (error && error.code !== '23505') throw error;
  } else {
    const { error } = await supabase
      .from('favorite_devices')
      .delete()
      .eq('user_id', user.id)
      .eq('device_id', deviceId);
    if (error) throw error;
  }

  revalidatePath('/');
}
