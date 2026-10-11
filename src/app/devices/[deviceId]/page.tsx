import Link from 'next/link';
import { notFound } from 'next/navigation';
import AutoRefresh from '@/components/AutoRefresh';
import { requireUser } from '@/lib/supabase/auth';
import { createClient, isSupabaseConfigured } from '@/lib/supabase/server';
import { getDeviceTimelineData } from '@/lib/timeline';
import { getActiveSensorFaults, getOutletAttention, STALE_AFTER_MS } from '@/lib/queries';
import type { ActiveSensorFault } from '@/lib/sensorFaults';
import { getActiveOutletAlerts, getOutletAlertHistory, syncOutletAlerts, type OutletAlertHistoryEntry } from '@/lib/alerts';
import type { OutletAlertRow } from '@/lib/types';
import DeviceTimeline from '@/components/DeviceTimeline';
import MonitorTimeline from '@/components/MonitorTimeline';
import { isMonitorOnly } from '@/lib/probes';

const PRESETS = {
  '1h': 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
} as const;

export type Preset = keyof typeof PRESETS;

function isPreset(value: string | undefined): value is Preset {
  return value != null && Object.prototype.hasOwnProperty.call(PRESETS, value);
}

// telemetry: 30-day retention · logs: 60-day retention (docs/monitoring-webapp-plan.md §2)
const TELEMETRY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export default async function DeviceTimelinePage({
  params,
  searchParams,
}: {
  params: { deviceId: string };
  searchParams: { preset?: string; from?: string; to?: string };
}) {
  await requireUser();

  if (!isSupabaseConfigured) {
    return (
      <main className="min-h-screen bg-device-screen p-6 text-device-text">
        <div className="mx-auto max-w-7xl rounded-2xl bg-device-card p-8 text-sm text-device-text-secondary shadow-device">
          Set <code>NEXT_PUBLIC_SUPABASE_URL</code> and <code>NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY</code> to load
          device data.
        </div>
      </main>
    );
  }

  const now = Date.now();
  const preset: Preset = isPreset(searchParams.preset) ? searchParams.preset : '24h';
  const to = searchParams.to ?? new Date(now).toISOString();
  const from = searchParams.from ?? new Date(now - PRESETS[preset]).toISOString();
  const activePreset = searchParams.from || searchParams.to ? null : preset;

  const supabase = createClient();
  const data = supabase ? await getDeviceTimelineData(supabase, params.deviceId, { from, to }) : null;

  if (!data) notFound();

  let outletAlerts: OutletAlertRow[];
  let outletAlertHistory: OutletAlertHistoryEntry[];
  let sensorFaults: ActiveSensorFault[] = [];
  if (supabase) {
    // Current state, whatever range is being viewed — so the escalation
    // check needs the device's latest sample, not the range's last one.
    const { data: latest, error: latestError } = await supabase
      .from('telemetry')
      .select('*')
      .eq('device_id', data.device.device_id)
      .order('created_at', { ascending: false })
      .limit(1);
    if (latestError) throw latestError;
    const latestByDevice = new Map(latest?.length ? [[data.device.device_id, latest[0]]] : []);
    sensorFaults = (await getActiveSensorFaults(supabase, [data.device], latestByDevice)).get(data.device.device_id) ?? [];

    const { mismatches: outletAttention, checkedOutletIndexes } = await getOutletAttention(supabase, data.device);
    const snapshots = outletAttention.map((item) => ({
      outletIndex: item.outletIndex,
      role: item.role,
      loggedState: item.loggedState,
      actualState: item.actualState,
      lastLoggedMessage: item.lastLoggedMessage,
      lastLoggedAt: item.lastLoggedAt,
      mismatchSince: item.mismatchSince,
    }));
    await syncOutletAlerts(supabase, data.device.device_id, snapshots, checkedOutletIndexes);
    const activeAlertsByDevice = await getActiveOutletAlerts(supabase, [data.device.device_id]);
    outletAlerts = activeAlertsByDevice.get(data.device.device_id) ?? [];
    outletAlertHistory = await getOutletAlertHistory(supabase, data.device.device_id);
  } else {
    outletAlerts = [];
    outletAlertHistory = [];
  }

  const retentionWarning =
    new Date(from).getTime() < now - TELEMETRY_RETENTION_MS
      ? 'Part of this range predates the 30-day telemetry retention window — temperature/humidity data before then is already purged.'
      : null;

  const isDeviceOffline = now - new Date(data.device.last_seen).getTime() > STALE_AFTER_MS;

  return (
    <main className="min-h-screen bg-device-screen p-4 text-device-text sm:p-6">
      <div className="mx-auto flex max-w-7xl flex-col gap-4 sm:gap-6">
        <header className="rounded-2xl bg-device-card p-4 shadow-device sm:p-6">
          <Link href="/" className="text-sm text-device-accent hover:underline">
            ← Fleet overview
          </Link>
          <h1 className="mt-2 text-xl font-semibold sm:text-2xl">{data.device.name}</h1>
          <p className="text-sm text-device-text-tertiary">{data.device.device_id}</p>
        </header>

        {/* Only auto-refresh a rolling preset window — a custom from/to range is a
            fixed historical query the user is studying, not a "keep watching" view. */}
        {activePreset && <AutoRefresh intervalMs={20_000} />}
        {isMonitorOnly(data.device) ? (
          <MonitorTimeline
            data={data}
            range={{ from, to }}
            preset={activePreset}
            retentionWarning={retentionWarning}
            isDeviceOffline={isDeviceOffline}
          />
        ) : (
          <DeviceTimeline
            data={data}
            range={{ from, to }}
            preset={activePreset}
            retentionWarning={retentionWarning}
            outletAlerts={outletAlerts}
            sensorFaults={sensorFaults}
            outletAlertHistory={outletAlertHistory}
            isDeviceOffline={isDeviceOffline}
          />
        )}
      </div>
    </main>
  );
}
