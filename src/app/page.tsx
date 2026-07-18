import { Suspense } from "react";
import AutoRefresh from "@/components/AutoRefresh";
import FleetOverview from "@/components/FleetOverview";
import SignOutButton from "@/components/SignOutButton";
import { requireUser } from "@/lib/supabase/auth";
import { isSupabaseConfigured } from "@/lib/supabase/server";

export default async function HomePage() {
  await requireUser();

  return (
    <main className="min-h-screen bg-device-screen p-6 text-device-text">
      <div className="mx-auto flex max-w-7xl flex-col gap-6">
        <header className="rounded-2xl bg-device-card p-6 shadow-device">
          <div className="flex flex-col gap-2 md:flex-row md:items-end md:justify-between">
            <div>
              {/* <p className="text-sm uppercase tracking-[0.3em] text-device-accent">
                HabiSync Fleet Monitor
              </p> */}
              <h1 className="text-3xl font-semibold">HabiSync Fleet Monitor</h1>
              <p className="mt-2 max-w-2xl text-sm text-device-text-secondary">
                Review device health, recent activity, and early warning signals
                from the fleet.
              </p>
            </div>
            <div className="flex items-center gap-3">
              <div className="rounded-full border border-device-good/30 bg-device-good/10 px-4 py-2 text-sm text-device-good">
                Read-only monitoring workspace
              </div>
              {isSupabaseConfigured && <SignOutButton />}
            </div>
          </div>
        </header>

        <AutoRefresh intervalMs={20_000} />
        <Suspense
          fallback={
            <div className="rounded-2xl bg-device-card p-8 text-device-text-secondary shadow-device">
              Loading fleet data…
            </div>
          }
        >
          <FleetOverview />
        </Suspense>
      </div>
    </main>
  );
}
