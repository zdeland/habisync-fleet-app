'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { CRITICAL_ERROR_COUNT, WARNING_ERROR_COUNT, type DeviceHealth } from '@/lib/queries';
import { celsiusToFahrenheit, tempRangeC } from '@/lib/units';
import { GAUGE_COLORS } from '@/lib/gaugeColors';
import { compareFwVersions } from '@/lib/version';
import { toggleFavoriteDevice } from '@/app/actions/favorites';
import type { TelemetryRow, ProfileConfig, OutletAlertRow } from '@/lib/types';

// Mirrors the on-device "status check" component (dot + mono one-liner),
// repurposed here for fleet-level health per docs/style-guide.md §8.
const STATUS_META = {
  healthy: { dot: 'bg-device-good', label: 'HEALTHY' },
  warning: { dot: 'bg-device-heating', label: 'NEEDS ATTENTION' },
  critical: { dot: 'bg-device-alert', label: 'CRITICAL' },
} as const;

// An outlet alert means an outlet's actual state (telemetry.outlet_mask)
// disagrees with what was last logged — the outlet isn't reliably under
// firmware control right now, so the device can't be called healthy while
// that's true. Escalated (a human already confirmed it needs a real fix)
// counts as critical; merely open (detected, not yet triaged) counts as
// warning, matching the WARNING tier's own "NEEDS ATTENTION" label. See
// docs/outlet-alerts.md.
function deriveStatus({ isStale, recentErrorCount, activeOutletAlerts }: DeviceHealth): keyof typeof STATUS_META {
  const hasEscalatedOutletAlert = activeOutletAlerts.some((alert) => alert.status === 'escalated');
  if (isStale || recentErrorCount >= CRITICAL_ERROR_COUNT || hasEscalatedOutletAlert) return 'critical';
  if (recentErrorCount >= WARNING_ERROR_COUNT || activeOutletAlerts.length > 0) return 'warning';
  return 'healthy';
}

type RangeBadge = { className: string; textClassName: string; label: string };

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
): RangeBadge {
  const hasRange = low != null && high != null;

  // The value's color tracks where the reading sits against the device's
  // species-profile range, independent of whether automation is enabled —
  // a disabled device still has a real target (just no outlet acting on
  // it), so the number itself should still read as too-cold/too-hot/etc.
  // The badge below it is the one that keeps announcing CLIMATE AUTOMATION
  // DISABLED/NO TARGET/NO DATA, since that's a different fact (is anything controlling
  // this right now) from "where is the reading relative to target."
  let textClassName: string = GAUGE_COLORS.neutral.textClassName;
  if (hasRange && value != null) {
    if (value < low!) textClassName = lowColor.textClassName;
    else if (value > high!) textClassName = GAUGE_COLORS.alert.textClassName;
    else textClassName = GAUGE_COLORS.good.textClassName;
  }

  if (!enabled || !hasRange) {
    return { className: GAUGE_COLORS.neutral.badgeClassName, textClassName, label: enabled ? 'NO TARGET' : 'CLIMATE AUTOMATION DISABLED' };
  }
  if (value == null) return { className: GAUGE_COLORS.neutral.badgeClassName, textClassName, label: 'NO DATA' };
  if (value < low!) return { className: lowColor.badgeClassName, textClassName, label: lowLabel };
  if (value > high!) return { className: GAUGE_COLORS.alert.badgeClassName, textClassName, label: highLabel };
  return { className: GAUGE_COLORS.good.badgeClassName, textClassName, label: 'IN RANGE' };
}

// Value text is colorized the same way as the badge below it — cool/dry
// when below the device's own species-profile target (custom or preset,
// doesn't matter here, only the resolved temp_low/high_c and hum_low/high
// on that device's profile_config), alert when above, good when in range —
// so the number itself reads at a glance without having to read the badge.
// Rendered identically by the desktop table cell and the phone card, so a
// reading reads the same on both. `valueClassName` is the only thing the
// two disagree on: on a phone, temp and humidity are the whole point of the
// screen and get a display-sized number, where a table cell wants body text.
function RangeValue({
  value,
  unit,
  badge,
  valueClassName = '',
}: {
  value: number | null;
  unit: string;
  badge: RangeBadge;
  valueClassName?: string;
}) {
  return (
    <>
      <div className={`font-mono ${valueClassName} ${badge.textClassName}`}>
        {value != null ? `${value.toFixed(1)}${unit}` : '—'}
      </div>
      <div className={`mt-1 inline-block rounded px-2 py-0.5 text-[0.7em] font-mono font-semibold ${badge.className}`}>
        {badge.label}
      </div>
    </>
  );
}

function RangeCell({ value, unit, badge }: { value: number | null; unit: string; badge: RangeBadge }) {
  return (
    <td className="px-4 py-3">
      <RangeValue value={value} unit={unit} badge={badge} />
    </td>
  );
}

function deriveTempBadge(telemetry: TelemetryRow | null, profileConfig: ProfileConfig): RangeBadge {
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

function deriveHumidityBadge(telemetry: TelemetryRow | null, profileConfig: ProfileConfig): RangeBadge {
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

// Star toggle for favorite_devices (docs/climate-alerts.md) — favoriting a
// device is what makes it eligible for the out-of-range email alerts.
// Optimistic local state + useTransition so the star flips instantly
// instead of waiting on the Server Action round-trip; falls back to the
// last-known prop value if the action throws.
function FavoriteToggle({ deviceId, isFavorite }: { deviceId: string; isFavorite: boolean }) {
  const [optimistic, setOptimistic] = useState(isFavorite);
  const [isPending, startTransition] = useTransition();

  return (
    <button
      type="button"
      aria-label={optimistic ? 'Unfavorite device' : 'Favorite device'}
      aria-pressed={optimistic}
      disabled={isPending}
      onClick={(event) => {
        event.stopPropagation();
        const next = !optimistic;
        setOptimistic(next);
        startTransition(async () => {
          try {
            await toggleFavoriteDevice(deviceId, next);
          } catch {
            setOptimistic(!next); // revert on failure
          }
        });
      }}
      className={`text-lg leading-none transition hover:text-device-heating disabled:opacity-50 ${
        optimistic ? 'text-device-heating' : 'text-device-text-tertiary'
      }`}
    >
      {optimistic ? '★' : '☆'}
    </button>
  );
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

// Everything a row needs that's computed rather than read straight off the
// entry. Derived once, then handed to both presentations below — the phone
// cards and the desktop table state the same facts about a device, so this
// lives here rather than in either renderer, where the two could quietly
// drift apart the way two copies of the column list would.
type DeviceRow = {
  entry: DeviceHealth;
  href: string;
  status: (typeof STATUS_META)[keyof typeof STATUS_META];
  tempF: number | null;
  hum: number | null;
  tempBadge: RangeBadge;
  humBadge: RangeBadge;
  isOutdated: boolean;
  lastSeenLabel: string;
};

function deriveRow(entry: DeviceHealth, latestFwVersion: string | null): DeviceRow {
  return {
    entry,
    href: `/devices/${entry.device.device_id}`,
    status: STATUS_META[deriveStatus(entry)],
    tempF: entry.latestTelemetry ? celsiusToFahrenheit(entry.latestTelemetry.temp_c) : null,
    hum: entry.latestTelemetry?.hum ?? null,
    tempBadge: deriveTempBadge(entry.latestTelemetry, entry.device.profile_config),
    humBadge: deriveHumidityBadge(entry.latestTelemetry, entry.device.profile_config),
    isOutdated: latestFwVersion != null && compareFwVersions(entry.device.fw_version, latestFwVersion) < 0,
    lastSeenLabel: formatLastSeen(entry.device.last_seen, entry.isStale),
  };
}

// The nine-column table can't be read on a phone — even scrolled, finding a
// humidity reading means swiping past six columns nobody opened the page
// for. Below `md` each device becomes a card instead, ordered by what you
// actually came to check: which device, how warm, how humid. Status stays
// on the top line because it's the reason you'd tap in; firmware, backend,
// error count and last-seen are demoted to one muted footer line, still
// present but no longer competing.
function DeviceCard({ row, isFavorite }: { row: DeviceRow; isFavorite: boolean }) {
  const router = useRouter();
  const { entry, href, status, tempF, hum, tempBadge, humBadge, isOutdated, lastSeenLabel } = row;

  return (
    <div
      onClick={() => router.push(href)}
      className="cursor-pointer rounded-xl bg-device-surface p-4 transition active:bg-device-surface-hover"
    >
      <div className="flex items-start gap-3">
        <FavoriteToggle deviceId={entry.device.device_id} isFavorite={isFavorite} />
        {/* min-w-0 so a long device name truncates instead of shoving the
            status label off the right edge — the same clipping-with-no-way-
            back that made this redesign necessary. */}
        <div className="min-w-0 flex-1">
          <Link
            href={href}
            onClick={(event) => event.stopPropagation()}
            className="block truncate font-medium text-device-text hover:text-device-accent hover:underline"
          >
            {entry.device.name}
          </Link>
          <div className="truncate font-mono text-xs text-device-text-tertiary">{entry.device.device_id}</div>
        </div>
        <div className="flex flex-shrink-0 items-center gap-1.5 pt-0.5 font-mono text-[0.7em] text-device-text-secondary">
          <span className={`h-2 w-2 flex-shrink-0 rounded-full ${status.dot}`} />
          <span>{status.label}</span>
        </div>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2">
        <div className="rounded-lg bg-white/5 p-3">
          <p className="text-[0.7em] font-medium uppercase tracking-wider text-device-text-tertiary">Temp</p>
          <RangeValue value={tempF} unit="°F" badge={tempBadge} valueClassName="mt-0.5 text-xl" />
        </div>
        <div className="rounded-lg bg-white/5 p-3">
          <p className="text-[0.7em] font-medium uppercase tracking-wider text-device-text-tertiary">Humidity</p>
          <RangeValue value={hum} unit="%" badge={humBadge} valueClassName="mt-0.5 text-xl" />
        </div>
      </div>

      {entry.activeOutletAlerts.length > 0 && (
        <div className="mt-3">
          <AttentionCell alerts={entry.activeOutletAlerts} href={href} />
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[0.7em] text-device-text-tertiary">
        <span>{lastSeenLabel}</span>
        <span aria-hidden="true">·</span>
        <span>
          {entry.recentErrorCount} error{entry.recentErrorCount === 1 ? '' : 's'} (24h)
        </span>
        <span aria-hidden="true">·</span>
        <span className={isOutdated ? 'text-device-heating' : undefined}>
          {entry.device.fw_version}
          {isOutdated && ' · OUTDATED'}
        </span>
        <span aria-hidden="true">·</span>
        <span>{entry.device.active_backend}</span>
      </div>
    </div>
  );
}

// Shared thead + tbody markup for both the active table and the collapsed
// offline one below it — kept as one component so the two sections can't
// drift out of sync on columns.
function DeviceTable({ rows, favoriteDeviceIds }: { rows: DeviceRow[]; favoriteDeviceIds: Set<string> }) {
  const router = useRouter();

  return (
    <table className="min-w-full divide-y divide-white/10 text-left text-sm">
      <thead className="bg-device-surface text-device-text-secondary">
        <tr>
          <th className="px-4 py-3 font-medium">
            <span className="sr-only">Favorite</span>
          </th>
          <th className="px-4 py-3 font-medium">Device</th>
          <th className="px-4 py-3 font-medium">Temp</th>
          <th className="px-4 py-3 font-medium">Humidity</th>
          <th className="px-4 py-3 font-medium">Device Status</th>
          <th className="px-4 py-3 font-medium">Attention</th>
          <th className="px-4 py-3 font-medium">Last seen</th>
          <th className="px-4 py-3 font-medium">Firmware</th>
          <th className="px-4 py-3 font-medium">Backend</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-white/10">
        {rows.map(({ entry, href, status, tempF, hum, tempBadge, humBadge, isOutdated, lastSeenLabel }) => (
          <tr
            key={entry.device.device_id}
            onClick={() => router.push(href)}
            className="cursor-pointer transition hover:bg-device-surface-hover"
          >
            <td className="px-4 py-3">
              <FavoriteToggle deviceId={entry.device.device_id} isFavorite={favoriteDeviceIds.has(entry.device.device_id)} />
            </td>
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
            <RangeCell value={tempF} unit="°F" badge={tempBadge} />
            <RangeCell value={hum} unit="%" badge={humBadge} />
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
            <td className="px-4 py-3 text-device-text-secondary">{lastSeenLabel}</td>
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
        ))}
      </tbody>
    </table>
  );
}

// One list of devices, rendered as cards on phones and as the wide table
// from `md` up. Both branches are fed the same derived rows, and only one
// is ever in the layout at a time.
function DeviceRows({
  fleet,
  latestFwVersion,
  favoriteDeviceIds,
}: {
  fleet: DeviceHealth[];
  latestFwVersion: string | null;
  favoriteDeviceIds: Set<string>;
}) {
  const rows = fleet.map((entry) => deriveRow(entry, latestFwVersion));

  return (
    <>
      <div className="flex flex-col gap-3 md:hidden">
        {rows.map((row) => (
          <DeviceCard
            key={row.entry.device.device_id}
            row={row}
            isFavorite={favoriteDeviceIds.has(row.entry.device.device_id)}
          />
        ))}
      </div>
      {/* overflow-x-auto, not overflow-hidden: `hidden` clipped every column
          past the container edge with no way to reach it. The cards above
          are the real answer on a phone; this keeps a narrow tablet honest. */}
      <div className="hidden overflow-x-auto rounded-xl md:block">
        <DeviceTable rows={rows} favoriteDeviceIds={favoriteDeviceIds} />
      </div>
    </>
  );
}

export default function FleetTable({
  fleet,
  favoriteDeviceIds,
}: {
  fleet: DeviceHealth[];
  favoriteDeviceIds: Set<string>;
}) {
  // "Latest" here means the newest version reported anywhere in this fleet
  // right now — there's no external firmware release feed this read-only
  // app can check against, only what devices have actually reported.
  const latestFwVersion = fleet.reduce<string | null>(
    (latest, entry) =>
      latest == null || compareFwVersions(entry.device.fw_version, latest) > 0 ? entry.device.fw_version : latest,
    null,
  );

  // "Offline" here reuses the same staleness signal as the Status column
  // (no heartbeat in the last 10 min, see STALE_AFTER_MS in lib/queries.ts)
  // rather than introducing a second definition of down.
  const activeFleet = fleet.filter((entry) => !entry.isStale);
  const offlineFleet = fleet.filter((entry) => entry.isStale);

  return (
    <div className="flex flex-col gap-4">
      {activeFleet.length > 0 && (
        <DeviceRows fleet={activeFleet} latestFwVersion={latestFwVersion} favoriteDeviceIds={favoriteDeviceIds} />
      )}
      {offlineFleet.length > 0 && (
        // Native <details> keeps this keyboard/screen-reader accessible for
        // free instead of hand-rolling open/close state (same pattern as
        // DeviceTimeline.tsx's collapsible sections).
        <details className="group">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3 rounded-xl bg-device-surface px-4 py-3 text-device-text-secondary">
            <span className="font-medium">
              Offline devices ({offlineFleet.length})
            </span>
            <span className="text-device-text-tertiary transition group-open:rotate-180">▾</span>
          </summary>
          <div className="pt-3">
            <DeviceRows fleet={offlineFleet} latestFwVersion={latestFwVersion} favoriteDeviceIds={favoriteDeviceIds} />
          </div>
        </details>
      )}
    </div>
  );
}
