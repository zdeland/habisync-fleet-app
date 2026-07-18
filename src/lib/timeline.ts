import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, Device, LogRow, ProfileConfig, TelemetryRow } from '@/lib/types';

export type TimeRange = { from: string; to: string }; // ISO timestamps

export type DeviceTimelineData = {
  device: Device;
  // Ascending by created_at. `telemetry`/`configLogs` each include one row
  // from before `range.from` (if one exists) as a seed, so state can be
  // reconstructed correctly right at the start of the window rather than
  // only once the first in-range sample arrives.
  telemetry: TelemetryRow[];
  events: LogRow[]; // tag='event' rows within the range — outlet overlay + markers
  allLogs: LogRow[]; // every log row within the range, any tag — timeline markers + context panel
  configLogs: LogRow[]; // tag='config' rows, includes the pre-range seed
};

export async function getDeviceTimelineData(
  supabase: SupabaseClient<Database>,
  deviceId: string,
  range: TimeRange,
): Promise<DeviceTimelineData | null> {
  const { data: device, error: deviceError } = await supabase
    .from('devices')
    .select('*')
    .eq('device_id', deviceId)
    .maybeSingle();
  if (deviceError) throw deviceError;
  if (!device) return null;

  // Bounded rather than unbounded per docs/monitoring-webapp-plan.md's
  // pagination note — enough rows for a week at the ~60s telemetry cadence.
  // Wide ranges should eventually downsample instead of raising this limit
  // further; deferred for this first pass.
  const ROW_LIMIT = 20_000;

  const [
    { data: telemetryInRange, error: telemetryError },
    { data: seedTelemetry, error: seedTelemetryError },
    { data: logsInRange, error: logsError },
    { data: seedConfig, error: seedConfigError },
  ] = await Promise.all([
    supabase
      .from('telemetry')
      .select('*')
      .eq('device_id', deviceId)
      .gte('created_at', range.from)
      .lte('created_at', range.to)
      .order('created_at', { ascending: true })
      .limit(ROW_LIMIT),
    supabase
      .from('telemetry')
      .select('*')
      .eq('device_id', deviceId)
      .lt('created_at', range.from)
      .order('created_at', { ascending: false })
      .limit(1),
    supabase
      .from('logs')
      .select('*')
      .eq('device_id', deviceId)
      .gte('created_at', range.from)
      .lte('created_at', range.to)
      .order('created_at', { ascending: true })
      .limit(ROW_LIMIT),
    supabase
      .from('logs')
      .select('*')
      .eq('device_id', deviceId)
      .eq('tag', 'config')
      .lt('created_at', range.from)
      .order('created_at', { ascending: false })
      .limit(1),
  ]);

  if (telemetryError) throw telemetryError;
  if (seedTelemetryError) throw seedTelemetryError;
  if (logsError) throw logsError;
  if (seedConfigError) throw seedConfigError;

  const telemetry = [...(seedTelemetry ?? []), ...(telemetryInRange ?? [])];
  const allLogs = logsInRange ?? [];
  const events = allLogs.filter((row) => row.tag === 'event');
  const configLogs = [...(seedConfig ?? []), ...allLogs.filter((row) => row.tag === 'config')];

  return { device, telemetry, events, allLogs, configLogs };
}

export type ResolvedConfig = {
  outletRoles: string[];
  profileConfig: ProfileConfig | null;
  // true once no historized `tag='config'` row exists yet at/before this
  // instant — falling back to the device's current snapshot (§3 of the plan).
  isFallback: boolean;
};

export function resolveConfigAt(configLogs: LogRow[], device: Device, t: string): ResolvedConfig {
  let active: LogRow | null = null;
  for (const row of configLogs) {
    if (row.created_at > t) break;
    active = row;
  }

  if (active?.outlet_roles && active.profile_config) {
    return { outletRoles: active.outlet_roles, profileConfig: active.profile_config, isFallback: false };
  }

  return { outletRoles: device.outlet_roles, profileConfig: device.profile_config, isFallback: true };
}

export type OutletState = {
  index: number;
  role: string;
  on: boolean | null; // null = no telemetry sample yet at/before this instant
  since: string | null; // created_at of the transition that produced this state
  sinceDeviceTime: string | null; // that transition's device_time, if NTP-synced yet
  reason: string | null; // that transition's free-text message
};

export type ReconstructedState = {
  timestamp: string;
  tempF: number | null;
  hum: number | null;
  telemetryAt: string | null; // timestamp of the base telemetry sample used
  outlets: OutletState[];
  automationEnabled: boolean | null;
  config: ResolvedConfig;
  lastEvent: LogRow | null; // most recent log row (any tag) at/before this instant
};

// Implements docs/monitoring-webapp-plan.md §5: take the most recent
// telemetry sample at/before `t` as the base state, then overlay any
// outlet-transition events between that sample and `t`.
export function reconstructStateAt(data: DeviceTimelineData, t: string): ReconstructedState {
  const { device, telemetry, events, allLogs, configLogs } = data;

  let baseTelemetry: TelemetryRow | null = null;
  for (const row of telemetry) {
    if (row.created_at > t) break;
    baseTelemetry = row;
  }

  let mask = baseTelemetry?.outlet_mask ?? null;
  const config = resolveConfigAt(configLogs, device, t);

  // Most recent transition per outlet index at/before `t`. Kept even when
  // older than `baseTelemetry` so "on since / because" is still accurate for
  // an outlet that hasn't flipped within the visible window — but only
  // transitions strictly after the base sample get overlaid onto `mask`,
  // since the sample already reflects anything at/before it.
  const lastTransitionByIndex = new Map<number, LogRow>();
  for (const row of events) {
    if (row.created_at > t) break;
    if (row.outlet_index == null || row.outlet_state == null) continue;
    lastTransitionByIndex.set(row.outlet_index, row);
    if (mask != null && (!baseTelemetry || row.created_at > baseTelemetry.created_at)) {
      mask = row.outlet_state ? mask | (1 << row.outlet_index) : mask & ~(1 << row.outlet_index);
    }
  }

  const outlets: OutletState[] = config.outletRoles.map((role, index) => {
    const transition = lastTransitionByIndex.get(index) ?? null;
    return {
      index,
      role,
      on: mask == null ? null : Boolean(mask & (1 << index)),
      since: transition?.created_at ?? null,
      sinceDeviceTime: transition?.device_time ?? null,
      reason: transition?.message ?? null,
    };
  });

  let lastEvent: LogRow | null = null;
  for (const row of allLogs) {
    if (row.created_at > t) break;
    lastEvent = row;
  }

  return {
    timestamp: t,
    tempF: baseTelemetry?.temp_f ?? null,
    hum: baseTelemetry?.hum ?? null,
    telemetryAt: baseTelemetry?.created_at ?? null,
    outlets,
    automationEnabled: config.profileConfig?.enabled ?? null,
    config,
    lastEvent,
  };
}
