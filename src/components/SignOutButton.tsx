'use client';

import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';

export default function SignOutButton() {
  const router = useRouter();

  async function handleSignOut() {
    const supabase = createClient();
    if (!supabase) return;
    await supabase.auth.signOut();
    router.push('/login');
    router.refresh();
  }

  return (
    <button
      onClick={handleSignOut}
      className="rounded-full bg-device-surface px-4 py-2 text-sm text-device-text-secondary transition hover:bg-device-surface-hover"
    >
      Sign out
    </button>
  );
}
