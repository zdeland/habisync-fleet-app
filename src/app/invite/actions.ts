'use server';

import { headers } from 'next/headers';
import { requireUser } from '@/lib/supabase/auth';
import { createAdminClient } from '@/lib/supabase/admin';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function currentOrigin(): string {
  const headerList = headers();
  const host = headerList.get('x-forwarded-host') ?? headerList.get('host');
  const protocol = headerList.get('x-forwarded-proto') ?? 'https';
  return `${protocol}://${host}`;
}

export async function inviteUser(email: string): Promise<{ error: string | null }> {
  // Only a signed-in user can invite — this app has no separate admin role
  // (docs/monitoring-webapp-plan.md §6: every authenticated user already
  // reads the whole fleet), so "already invited and signed in" is the bar.
  await requireUser();

  const trimmed = email.trim();
  if (!EMAIL_PATTERN.test(trimmed)) {
    return { error: 'Enter a valid email address.' };
  }

  const admin = createAdminClient();
  if (!admin) {
    return { error: 'Supabase admin access is not configured (missing SUPABASE_SERVICE_ROLE_KEY).' };
  }

  const { error } = await admin.auth.admin.inviteUserByEmail(trimmed, {
    redirectTo: `${currentOrigin()}/auth/callback`,
  });

  if (error) return { error: error.message };
  return { error: null };
}
