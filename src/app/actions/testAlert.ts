'use server';

import { createClient } from '@/lib/supabase/server';

// Calls the send-test-alert Edge Function (supabase/functions/send-test-alert)
// with the caller's own session token, so the function can verify who's
// asking (via supabase.auth.getUser()) and only ever email that same
// address. See docs/climate-alerts.md.
export async function sendTestAlertEmail(): Promise<{ ok: boolean; error?: string }> {
  const supabase = createClient();
  if (!supabase) return { ok: false, error: 'Supabase is not configured' };

  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) return { ok: false, error: 'Not signed in' };

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!supabaseUrl) return { ok: false, error: 'Supabase is not configured' };

  const response = await fetch(`${supabaseUrl}/functions/v1/send-test-alert`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${session.access_token}` },
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    return { ok: false, error: `Test alert failed (${response.status})${body ? `: ${body}` : ''}` };
  }

  return { ok: true };
}
