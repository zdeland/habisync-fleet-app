'use server';

import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';

function requireSupabase() {
  const supabase = createClient();
  if (!supabase) throw new Error('Supabase is not configured');
  return supabase;
}

export async function closeOutletAlert(alertId: number, deviceId: string): Promise<void> {
  const supabase = requireSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { error } = await supabase
    .from('outlet_alerts')
    .update({ status: 'closed', closed_at: new Date().toISOString(), closed_by: user?.id ?? null })
    .eq('id', alertId);

  if (error) throw error;

  revalidatePath(`/devices/${deviceId}`);
  revalidatePath('/');
}

export async function escalateOutletAlert(alertId: number, deviceId: string): Promise<void> {
  const supabase = requireSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { error } = await supabase
    .from('outlet_alerts')
    .update({ status: 'escalated', escalated_at: new Date().toISOString(), escalated_by: user?.id ?? null })
    .eq('id', alertId);

  if (error) throw error;

  revalidatePath(`/devices/${deviceId}`);
  revalidatePath('/');
}
