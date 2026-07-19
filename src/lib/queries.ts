import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, Device, LogRow, OutletAlertRow, TelemetryRow } from '@/lib/types';
import { getActiveOutletAlerts, syncOutletAlerts, type AlertSnapshot } from '@/lib/alerts';

// devices.last_seen is upserted on a 5-min heartbeat (docs/monitoring-webapp-plan.md §4.1).
// Exported so src/lib/health.ts's per-timeline offline/severity detection
// can't drift from the fleet-wide definition of "stale"/"unhealthy" here.
export const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000;
export const STALE_AFTER_MS = HEARTBEAT_INTERVAL_MS * 2;
export const ERROR_WINDOW_MS = 24 * 60 * 60 * 1000;
export const WARNING_ERROR_COUNT = 1;
export const CRITICAL_ERROR_COUNT = 5;

// docs/firmware-handoff-untracked-outlet-transition.md: a firmware bug can
// flip an outlet without ever writing the paired tag='event' row, leaving
// the last logged outlet_state permanently disagreeing with reality. A
// single-sample mismatch also happens on every *normal* transition for the
// one telemetry beat between the flip and its event row landing, so require
// the mismatch to hold across this many of the most recent telemetry
// samples before treating it as the bug rather than that ordinary lag.
export const OUTLET_MISMATCH_DEBOUNCE_SAMPLES = 2;

export type OutletMismatch = {
  outletIndex: number;
  role: string;
  loggedState: boolean; // outlet_state of the last tag='event' row for this outlet
  actualState: boolean; // current telemetry.outlet_mask bit for this outlet
};

export interface DeviceHealth {
  device: Device;
  latestTelemetry: TelemetryRow | null;
  recentErrorCount: number;
  isStale: boolean;
  // Deliberately separate from isStale/recentErrorCount (and NOT folded into
  // FleetTable's HEALTHY/WARNING/CRITICAL status) — an outlet alert can be
  // stale/no-longer-current itself (see docs/outlet-alerts.md), so it's
  // rendered as its own item rather than blended into overall device health.
  activeOutletAlerts: OutletAlertRow[];
}

// Exported for testing; see getFleetHealth for how it's fed.
export function computeOutletMismatches(
  device: Device,
  recentTelemetry: TelemetryRow[], // newest-first, at least OUTLET_MISMATCH_DEBOUNCE_SAMPLES to flag anything
  lastLoggedStateByOutlet: Map<number, boolean>,
): OutletMismatch[] {
  if (recentTelemetry.length < OUTLET_MISMATCH_DEBOUNCE_SAMPLES) return [];

  const debounceWindow = recentTelemetry.slice(0, OUTLET_MISMATCH_DEBOUNCE_SAMPLES);
  const mismatches: OutletMismatch[] = [];

  device.outlet_roles.forEach((role, index) => {
    const loggedState = lastLoggedStateByOutlet.get(index);
    if (loggedState === undefined) return; // no event ever logged for this outlet — different problem

    const actualState = Boolean(debounceWindow[0].outlet_mask & (1 << index));
    const allSamplesMismatch = debounceWindow.every(
      (row) => Boolean(row.outlet_mask & (1 << index)) === actualState && actualState !== loggedState,
    );
    if (allSamplesMismatch) {
      mismatches.push({ outletIndex: index, role, loggedState, actualState });
    }
  });

  return mismatches;
}

export type OutletAttention = OutletMismatch & {
  lastLoggedAt: string;
  lastLoggedDeviceTime: string | null;
  lastLoggedMessage: string;
  actualStateAt: string; // most recent telemetry sample's created_at
  // Oldest telemetry sample (within ATTENTION_TELEMETRY_LOOKBACK) that already
  // showed actualState, walking back contiguously from the latest sample —
  // i.e. "the mismatch has held at least since here."
  mismatchSince: string;
  // True when actualState held for the *entire* fetched lookback window —
  // the real start could be further back than mismatchSince actually shows.
  mismatchSinceIsLowerBound: boolean;
};

// Deep enough to usually find where a persistent mismatch actually started,
// without an unbounded per-device scan (~8h of history at the 60s telemetry
// cadence from docs/automation-rules.md §9).
const ATTENTION_TELEMETRY_LOOKBACK = 500;
const ATTENTION_EVENT_LOOKBACK = 200;

// Single-device, richer sibling of computeOutletMismatches — for the device
// page's "needs attention" card, which wants the actual last-logged message/
// timestamp and how far back the mismatch traces, not just a fleet-table
// boolean.
export async function getOutletAttention(
  supabase: SupabaseClient<Database>,
  device: Device,
): Promise<OutletAttention[]> {
  const [{ data: telemetryRows, error: telemetryError }, { data: eventRows, error: eventsError }] = await Promise.all([
    supabase
      .from('telemetry')
      .select('*')
      .eq('device_id', device.device_id)
      .order('created_at', { ascending: false })
      .limit(ATTENTION_TELEMETRY_LOOKBACK),
    supabase
      .from('logs')
      .select('*')
      .eq('device_id', device.device_id)
      .eq('tag', 'event')
      .not('outlet_index', 'is', null)
      .order('created_at', { ascending: false })
      .limit(ATTENTION_EVENT_LOOKBACK),
  ]);

  if (telemetryError) throw telemetryError;
  if (eventsError) throw eventsError;

  const telemetry = telemetryRows ?? []; // newest-first
  if (telemetry.length === 0) return [];

  const lastEventByOutlet = new Map<number, LogRow>();
  for (const row of eventRows ?? []) {
    if (row.outlet_index == null || row.outlet_state == null) continue;
    if (!lastEventByOutlet.has(row.outlet_index)) {
      lastEventByOutlet.set(row.outlet_index, row);
    }
  }

  const lastLoggedStateByOutlet = new Map<number, boolean>();
  lastEventByOutlet.forEach((row, index) => {
    lastLoggedStateByOutlet.set(index, row.outlet_state as boolean);
  });

  const mismatches = computeOutletMismatches(device, telemetry, lastLoggedStateByOutlet);

  return mismatches.map((mismatch) => {
    const event = lastEventByOutlet.get(mismatch.outletIndex)!;

    let mismatchSince = telemetry[0].created_at;
    let mismatchSinceIsLowerBound = true;
    for (const row of telemetry) {
      if (Boolean(row.outlet_mask & (1 << mismatch.outletIndex)) !== mismatch.actualState) {
        mismatchSinceIsLowerBound = false;
        break;
      }
      mismatchSince = row.created_at;
    }

    return {
      ...mismatch,
      lastLoggedAt: event.created_at,
      lastLoggedDeviceTime: event.device_time,
      lastLoggedMessage: event.message,
      actualStateAt: telemetry[0].created_at,
      mismatchSince,
      mismatchSinceIsLowerBound,
    };
  });
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

  // Fleet overview needs "latest telemetry row" and "error count" per device,
  // plus the outlet-mismatch debounce window needs the last
  // OUTLET_MISMATCH_DEBOUNCE_SAMPLES telemetry rows. PostgREST has no
  // server-side GROUP BY, so all three are approximated by pulling a
  // bounded, most-recent slice and reducing client-side rather than one
  // query per device. Fine at the scale of an internal debugging tool's
  // fleet; a `distinct on (device_id)` Postgres view/RPC would be the right
  // fix if the fleet grows large enough for these limits to not cover every
  // device.
  const [
    { data: telemetryRows, error: telemetryError },
    { data: errorLogRows, error: errorLogsError },
    { data: outletEventRows, error: outletEventsError },
  ] = await Promise.all([
    supabase
      .from('telemetry')
      .select('*')
      .in('device_id', deviceIds)
      .order('created_at', { ascending: false })
      .limit(1000 * OUTLET_MISMATCH_DEBOUNCE_SAMPLES),
    supabase
      .from('logs')
      .select('device_id')
      .in('device_id', deviceIds)
      .eq('level', 0)
      .gte('created_at', sinceIso)
      .limit(1000),
    supabase
      .from('logs')
      .select('device_id, outlet_index, outlet_state, message, created_at')
      .in('device_id', deviceIds)
      .eq('tag', 'event')
      .not('outlet_index', 'is', null)
      .order('created_at', { ascending: false })
      .limit(1000),
  ]);

  if (telemetryError) throw telemetryError;
  if (errorLogsError) throw errorLogsError;
  if (outletEventsError) throw outletEventsError;

  const latestTelemetryByDevice = new Map<string, TelemetryRow>();
  const recentTelemetryByDevice = new Map<string, TelemetryRow[]>();
  for (const row of telemetryRows ?? []) {
    if (!latestTelemetryByDevice.has(row.device_id)) {
      latestTelemetryByDevice.set(row.device_id, row);
    }
    const recent = recentTelemetryByDevice.get(row.device_id) ?? [];
    if (recent.length < OUTLET_MISMATCH_DEBOUNCE_SAMPLES) {
      recent.push(row);
      recentTelemetryByDevice.set(row.device_id, recent);
    }
  }

  const errorCountByDevice = new Map<string, number>();
  for (const row of errorLogRows ?? []) {
    errorCountByDevice.set(row.device_id, (errorCountByDevice.get(row.device_id) ?? 0) + 1);
  }

  // Most recent tag='event' row per (device, outlet index) — both the plain
  // outlet_state (for computeOutletMismatches) and the full message/
  // timestamp (to snapshot into a new outlet_alerts row, see below).
  type LastEvent = { outlet_state: boolean; message: string; created_at: string };
  const lastEventByDeviceOutlet = new Map<string, Map<number, LastEvent>>();
  for (const row of outletEventRows ?? []) {
    if (row.outlet_index == null || row.outlet_state == null) continue;
    const byOutlet = lastEventByDeviceOutlet.get(row.device_id) ?? new Map<number, LastEvent>();
    if (!byOutlet.has(row.outlet_index)) {
      byOutlet.set(row.outlet_index, { outlet_state: row.outlet_state, message: row.message, created_at: row.created_at });
      lastEventByDeviceOutlet.set(row.device_id, byOutlet);
    }
  }

  const now = Date.now();

  // Detect mismatches per device, then reconcile each into outlet_alerts
  // (see src/lib/alerts.ts) so one shows up as a close/escalate-able alert
  // fleet-wide as soon as it's detected, not only once a human opens that
  // device's page (which runs its own, deeper detection via
  // getOutletAttention).
  const snapshotsByDevice = new Map<string, AlertSnapshot[]>();
  for (const device of devices) {
    const recentTelemetry = recentTelemetryByDevice.get(device.device_id) ?? [];
    const lastEventByOutlet = lastEventByDeviceOutlet.get(device.device_id);
    const lastLoggedStateByOutlet = new Map<number, boolean>();
    lastEventByOutlet?.forEach((event, index) => lastLoggedStateByOutlet.set(index, event.outlet_state));

    const mismatches = computeOutletMismatches(device, recentTelemetry, lastLoggedStateByOutlet);
    if (mismatches.length === 0) continue;

    // Oldest sample in the (shallow, 2-sample) debounce window — a coarser
    // lower-bound than getOutletAttention's deeper scan, refined later if
    // a human opens the device page (see syncOutletAlerts).
    const mismatchSince = recentTelemetry[recentTelemetry.length - 1]?.created_at ?? recentTelemetry[0]?.created_at;
    if (!mismatchSince) continue;

    snapshotsByDevice.set(
      device.device_id,
      mismatches.map((mismatch) => {
        const event = lastEventByOutlet?.get(mismatch.outletIndex);
        return {
          outletIndex: mismatch.outletIndex,
          role: mismatch.role,
          loggedState: mismatch.loggedState,
          actualState: mismatch.actualState,
          lastLoggedMessage: event?.message ?? '',
          lastLoggedAt: event?.created_at ?? mismatchSince,
          mismatchSince,
        };
      }),
    );
  }

  await Promise.all(
    Array.from(snapshotsByDevice.entries()).map(([deviceId, snapshots]) =>
      syncOutletAlerts(supabase, deviceId, snapshots),
    ),
  );

  const activeAlertsByDevice = await getActiveOutletAlerts(supabase, deviceIds);

  return devices.map((device) => ({
    device,
    latestTelemetry: latestTelemetryByDevice.get(device.device_id) ?? null,
    recentErrorCount: errorCountByDevice.get(device.device_id) ?? 0,
    isStale: now - new Date(device.last_seen).getTime() > STALE_AFTER_MS,
    activeOutletAlerts: activeAlertsByDevice.get(device.device_id) ?? [],
  }));
}
