import { createClient, isSupabaseConfigured } from '@/lib/supabase/server';
import { getFleetHealth, type DeviceHealth } from '@/lib/queries';

const statusStyles: Record<string, string> = {
  healthy: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300',
  warning: 'border-amber-500/30 bg-amber-500/10 text-amber-300',
  critical: 'border-rose-500/30 bg-rose-500/10 text-rose-300',
};

function deriveStatus({ isStale, recentErrorCount }: DeviceHealth): keyof typeof statusStyles {
  if (isStale || recentErrorCount >= 5) return 'critical';
  if (recentErrorCount >= 1) return 'warning';
  return 'healthy';
}

function formatLastSeen(lastSeen: string, isStale: boolean): string {
  const diffMs = Date.now() - new Date(lastSeen).getTime();
  const diffMin = Math.round(diffMs / 60_000);
  const label = diffMin < 1 ? 'just now' : diffMin < 60 ? `${diffMin} min ago` : `${Math.round(diffMin / 60)}h ago`;
  return isStale ? `${label} (stale)` : label;
}

export default async function FleetOverview() {
  if (!isSupabaseConfigured) {
    return (
      <section className="rounded-2xl border border-slate-800 bg-slate-900/80 p-8 text-sm text-slate-400">
        Set <code>NEXT_PUBLIC_SUPABASE_URL</code> and <code>NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY</code> to load fleet data.
      </section>
    );
  }

  const supabase = createClient();
  const fleet = supabase ? await getFleetHealth(supabase) : [];

  return (
    <section className="rounded-2xl border border-slate-800 bg-slate-900/80 p-6 shadow-xl shadow-black/20">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold">Device health</h2>
          <p className="text-sm text-slate-400">What needs attention right now, across the fleet.</p>
        </div>
        <div className="rounded-full border border-slate-700 bg-slate-800 px-3 py-1 text-sm text-slate-300">
          {fleet.length} device{fleet.length === 1 ? '' : 's'}
        </div>
      </div>

      {fleet.length === 0 ? (
        <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-8 text-sm text-slate-400">
          No devices reporting yet.
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-slate-800">
          <table className="min-w-full divide-y divide-slate-800 text-left text-sm">
            <thead className="bg-slate-800/80 text-slate-300">
              <tr>
                <th className="px-4 py-3 font-medium">Device</th>
                <th className="px-4 py-3 font-medium">Last seen</th>
                <th className="px-4 py-3 font-medium">Firmware</th>
                <th className="px-4 py-3 font-medium">Backend</th>
                <th className="px-4 py-3 font-medium">Temp / Hum</th>
                <th className="px-4 py-3 font-medium">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800 bg-slate-900/70">
              {fleet.map((entry) => {
                const status = deriveStatus(entry);
                return (
                  <tr key={entry.device.device_id} className="transition hover:bg-slate-800/50">
                    <td className="px-4 py-3">
                      <div className="font-medium text-slate-100">{entry.device.name}</div>
                      <div className="text-xs text-slate-500">{entry.device.device_id}</div>
                    </td>
                    <td className="px-4 py-3 text-slate-300">
                      {formatLastSeen(entry.device.last_seen, entry.isStale)}
                    </td>
                    <td className="px-4 py-3 text-slate-300">{entry.device.fw_version}</td>
                    <td className="px-4 py-3 text-slate-300">{entry.device.active_backend}</td>
                    <td className="px-4 py-3 text-slate-300">
                      {entry.latestTelemetry
                        ? `${entry.latestTelemetry.temp_f.toFixed(1)}°F / ${entry.latestTelemetry.hum}%`
                        : '—'}
                    </td>
                    <td className="px-4 py-3">
                      <div className={`inline-flex rounded-full border px-3 py-1 text-xs font-medium ${statusStyles[status]}`}>
                        {status}
                      </div>
                      <div className="mt-2 text-xs text-slate-500">
                        {entry.recentErrorCount} error{entry.recentErrorCount === 1 ? '' : 's'} (24h)
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
