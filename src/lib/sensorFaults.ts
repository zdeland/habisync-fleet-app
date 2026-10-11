// Firmware 0.35.0's sensor trust gates as the cloud sees them —
// docs/automation-rules.md §3a, §4b and §11.
//
// The latch itself never reaches telemetry. What does reach the cloud is a
// tag='sensor' row on each edge, and those rows are the authoritative
// record: the device's watchdogs count 30s evaluations, so recomputing them
// from 60s telemetry fires at the wrong time (the mist one has no rows to
// measure across at all). Read faults from the rows; the telemetry
// heuristics further down are for what the device can't catch or log.
import { compareFwVersions } from '@/lib/version';
import type { Device, LogRow, TelemetryRow } from '@/lib/types';
import type { FaultOverride } from '@/lib/automation';
import { HUMIDITY_RISE_EPSILON_PCT, TEMP_RISE_EPSILON_C } from '@/lib/automation';
import { tempRangeC } from '@/lib/units';

export const SENSOR_GATE_FIRMWARE = '0.35.0';

export function hasSensorGates(fwVersion: string): boolean {
  return compareFwVersions(fwVersion, SENSOR_GATE_FIRMWARE) >= 0;
}

export type SensorChannel = 'temp' | 'hum';

export type SensorEdge = {
  channel: SensorChannel;
  kind: 'fault' | 'recovered';
  reason: string | null; // 'implausible reading' | 'no rise while misting' | 'no rise while heating'
  value: number; // the reading the device logged at the edge, °C or %RH
};

// `Humidity sensor not trusted (no rise while misting) at 28.4 %RH — ...`
// `Temperature sensor trusted again at 23.1 C — ...`
// tag='sensor' predates 0.35.0 and carries other messages, so match the
// edge wording exactly rather than keying off the tag alone.
const EDGE_PATTERN = /^(Humidity|Temperature) sensor (?:not trusted \(([^)]*)\)|(trusted again)) at (-?[\d.]+|nan)/i;

export function parseSensorEdge(row: Pick<LogRow, 'tag' | 'message'>): SensorEdge | null {
  if (row.tag !== 'sensor') return null;
  const match = EDGE_PATTERN.exec(row.message);
  if (!match) return null;
  return {
    channel: match[1].toLowerCase() === 'humidity' ? 'hum' : 'temp',
    kind: match[3] ? 'recovered' : 'fault',
    reason: match[2] ?? null,
    value: Number(match[4]),
  };
}

export type FaultEnd = 'recovered' | 'reboot' | 'automation-off';

export type SensorFaultEpisode = {
  channel: SensorChannel;
  reason: string | null;
  value: number;
  startedAt: string;
  endedAt: string | null; // null = still latched as of the last row seen
  endedBy: FaultEnd | null;
};

// Rows ascending by created_at; any tags — only sensor edges, tag='boot'
// and tag='config' rows matter. Neither a reboot nor the keeper switching
// automation off and on again logs a recovery row, and both clear the
// latch (§4b), so an episode also ends at the first of those after it.
// Automation going OFF is counted as the end, not the later ON: while it's
// off the device drives nothing from either channel, and turning it back
// on clears the fault.
export function sensorFaultEpisodes(rows: LogRow[]): SensorFaultEpisode[] {
  const episodes: SensorFaultEpisode[] = [];
  const open = new Map<SensorChannel, SensorFaultEpisode>();

  const close = (episode: SensorFaultEpisode, at: string, by: FaultEnd) => {
    episode.endedAt = at;
    episode.endedBy = by;
    open.delete(episode.channel);
  };

  for (const row of rows) {
    if (row.tag === 'boot') {
      open.forEach((episode) => close(episode, row.created_at, 'reboot'));
      continue;
    }
    if (row.tag === 'config') {
      if (row.profile_config?.enabled === false) {
        open.forEach((episode) => close(episode, row.created_at, 'automation-off'));
      }
      continue;
    }
    const edge = parseSensorEdge(row);
    if (!edge) continue;
    const current = open.get(edge.channel);
    if (edge.kind === 'recovered') {
      if (current) close(current, row.created_at, 'recovered');
      continue;
    }
    if (current) continue; // a second fault row inside an open episode adds nothing
    const episode: SensorFaultEpisode = {
      channel: edge.channel,
      reason: edge.reason,
      value: edge.value,
      startedAt: row.created_at,
      endedAt: null,
      endedBy: null,
    };
    episodes.push(episode);
    open.set(edge.channel, episode);
  }
  return episodes;
}

export function faultsAt(episodes: SensorFaultEpisode[], t: string): FaultOverride {
  const latched = (channel: SensorChannel) =>
    episodes.some((e) => e.channel === channel && e.startedAt <= t && (e.endedAt == null || e.endedAt > t));
  return { temp: latched('temp'), hum: latched('hum') };
}

// ---------------------------------------------------------------------------
// The fleet-level alert (0.35.0 handoff §3a). Suppressing the mismatch a
// gate causes is what makes this necessary: a latch on a healthy sensor
// never clears itself, because recovery needs a rise the now-disabled
// outlet isn't producing. A temperature latch leaves the enclosure going
// cold indefinitely, so it outranks everything else on the board.

export type ActiveSensorFault = SensorFaultEpisode & {
  deviceId: string;
  // The channel's latest reading is past its LOW threshold, i.e. the
  // enclosure is drifting out of range with that half of automation
  // disarmed. Judged on the latest sample only, and on the same reading
  // the device distrusts — it's the handoff's escalation rule, not proof.
  escalated: boolean;
};

// `device.last_seen - uptime_ms` is the current boot instant (the same
// arithmetic as queries.ts's msSinceDeviceBoot). A fault older than that
// was cleared by the reboot even if no boot row has been read.
function bootedAfter(device: Device, iso: string): boolean {
  const bootAtMs = new Date(device.last_seen).getTime() - device.uptime_ms;
  return bootAtMs > new Date(iso).getTime();
}

export function activeSensorFaults(
  device: Device,
  rowsAscending: LogRow[], // this device's sensor/boot/config rows
  latestTelemetry: TelemetryRow | null,
): ActiveSensorFault[] {
  if (device.profile_config?.enabled === false) return [];
  return sensorFaultEpisodes(rowsAscending)
    .filter((e) => e.endedAt == null && !bootedAfter(device, e.startedAt))
    .map((e) => {
      const config = device.profile_config;
      let escalated = false;
      if (latestTelemetry && config) {
        const tempRange = tempRangeC(config);
        if (e.channel === 'temp' && tempRange) escalated = latestTelemetry.temp_c < tempRange.low;
        if (e.channel === 'hum' && config.hum_low != null) escalated = latestTelemetry.hum < config.hum_low;
      }
      return { ...e, deviceId: device.device_id, escalated };
    });
}

// ---------------------------------------------------------------------------
// §11's telemetry heuristics. These cover what the device either can't
// catch (a channel stuck at a plausible value with no heater running) or
// shouldn't have let happen (an outlet running on a reading that never
// answers it). Rows ascending; each returns one finding per streak, dated
// at the sample where the streak crossed its threshold.

export type SensorAnomalyKind = 'hum-pinned-zero' | 'temp-stuck' | 'heater-no-rise' | 'mister-no-rise';

export type SensorAnomaly = {
  kind: SensorAnomalyKind;
  at: string; // created_at of the sample where the streak crossed its threshold
  since: string; // created_at of the streak's first sample
  // Only meaningful for the two outlet rules: true on firmware < 0.35.0,
  // where the streak is the unbounded runaway itself rather than a gate
  // that failed to fire.
  runaway: boolean;
};

// Consecutive samples of exactly 0.0 %RH. Three minutes rules out a single
// garbage read; a dead channel sits there for half an hour or more.
export const HUM_ZERO_MIN_SAMPLES = 3;
// Bit-identical temp_c. Telemetry carries 0.1 °C resolution and a quiet
// enclosure can hold one value for a while, so this is deliberately long.
export const TEMP_STUCK_MIN_SAMPLES = 30;
// "Well over" the device's 10-minute heat watchdog.
export const HEATER_NO_RISE_MIN_MS = 15 * 60_000;
// "Several consecutive samples" — on 0.35.0+ the gate should have closed
// the mister inside ~90s, so three 60s samples means it didn't.
export const MISTER_NO_RISE_MIN_SAMPLES = 3;

// Two samples further apart than this break a streak: a gap is unknown,
// not more of the same (mirrors climateDetection.ts's MAX_SAMPLE_GAP_MS).
const MAX_SAMPLE_GAP_MS = 6 * 60_000;

function gapBetween(a: TelemetryRow, b: TelemetryRow): number {
  return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
}

// Generic streak walker: `extends(prev, curr, start)` says whether curr
// continues the streak that began at `start`; `crossed(start, curr, len)`
// says whether it has now lasted long enough to report.
function findStreaks(
  rows: TelemetryRow[],
  begins: (row: TelemetryRow) => boolean,
  extendsStreak: (start: TelemetryRow, prev: TelemetryRow, curr: TelemetryRow) => boolean,
  crossed: (start: TelemetryRow, curr: TelemetryRow, length: number) => boolean,
): { start: TelemetryRow; crossedAt: TelemetryRow }[] {
  const found: { start: TelemetryRow; crossedAt: TelemetryRow }[] = [];
  let start: TelemetryRow | null = null;
  let length = 0;
  let reported = false;
  for (let i = 0; i < rows.length; i++) {
    const curr = rows[i];
    const prev = rows[i - 1];
    const continues =
      start != null && prev != null && gapBetween(prev, curr) <= MAX_SAMPLE_GAP_MS && extendsStreak(start, prev, curr);
    if (!continues) {
      start = begins(curr) ? curr : null;
      length = start ? 1 : 0;
      reported = false;
    } else {
      length++;
    }
    if (start && !reported && crossed(start, curr, length)) {
      found.push({ start, crossedAt: curr });
      reported = true;
    }
  }
  return found;
}

const bit = (row: TelemetryRow, index: number) => Boolean(row.outlet_mask & (1 << index));

export function detectSensorAnomalies(
  rows: TelemetryRow[],
  fwVersion: string,
  // The Heater/Mister outlet index in effect for a sample, or -1. A
  // function because roles are historized and can move between outlets.
  outletIndexAt: (row: TelemetryRow, role: 'Heater' | 'Mister') => number,
): SensorAnomaly[] {
  const anomalies: SensorAnomaly[] = [];
  const runaway = !hasSensorGates(fwVersion);
  const push = (kind: SensorAnomalyKind, s: { start: TelemetryRow; crossedAt: TelemetryRow }, isRunaway = false) =>
    anomalies.push({ kind, at: s.crossedAt.created_at, since: s.start.created_at, runaway: isRunaway });

  // A dead RH channel on a live part: hum pinned at exactly 0.0 while
  // temp_c keeps moving (which rules out the whole part being dead).
  for (const s of findStreaks(
    rows,
    (r) => r.hum === 0,
    (_start, _prev, curr) => curr.hum === 0,
    (start, curr, length) => length >= HUM_ZERO_MIN_SAMPLES && curr.temp_c !== start.temp_c,
  )) {
    push('hum-pinned-zero', s);
  }

  // A stuck temperature channel: neither on-device detector catches a
  // plausible value that never moves unless the heater happens to be on.
  // hum varying over the streak shows the part is still answering.
  for (const s of findStreaks(
    rows,
    () => true,
    (start, _prev, curr) => curr.temp_c === start.temp_c,
    (start, curr, length) => length >= TEMP_STUCK_MIN_SAMPLES && curr.hum !== start.hum,
  )) {
    push('temp-stuck', s);
  }

  // Heater on well past the device's watchdog with no rise of the
  // device's own epsilon above where the stretch began.
  for (const s of findStreaks(
    rows,
    (r) => {
      const i = outletIndexAt(r, 'Heater');
      return i >= 0 && bit(r, i);
    },
    (start, _prev, curr) => {
      const i = outletIndexAt(curr, 'Heater');
      return i >= 0 && bit(curr, i) && curr.temp_c < start.temp_c + TEMP_RISE_EPSILON_C;
    },
    (start, curr) => gapBetween(start, curr) >= HEATER_NO_RISE_MIN_MS,
  )) {
    push('heater-no-rise', s, runaway);
  }

  // Mister on across several samples with hum flat or falling.
  for (const s of findStreaks(
    rows,
    (r) => {
      const i = outletIndexAt(r, 'Mister');
      return i >= 0 && bit(r, i);
    },
    (start, _prev, curr) => {
      const i = outletIndexAt(curr, 'Mister');
      return i >= 0 && bit(curr, i) && curr.hum < start.hum + HUMIDITY_RISE_EPSILON_PCT;
    },
    (_start, _curr, length) => length >= MISTER_NO_RISE_MIN_SAMPLES,
  )) {
    push('mister-no-rise', s, runaway);
  }

  return anomalies.sort((a, b) => a.at.localeCompare(b.at));
}
