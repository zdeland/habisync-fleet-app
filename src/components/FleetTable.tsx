'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { CRITICAL_ERROR_COUNT, WARNING_ERROR_COUNT, type DeviceHealth } from '@/lib/queries';
import { celsiusToFahrenheit, tempRangeC } from '@/lib/units';
import { GAUGE_COLORS } from '@/lib/gaugeColors';
import { compareFwVersions } from '@/lib/version';
import type { TelemetryRow, ProfileConfig, OutletAlertRow } from '@/lib/types';

// Mirrors the on-device "status check" component (dot + mono one-liner),
// repurposed here for fleet-level health per docs/style-guide.md §8.
const STATUS_META = {
  healthy: { dot: 'bg-device-good', label: 'HEALTHY' },
  warning: { dot: 'bg-device-heating', label: 'NEEDS ATTENTION' },
  critical: { dot: 'bg-device-alert', label: 'CRITICAL' },
} as const;

// Deliberately independent of outlet alerts (see the Attention column below)
// — an open outlet alert can itself be stale/no-longer-current (it's a
// human-managed workflow item, not a live health signal), so it's never
// folded into this HEALTHY/WARNING/CRITICAL rollup.
function deriveStatus({ isStale, recentErrorCount }: DeviceHealth): keyof typeof STATUS_META {
  if (isStale || recentErrorCount >= CRITICAL_ERROR_COUNT) return 'critical';
  if (recentErrorCount >= WARNING_ERROR_COUNT) return 'warning';
  return 'healthy';
}

// Simple snapshot compare against the user-defined range — unlike the device
// timeline's gauges, the fleet table only has the latest telemetry point (no
// history to replay through automation.ts), so there's no hysteresis or
// shared-outlet ambiguity to resolve here, just "is the latest reading
// inside the target band right now."
function deriveRangeBadge(
  value: number | null,
  low: number | undefined,
  high: number | undefined,
  enabled: boolean,
  lowLabel: string,
  highLabel: string,
  lowColor: typeof GAUGE_COLORS.cool,
): { className: string; label: string } {
  if (!enabled || low == null || high == null) {
    return { className: GAUGE_COLORS.neutral.badgeClassName, label: enabled ? 'NO TARGET' : 'DISABLED' };
  }
  if (value == null) return { className: GAUGE_COLORS.neutral.badgeClassName, label: 'NO DATA' };
  if (value < low) return { className: lowColor.badgeClassName, label: lowLabel };
  if (value > high) return { className: GAUGE_COLORS.alert.badgeClassName, label: highLabel };
  return { className: GAUGE_COLORS.good.badgeClassName, label: 'IN RANGE' };
}

function RangeCell({ value, unit, badge }: { value: number | null; unit: string; badge: { className: string; label: string } }) {
  return (
    <td className="px-4 py-3">
      <div className="font-mono text-device-text">{value != null ? `${value.toFixed(1)}${unit}` : '—'}</div>
      <div className={`mt-1 inline-block rounded px-2 py-0.5 text-[0.7em] font-mono font-semibold ${badge.className}`}>
        {badge.label}
      </div>
    </td>
  );
}

function deriveTempBadge(telemetry: TelemetryRow | null, profileConfig: ProfileConfig): { className: string; label: string } {
  const range = tempRangeC(profileConfig);
  return deriveRangeBadge(
    telemetry ? celsiusToFahrenheit(telemetry.temp_c) : null,
    range ? celsiusToFahrenheit(range.low) : undefined,
    range ? celsiusToFahrenheit(range.high) : undefined,
    profileConfig.enabled,
    'TOO COLD',
    'TOO HOT',
    GAUGE_COLORS.cool,
  );
}

function deriveHumidityBadge(telemetry: TelemetryRow | null, profileConfig: ProfileConfig): { className: string; label: string } {
  return deriveRangeBadge(
    telemetry?.hum ?? null,
    profileConfig.hum_low,
    profileConfig.hum_high,
    profileConfig.enabled,
    'TOO DRY',
    'TOO HUMID',
    GAUGE_COLORS.dry,
  );
}

function formatLastSeen(lastSeen: string, isStale: boolean): string {
  const diffMs = Date.now() - new Date(lastSeen).getTime();
  const diffMin = Math.round(diffMs / 60_000);
  const label = diffMin < 1 ? 'just now' : diffMin < 60 ? `${diffMin} min ago` : `${Math.round(diffMin / 60)}h ago`;
  return isStale ? `${label} (stale)` : label;
}

// A separate column, not a Status badge — see docs/outlet-alerts.md: these
// are human-managed workflow items (open until someone closes/escalates
// them via the device page) that can themselves be stale, not a live
// health signal to blend into HEALTHY/WARNING/CRITICAL above.
function AttentionCell({ alerts, href }: { alerts: OutletAlertRow[]; href: string }) {
  if (alerts.length === 0) {
    return <span className="text-xs text-device-text-tertiary">—</span>;
  }

  const openCount = alerts.filter((alert) => alert.status === 'open').length;
  const escalatedCount = alerts.filter((alert) => alert.status === 'escalated').length;

  return (
    <Link href={href} onClick={(event) => event.stopPropagation()} className="flex w-fit flex-col gap-1">
      {openCount > 0 && (
        <span className="inline-flex w-fit items-center gap-1 rounded border border-device-heating/40 bg-device-heating/10 px-2 py-0.5 font-mono text-[0.7em] font-semibold text-device-heating">
          ⚠ {openCount} open
        </span>
      )}
      {escalatedCount > 0 && (
        <span className="inline-flex w-fit items-center gap-1 rounded border border-device-alert/40 bg-device-alert/10 px-2 py-0.5 font-mono text-[0.7em] font-semibold text-device-alert">
          🚩 {escalatedCount} escalated
        </span>
      )}
    </Link>
  );
}

export default function FleetTable({ fleet }: { fleet: DeviceHealth[] }) {
  const router = useRouter();

  // "Latest" here means the newest version reported anywhere in this fleet
  // right now — there's no external firmware release feed this read-only
  // app can check against, only what devices have actually reported.
  const latestFwVersion = fleet.reduce<string | null>(
    (latest, entry) =>
      latest == null || compareFwVersions(entry.device.fw_version, latest) > 0 ? entry.device.fw_version : latest,
    null,
  );

  return (
    <div className="overflow-hidden rounded-xl">
      <table className="min-w-full divide-y divide-white/10 text-left text-sm">
        <thead className="bg-device-surface text-device-text-secondary">
          <tr>
            <th className="px-4 py-3 font-medium">Device</th>
            <th className="px-4 py-3 font-medium">Status</th>
            <th className="px-4 py-3 font-medium">Attention</th>
            <th className="px-4 py-3 font-medium">Temp</th>
            <th className="px-4 py-3 font-medium">Humidity</th>
            <th className="px-4 py-3 font-medium">Last seen</th>
            <th className="px-4 py-3 font-medium">Firmware</th>
            <th className="px-4 py-3 font-medium">Backend</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-white/10">
          {fleet.map((entry) => {
            const status = STATUS_META[deriveStatus(entry)];
            const href = `/devices/${entry.device.device_id}`;
            const tempF = entry.latestTelemetry ? celsiusToFahrenheit(entry.latestTelemetry.temp_c) : null;
            const tempBadge = deriveTempBadge(entry.latestTelemetry, entry.device.profile_config);
            const humBadge = deriveHumidityBadge(entry.latestTelemetry, entry.device.profile_config);
            const isOutdated =
              latestFwVersion != null && compareFwVersions(entry.device.fw_version, latestFwVersion) < 0;
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
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2 font-mono text-xs">
                    <span className={`h-2.5 w-2.5 flex-shrink-0 rounded-full ${status.dot}`} />
                    <span>{status.label}</span>
                  </div>
                  <div className="mt-1 text-xs text-device-text-tertiary">
                    {entry.recentErrorCount} error{entry.recentErrorCount === 1 ? '' : 's'} (24h)
                  </div>
                </td>
                <td className="px-4 py-3">
                  <AttentionCell alerts={entry.activeOutletAlerts} href={href} />
                </td>
                <RangeCell value={tempF} unit="°F" badge={tempBadge} />
                <RangeCell value={entry.latestTelemetry?.hum ?? null} unit="%" badge={humBadge} />
                <td className="px-4 py-3 text-device-text-secondary">
                  {formatLastSeen(entry.device.last_seen, entry.isStale)}
                </td>
                <td className="px-4 py-3 text-device-text-secondary">
                  <span className={isOutdated ? 'text-device-heating' : undefined}>{entry.device.fw_version}</span>
                  {isOutdated && (
                    <div className="mt-1 inline-block rounded px-2 py-0.5 text-[0.7em] font-mono font-semibold border border-device-heating/40 bg-device-heating/10 text-device-heating">
                      OUTDATED
                    </div>
                  )}
                </td>
                <td className="px-4 py-3 text-device-text-secondary">{entry.device.active_backend}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
