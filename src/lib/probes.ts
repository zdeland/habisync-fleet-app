// HabiSync 1.0 (board habisync-1_0, firmware 1.x) — a monitor-only unit
// with one to four tanks, one RS-485 temperature/humidity probe per tank on
// ports 0-3, and no outlets, automation or schedules.
// See docs/automation-rules.md §12 (fleet-handoff-1.3.0).
//
// The one breaking change: from 1.3.0, `telemetry` has one row per probe
// per minute. A series is (device_id, port), and port null is "the device's
// reading" — every devkit row, and a 1.0-1.2 unit's rows, which carry only
// its first tank. Everything that reads telemetry for a chart, a latest
// value, or a streak goes through splitByPort() so probes never interleave.
import { compareFwVersions } from '@/lib/version';
import type { Device, ProfileConfig, TankConfig, TelemetryRow } from '@/lib/types';

export const MONITOR_BOARD = 'habisync-1_0';

// The two lines share devices/logs/telemetry and are told apart by firmware
// major version or board. Either is enough: the board key arrives with the
// heartbeat's profile_config, and fw_version can lag a reflash by up to a
// heartbeat (hs-f0a74c reported 1.2.0 while already writing per-port rows).
export function isMonitorOnly(device: Pick<Device, 'fw_version' | 'profile_config'>): boolean {
  return (
    device.profile_config?.board === MONITOR_BOARD || compareFwVersions(device.fw_version ?? '0', '1.0.0') >= 0
  );
}

// Order and plot by this, not created_at: rows upload in batches every 30s,
// and after an outage a whole backlog lands with one created_at.
export function sampleTime(row: Pick<TelemetryRow, 'created_at' | 'device_time'>): string {
  return row.device_time ?? row.created_at;
}

export function sampleTimeMs(row: Pick<TelemetryRow, 'created_at' | 'device_time'>): number {
  return new Date(sampleTime(row)).getTime();
}

export function bySampleTime(a: TelemetryRow, b: TelemetryRow): number {
  return sampleTimeMs(a) - sampleTimeMs(b) || a.id - b.id;
}

// Map key for a series: the port, or null for a port-less row.
export type SeriesPort = number | null;

// Each series sorted ascending by sampleTime(). Ports in ascending order,
// the port-less series (if any) first.
export function splitByPort(rows: TelemetryRow[]): Map<SeriesPort, TelemetryRow[]> {
  const byPort = new Map<SeriesPort, TelemetryRow[]>();
  for (const row of rows) {
    const list = byPort.get(row.port ?? null);
    if (list) list.push(row);
    else byPort.set(row.port ?? null, [row]);
  }
  const keys = Array.from(byPort.keys()).sort((a, b) => (a ?? -1) - (b ?? -1));
  return new Map(keys.map((key) => [key, byPort.get(key)!.sort(bySampleTime)]));
}

// Newest row per series.
export function latestPerSeries(rows: TelemetryRow[]): Map<SeriesPort, TelemetryRow> {
  const latest = new Map<SeriesPort, TelemetryRow>();
  splitByPort(rows).forEach((series, port) => latest.set(port, series[series.length - 1]));
  return latest;
}

// The shown tanks. A 1.0.0 unit predates tanks[] and has exactly one, whose
// band is the top-level fields; give it port 0 so it still has a home.
export function tanksOf(profileConfig: ProfileConfig | null): TankConfig[] {
  if (!profileConfig) return [];
  if (profileConfig.tanks?.length) return [...profileConfig.tanks].sort((a, b) => a.port - b.port);
  if (profileConfig.temp_low_c == null || profileConfig.temp_high_c == null) return [];
  return [
    {
      port: 0,
      name: 'Tank 1',
      profile: profileConfig.profile,
      temp_low_c: profileConfig.temp_low_c,
      temp_high_c: profileConfig.temp_high_c,
      hum_low: profileConfig.hum_low,
      hum_high: profileConfig.hum_high,
    },
  ];
}

// The tank a series belongs to. A port-less row on a 1.x unit is the first
// tank's reading (1.0.0-1.2.0 only ever uploaded that one). A port with no
// entry is a hidden tank — its probe still reports, its tank isn't listed.
export function tankForSeries(profileConfig: ProfileConfig | null, port: SeriesPort): TankConfig | null {
  const tanks = tanksOf(profileConfig);
  if (port == null) return tanks[0] ?? null;
  return tanks.find((tank) => tank.port === port) ?? null;
}

// People see ports 1-4; the wire, the logs' probe rows and the probe test
// use 0-3. (The `event` log's cap-change rows already say 1-4.)
export function portLabel(port: SeriesPort): string {
  return port == null ? 'Probe' : `Port ${port + 1}`;
}

export function seriesLabel(profileConfig: ProfileConfig | null, port: SeriesPort): string {
  const tank = tankForSeries(profileConfig, port);
  if (tank) return tank.name;
  return port == null ? 'Reading' : `${portLabel(port)} (hidden tank)`;
}

export type BandPosition = 'low' | 'in' | 'high';

// [low, high), per fleet-handoff-1.3.0 §4: at or above `high` is high.
// (The devkit's own fleet badge treats `high` itself as in range — its
// thresholds are automation triggers, a different contract.)
export function classifyBand(value: number, low: number, high: number): BandPosition {
  if (value < low) return 'low';
  if (value >= high) return 'high';
  return 'in';
}
