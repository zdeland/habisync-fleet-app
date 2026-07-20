import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, Device, LogRow, ProfileConfig, TelemetryRow } from '@/lib/types';
import { evaluateClimateStep, INITIAL_CLIMATE_STATE, type ClimateProfile, type ClimateState } from '@/lib/automation';
import { tempRangeC } from '@/lib/units';

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

  // Ordering these DESCENDING (not ascending) is deliberate, not cosmetic:
  // a Supabase project's configured max-rows setting silently caps a
  // query's returned rows well below ROW_LIMIT with no error at all — the
  // .limit() in code is a ceiling, not a guarantee. Ordering ascending and
  // hitting that cap would silently return only the OLDEST rows in range,
  // cutting off before "now" (this is exactly what was happening: the
  // device timeline showed a telemetry sample hours stale while the fleet
  // overview — whose own query already orders descending — was fresh).
  // Fetch newest-first so a silent cap keeps the recent end instead, then
  // reverse back to ascending below since the rest of this module and the
  // reducer assume chronological order.
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
      .order('created_at', { ascending: false })
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
      .order('created_at', { ascending: false })
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

  const telemetry = [...(seedTelemetry ?? []), ...(telemetryInRange ?? []).reverse()];
  const allLogs = (logsInRange ?? []).reverse();
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
  // true when there IS a known last transition for this outlet but its
  // logged outlet_state disagrees with the current reconstructed `on` —
  // the same class of disagreement outlet_alerts persists once it holds
  // for OUTLET_MISMATCH_DEBOUNCE_SAMPLES in a row (src/lib/queries.ts).
  // `on` above is still the real, trustworthy current state (straight from
  // telemetry) — this flag says the *log* is what's wrong/stale, not that
  // `on` itself is in doubt. Computed per-instant so the outlet tile can
  // say so instead of just going silent on since/reason and leaving the
  // mismatch unexplained.
  mismatched: boolean;
};

export type ReconstructedState = {
  timestamp: string;
  tempC: number | null; // native unit as of firmware 0.5.0 — see src/lib/units.ts
  hum: number | null;
  telemetryAt: string | null; // timestamp of the base telemetry sample used
  outlets: OutletState[];
  automationEnabled: boolean | null;
  config: ResolvedConfig;
  lastEvent: LogRow | null; // most recent log row (any tag) at/before this instant
  // Fan is a single outlet driven by an OR of two independent triggers
  // (docs/automation-rules.md §5) — "fan is on" alone can't tell you which
  // one is actually active. These are the real recomputed triggers from
  // replaying automation.ts's evaluateClimateStep over telemetry, not a
  // guess from the shared outlet state.
  tooHot: boolean | null;
  tooHumid: boolean | null;
};

// Implements docs/monitoring-webapp-plan.md §5: take the most recent
// telemetry sample at/before `t` as the base state, then overlay any
// outlet-transition events between that sample and `t`.
export function reconstructStateAt(data: DeviceTimelineData, t: string): ReconstructedState {
  const { device, telemetry, events, allLogs, configLogs } = data;

  let baseTelemetry: TelemetryRow | null = null;
  // Replayed alongside baseTelemetry, in the same pass, so the trigger
  // state always corresponds to exactly the same samples used for
  // everything else here — see automation-rules.md §3-5 for the formulas
  // and the ReconstructedState.tooHot/tooHumid doc comment for why this
  // exists instead of reading it off the Fan's reported on/off state.
  let climateState: ClimateState = INITIAL_CLIMATE_STATE;
  let tooHot: boolean | null = null;
  let tooHumid: boolean | null = null;
  for (const row of telemetry) {
    if (row.created_at > t) break;
    baseTelemetry = row;

    const rowConfig = resolveConfigAt(configLogs, device, row.created_at);
    const range = tempRangeC(rowConfig.profileConfig);
    const profile: ClimateProfile = {
      tempLow: range?.low ?? 0,
      tempHigh: range?.high ?? 100,
      humidityLow: rowConfig.profileConfig?.hum_low ?? 0,
      humidityHigh: rowConfig.profileConfig?.hum_high ?? 100,
    };
    const enabled = rowConfig.profileConfig?.enabled ?? false;
    const result = evaluateClimateStep(climateState, profile, enabled, row.temp_c, row.hum);
    climateState = result.state;
    tooHot = result.decision.tooHot;
    tooHumid = result.decision.tooHumid;
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
    const on = mask == null ? null : Boolean(mask & (1 << index));
    // A transition's message/timestamp only actually describes the current
    // on/off state if its own logged outlet_state agrees with it. When it
    // doesn't — e.g. the outlet flipped again without going through the
    // event-logging path (a manual toggle, a firmware gap) — showing that
    // stale reason/timestamp as if it explains the current state is actively
    // misleading, not just outdated: it describes a DIFFERENT transition.
    const reasonMatchesCurrentState = transition != null && transition.outlet_state === on;
    return {
      index,
      role,
      on,
      since: reasonMatchesCurrentState ? transition.created_at : null,
      sinceDeviceTime: reasonMatchesCurrentState ? transition.device_time : null,
      reason: reasonMatchesCurrentState ? transition.message : null,
      mismatched: transition != null && !reasonMatchesCurrentState,
    };
  });

  let lastEvent: LogRow | null = null;
  for (const row of allLogs) {
    if (row.created_at > t) break;
    lastEvent = row;
  }

  return {
    timestamp: t,
    tempC: baseTelemetry?.temp_c ?? null,
    hum: baseTelemetry?.hum ?? null,
    telemetryAt: baseTelemetry?.created_at ?? null,
    outlets,
    automationEnabled: config.profileConfig?.enabled ?? null,
    config,
    lastEvent,
    tooHot,
    tooHumid,
  };
}
