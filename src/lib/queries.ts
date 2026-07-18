import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, Device, TelemetryRow } from '@/lib/types';

// devices.last_seen is upserted on a 5-min heartbeat (docs/monitoring-webapp-plan.md §4.1).
const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000;
const STALE_AFTER_MS = HEARTBEAT_INTERVAL_MS * 2;
const ERROR_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface DeviceHealth {
  device: Device;
  latestTelemetry: TelemetryRow | null;
  recentErrorCount: number;
  isStale: boolean;
}

export async function getFleetHealth(supabase: SupabaseClient<Database>): Promise<DeviceHealth[]> {
  const { data: devices, error: devicesError } = await supabase
    .from('devices')
    .select('*')
    .order('name', { ascending: true });

  if (devicesError) throw devicesError;
  if (!devices || devices.length === 0) return [];

  const deviceIds = devices.map((d) => d.device_id);
  const sinceIso = new Date(Date.now() - ERROR_WINDOW_MS).toISOString();

  // Fleet overview needs "latest telemetry row" and "error count" per device.
  // PostgREST has no server-side GROUP BY, so both are approximated by
  // pulling a bounded, most-recent slice and reducing client-side rather
  // than one query per device. Fine at the scale of an internal debugging
  // tool's fleet; a `distinct on (device_id)` Postgres view/RPC would be the
  // right fix if the fleet grows large enough for 1000 rows to not cover
  // every device's latest sample.
  const [{ data: telemetryRows, error: telemetryError }, { data: errorLogRows, error: errorLogsError }] =
    await Promise.all([
      supabase
        .from('telemetry')
        .select('*')
        .in('device_id', deviceIds)
        .order('created_at', { ascending: false })
        .limit(1000),
      supabase
        .from('logs')
        .select('device_id')
        .in('device_id', deviceIds)
        .eq('level', 0)
        .gte('created_at', sinceIso)
        .limit(1000),
    ]);

  if (telemetryError) throw telemetryError;
  if (errorLogsError) throw errorLogsError;

  const latestTelemetryByDevice = new Map<string, TelemetryRow>();
  for (const row of telemetryRows ?? []) {
    if (!latestTelemetryByDevice.has(row.device_id)) {
      latestTelemetryByDevice.set(row.device_id, row);
    }
  }

  const errorCountByDevice = new Map<string, number>();
  for (const row of errorLogRows ?? []) {
    errorCountByDevice.set(row.device_id, (errorCountByDevice.get(row.device_id) ?? 0) + 1);
  }

  const now = Date.now();

  return devices.map((device) => ({
    device,
    latestTelemetry: latestTelemetryByDevice.get(device.device_id) ?? null,
    recentErrorCount: errorCountByDevice.get(device.device_id) ?? 0,
    isStale: now - new Date(device.last_seen).getTime() > STALE_AFTER_MS,
  }));
}
