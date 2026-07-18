import { createClient, isSupabaseConfigured } from '@/lib/supabase/server';
import { getFleetHealth } from '@/lib/queries';
import FleetTable from '@/components/FleetTable';

export default async function FleetOverview() {
  if (!isSupabaseConfigured) {
    return (
      <section className="rounded-2xl bg-device-card p-8 text-sm text-device-text-secondary shadow-device">
        Set <code>NEXT_PUBLIC_SUPABASE_URL</code> and <code>NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY</code> to load fleet data.
      </section>
    );
  }

  const supabase = createClient();
  const fleet = supabase ? await getFleetHealth(supabase) : [];

  return (
    <section className="rounded-2xl bg-device-card p-6 shadow-device">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h2 className="text-[1.1em]">Device health</h2>
          <p className="text-sm text-device-text-secondary">What needs attention right now, across the fleet.</p>
        </div>
        <div className="rounded-full bg-device-surface px-3 py-1 text-sm text-device-text-secondary">
          {fleet.length} device{fleet.length === 1 ? '' : 's'}
        </div>
      </div>

      {fleet.length === 0 ? (
        <div className="rounded-xl bg-device-surface p-8 text-sm text-device-text-secondary">No devices reporting yet.</div>
      ) : (
        <FleetTable fleet={fleet} />
      )}
    </section>
  );
}
