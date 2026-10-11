// Firmware 0.35.0's sensor-fault edges, parsed from the device's own
// tag='sensor' log rows — see docs/automation-rules.md §3a/§4b and
// src/lib/sensorFaults.ts, which re-exports everything here.
//
// Lives in _shared/ for the same reason as climateDetection.ts: it's
// imported by both the Next.js app (src/lib/sensorFaults.ts) and the
// climate-alerts Edge Function (Deno), with no build step between them, so
// both read a fault the same way. Keep it dependency-free — no imports, no
// Deno.* or node:* APIs.

// The few LogRow columns this reads; structurally satisfied by the app's
// LogRow and by a plain PostgREST row in the Edge Function.
export type EdgeLogRow = {
  tag: string;
  message: string;
  created_at: string;
  profile_config?: { enabled?: boolean } | null;
};

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

export function parseSensorEdge(row: Pick<EdgeLogRow, 'tag' | 'message'>): SensorEdge | null {
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
export function sensorFaultEpisodes(rows: EdgeLogRow[]): SensorFaultEpisode[] {
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

// Episodes still latched right now. `bootAtMs` is the device's current
// boot instant (devices.last_seen - uptime_ms): a fault older than that was
// cleared by the reboot even if its boot row wasn't among the rows read.
// While automation is off nothing reads either channel, and switching it
// back on clears both latches, so no fault stands.
export function standingFaults(
  episodes: SensorFaultEpisode[],
  bootAtMs: number,
  automationEnabled: boolean,
): SensorFaultEpisode[] {
  if (!automationEnabled) return [];
  return episodes.filter((e) => e.endedAt == null && new Date(e.startedAt).getTime() >= bootAtMs);
}
