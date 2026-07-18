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
      className="rounded-full border border-slate-700 bg-slate-800 px-4 py-2 text-sm text-slate-300 transition hover:bg-slate-700"
    >
      Sign out
    </button>
  );
}
