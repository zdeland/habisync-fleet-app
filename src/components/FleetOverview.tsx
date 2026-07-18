import Link from 'next/link';
import { createClient, isSupabaseConfigured } from '@/lib/supabase/server';
import { getFleetHealth, type DeviceHealth } from '@/lib/queries';

// Mirrors the on-device "status check" component (dot + mono one-liner),
// repurposed here for fleet-level health per docs/style-guide.md §8.
const STATUS_META = {
  healthy: { dot: 'bg-device-good', label: 'HEALTHY' },
  warning: { dot: 'bg-device-heating', label: 'NEEDS ATTENTION' },
  critical: { dot: 'bg-device-alert', label: 'CRITICAL' },
} as const;

function deriveStatus({ isStale, recentErrorCount }: DeviceHealth): keyof typeof STATUS_META {
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
        <div className="overflow-hidden rounded-xl">
          <table className="min-w-full divide-y divide-white/10 text-left text-sm">
            <thead className="bg-device-surface text-device-text-secondary">
              <tr>
                <th className="px-4 py-3 font-medium">Device</th>
                <th className="px-4 py-3 font-medium">Last seen</th>
                <th className="px-4 py-3 font-medium">Firmware</th>
                <th className="px-4 py-3 font-medium">Backend</th>
                <th className="px-4 py-3 font-medium">Temp / Hum</th>
                <th className="px-4 py-3 font-medium">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/10">
              {fleet.map((entry) => {
                const status = STATUS_META[deriveStatus(entry)];
                return (
                  <tr key={entry.device.device_id} className="transition hover:bg-device-surface-hover">
                    <td className="px-4 py-3">
                      <Link
                        href={`/devices/${entry.device.device_id}`}
                        className="font-medium text-device-text hover:text-device-accent hover:underline"
                      >
                        {entry.device.name}
                      </Link>
                      <div className="text-xs text-device-text-tertiary">{entry.device.device_id}</div>
                    </td>
                    <td className="px-4 py-3 text-device-text-secondary">
                      {formatLastSeen(entry.device.last_seen, entry.isStale)}
                    </td>
                    <td className="px-4 py-3 text-device-text-secondary">{entry.device.fw_version}</td>
                    <td className="px-4 py-3 text-device-text-secondary">{entry.device.active_backend}</td>
                    <td className="px-4 py-3 text-device-text-secondary">
                      {entry.latestTelemetry
                        ? `${entry.latestTelemetry.temp_f.toFixed(1)}°F / ${entry.latestTelemetry.hum}%`
                        : '—'}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2 font-mono text-xs">
                        <span className={`h-2.5 w-2.5 flex-shrink-0 rounded-full ${status.dot}`} />
                        <span>{status.label}</span>
                      </div>
                      <div className="mt-1 text-xs text-device-text-tertiary">
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
