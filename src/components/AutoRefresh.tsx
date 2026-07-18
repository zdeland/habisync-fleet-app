'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

// Server Components only refetch on navigation/reload — nothing here
// triggers automatically as new telemetry/logs land. router.refresh() re-runs
// the server-rendered tree (picking up fresh Supabase data, since those
// requests are cache: 'no-store') without resetting client-side state like
// the timeline scrubber position.
export default function AutoRefresh({ intervalMs }: { intervalMs: number }) {
  const router = useRouter();

  useEffect(() => {
    const id = setInterval(() => router.refresh(), intervalMs);
    return () => clearInterval(id);
  }, [router, intervalMs]);

  return null;
}
