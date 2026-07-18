'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { DeviceHealth } from '@/lib/queries';

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

export default function FleetTable({ fleet }: { fleet: DeviceHealth[] }) {
  const router = useRouter();

  return (
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
            const href = `/devices/${entry.device.device_id}`;
            return (
              <tr
                key={entry.device.device_id}
                onClick={() => router.push(href)}
                className="cursor-pointer transition hover:bg-device-surface-hover"
              >
                <td className="px-4 py-3">
                  <Link
                    href={href}
                    onClick={(event) => event.stopPropagation()}
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
  );
}
