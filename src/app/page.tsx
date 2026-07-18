import { Suspense } from 'react';
import AutoRefresh from '@/components/AutoRefresh';
import FleetOverview from '@/components/FleetOverview';
import SignOutButton from '@/components/SignOutButton';
import { requireUser } from '@/lib/supabase/auth';
import { isSupabaseConfigured } from '@/lib/supabase/server';

export default async function HomePage() {
  await requireUser();

  return (
    <main className="min-h-screen bg-slate-950 p-6 text-slate-100">
      <div className="mx-auto flex max-w-7xl flex-col gap-6">
        <header className="rounded-2xl border border-slate-800 bg-slate-900/80 p-6 shadow-xl shadow-black/20">
          <div className="flex flex-col gap-2 md:flex-row md:items-end md:justify-between">
            <div>
              <p className="text-sm uppercase tracking-[0.3em] text-cyan-400">HabiSync Fleet Monitor</p>
              <h1 className="text-3xl font-semibold">Fleet overview</h1>
              <p className="mt-2 max-w-2xl text-sm text-slate-400">
                Review device health, recent activity, and early warning signals from the fleet.
              </p>
            </div>
            <div className="flex items-center gap-3">
              <div className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-4 py-2 text-sm text-emerald-300">
                Read-only monitoring workspace
              </div>
              {isSupabaseConfigured && <SignOutButton />}
            </div>
          </div>
        </header>

        <AutoRefresh intervalMs={20_000} />
        <Suspense fallback={<div className="rounded-2xl border border-slate-800 bg-slate-900/70 p-8 text-slate-400">Loading fleet data…</div>}>
          <FleetOverview />
        </Suspense>
      </div>
    </main>
  );
}
