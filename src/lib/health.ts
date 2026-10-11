import type { LogLevel, LogRow, TelemetryRow } from '@/lib/types';
import { CRITICAL_ERROR_COUNT, ERROR_WINDOW_MS, STALE_AFTER_MS, WARNING_ERROR_COUNT } from '@/lib/queries';
import { resolveConfigAt, type DeviceTimelineData, type TimeRange } from '@/lib/timeline';
import { detectSensorAnomalies, type SensorAnomalyKind, type SensorFaultEpisode } from '@/lib/sensorFaults';

// Computed purely from data already fetched for the viewed range — not
// persisted anywhere. Nothing writes these into the device's own `logs`
// table (that stays a pure ledger of what the device itself observed); they
// exist only to render on this timeline, recomputed each time it's viewed.
export type HealthEvent = {
  id: string;
  createdAt: string;
  level: LogLevel;
  icon: string;
  message: string;
};

function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder === 0 ? `${hours}h` : `${hours}h ${remainder}m`;
}

export type TelemetryGap = {
  prev: TelemetryRow;
  curr: TelemetryRow;
  gapMs: number;
};

// Same "stale" threshold as the fleet overview (src/lib/queries.ts), applied
// to gaps between consecutive telemetry samples within *this* device's own
// history instead of "last_seen vs now" for the whole fleet — so a past
// offline stretch still shows up here even though the device has long since
// reconnected and looks fine on the fleet overview today. Exported so the
// chart can draw a gap-line across each one, not just the event log/marker
// strip — both need the same boundary pairs, not just the derived message.
export function findTelemetryGaps(telemetry: TelemetryRow[]): TelemetryGap[] {
  const gaps: TelemetryGap[] = [];
  for (let i = 1; i < telemetry.length; i++) {
    const prev = telemetry[i - 1];
    const curr = telemetry[i];
    const gapMs = new Date(curr.created_at).getTime() - new Date(prev.created_at).getTime();
    if (gapMs > STALE_AFTER_MS) {
      gaps.push({ prev, curr, gapMs });
    }
  }
  return gaps;
}

function deriveOfflineEvents(telemetry: TelemetryRow[], rangeToIso: string): HealthEvent[] {
  const events: HealthEvent[] = [];

  for (const gap of findTelemetryGaps(telemetry)) {
    events.push({
      id: `offline-${gap.prev.id}`,
      createdAt: gap.prev.created_at,
      level: 0,
      icon: '📴',
      message: `Device stopped reporting (offline for ${formatDuration(gap.gapMs)})`,
    });
    events.push({
      id: `online-${gap.curr.id}`,
      createdAt: gap.curr.created_at,
      level: 2,
      icon: '🟢',
      message: `Device reconnected after ${formatDuration(gap.gapMs)} offline`,
    });
  }

  const last = telemetry[telemetry.length - 1];
  if (last) {
    const gapMs = new Date(rangeToIso).getTime() - new Date(last.created_at).getTime();
    if (gapMs > STALE_AFTER_MS) {
      events.push({
        id: `offline-ongoing-${last.id}`,
        createdAt: last.created_at,
        level: 0,
        icon: '📴',
        message: `Device stopped reporting and hadn't reconnected by the end of this range (${formatDuration(gapMs)} and counting)`,
      });
    }
  }

  return events;
}

// Same rolling-24h error-count thresholds as the fleet overview — a marker
// fires only when the computed severity actually changes between one
// telemetry sample and the next, not on every sample. Two-pointer sliding
// window over the sorted error-log list, O(telemetry + errorLogs) total.
function deriveHealthChangeEvents(telemetry: TelemetryRow[], allLogs: LogRow[]): HealthEvent[] {
  const events: HealthEvent[] = [];
  const errorLogs = allLogs.filter((row) => row.level === 0);

  let windowStart = 0;
  let windowEnd = 0;
  let prevSeverity: 'healthy' | 'warning' | 'critical' | null = null;

  for (const sample of telemetry) {
    const t = new Date(sample.created_at).getTime();

    while (windowEnd < errorLogs.length && new Date(errorLogs[windowEnd].created_at).getTime() <= t) {
      windowEnd++;
    }
    while (windowStart < windowEnd && new Date(errorLogs[windowStart].created_at).getTime() <= t - ERROR_WINDOW_MS) {
      windowStart++;
    }

    const errorCount = windowEnd - windowStart;
    const severity: 'healthy' | 'warning' | 'critical' =
      errorCount >= CRITICAL_ERROR_COUNT ? 'critical' : errorCount >= WARNING_ERROR_COUNT ? 'warning' : 'healthy';

    if (prevSeverity != null && severity !== prevSeverity) {
      events.push({
        id: `health-${sample.id}`,
        createdAt: sample.created_at,
        level: severity === 'critical' ? 0 : severity === 'warning' ? 1 : 2,
        icon: severity === 'critical' ? '🔴' : severity === 'warning' ? '⚠️' : '✅',
        message: `Health changed to ${severity.toUpperCase()} (${errorCount} error${errorCount === 1 ? '' : 's'} in the trailing 24h)`,
      });
    }
    prevSeverity = severity;
  }

  return events;
}

const CHANNEL_LABEL = { temp: 'Temperature', hum: 'Humidity' } as const;
const END_LABEL = {
  recovered: 'the reading recovered',
  reboot: 'a reboot',
  'automation-off': 'climate automation being switched off',
} as const;

// Firmware 0.35.0 logs its own fault edges, and those rows already show in
// the event log. These markers add what the rows can't: a latch ending
// silently, at a reboot or an automation toggle, with no row of its own.
function deriveSensorFaultEndEvents(episodes: SensorFaultEpisode[]): HealthEvent[] {
  return episodes
    .filter((e) => e.endedAt != null && e.endedBy !== 'recovered')
    .map((e) => ({
      id: `sensor-fault-end-${e.channel}-${e.startedAt}`,
      createdAt: e.endedAt!,
      level: 2,
      icon: '🔄',
      message: `${CHANNEL_LABEL[e.channel]} sensor fault cleared by ${END_LABEL[e.endedBy!]} (latched ${formatDuration(
        new Date(e.endedAt!).getTime() - new Date(e.startedAt).getTime(),
      )}, no recovery row logged)`,
    }));
}

const ANOMALY_MESSAGE: Record<SensorAnomalyKind, (runaway: boolean) => string> = {
  'hum-pinned-zero': () => 'Humidity pinned at 0.0 %RH while temperature keeps moving — dead RH channel',
  'temp-stuck': () =>
    'Temperature bit-identical for 30+ samples while humidity varies — possibly a stuck channel, which the device cannot detect itself',
  'heater-no-rise': (runaway) =>
    runaway
      ? 'RUNAWAY HEATER: on for 15+ min with temperature flat or falling, on firmware with no sensor gate'
      : 'Heater on for 15+ min with temperature flat or falling — the 0.35.0 sensor gate should have caught this and did not',
  'mister-no-rise': (runaway) =>
    runaway
      ? 'RUNAWAY MISTER: on across 3+ samples with humidity flat or falling, on firmware with no sensor gate'
      : 'Mister on across 3+ samples with humidity flat or falling — the 0.35.0 sensor gate should have closed it within ~90s',
};

function deriveSensorAnomalyEvents(data: DeviceTimelineData): HealthEvent[] {
  const indexAt = (row: TelemetryRow, role: 'Heater' | 'Mister') =>
    resolveConfigAt(data.configLogs, data.device, row.created_at).outletRoles.indexOf(role);
  return detectSensorAnomalies(data.telemetry, data.device.fw_version, indexAt).map((a) => ({
    id: `sensor-${a.kind}-${a.since}`,
    createdAt: a.at,
    level: a.kind === 'temp-stuck' ? 1 : 0,
    icon: a.runaway ? '🚨' : '🌡️',
    message: ANOMALY_MESSAGE[a.kind](a.runaway),
  }));
}

// Offline/reconnect and health-severity-change markers for the device
// timeline. Clamped to the visible range: a gap that started before
// `range.from` (using the seed telemetry row from before the window) still
// produces its "reconnected" marker if that falls inside the range, but not
// a "went offline" marker dated before the range starts.
export function deriveHealthEvents(data: DeviceTimelineData, range: TimeRange): HealthEvent[] {
  const events = [
    ...deriveOfflineEvents(data.telemetry, range.to),
    ...deriveHealthChangeEvents(data.telemetry, data.allLogs),
    ...deriveSensorFaultEndEvents(data.sensorFaults),
    ...deriveSensorAnomalyEvents(data),
  ];
  return events.filter((event) => event.createdAt >= range.from).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

// A real logs row or a synthetic health event, normalized to one shape so
// the marker strip and event log can render both without caring which.
export type TimelineEntry =
  | { kind: 'log'; id: string; createdAt: string; level: LogLevel; row: LogRow }
  | { kind: 'health'; id: string; createdAt: string; level: LogLevel; icon: string; message: string };

export function mergeTimelineEntries(allLogs: LogRow[], healthEvents: HealthEvent[]): TimelineEntry[] {
  const logEntries: TimelineEntry[] = allLogs.map((row) => ({
    kind: 'log',
    id: `log-${row.id}`,
    createdAt: row.created_at,
    level: row.level,
    row,
  }));
  const healthEntries: TimelineEntry[] = healthEvents.map((event) => ({
    kind: 'health',
    id: event.id,
    createdAt: event.createdAt,
    level: event.level,
    icon: event.icon,
    message: event.message,
  }));
  return [...logEntries, ...healthEntries].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
