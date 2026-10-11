// HabiSync 1.0's probe cap test (firmware 1.3.0+) — fleet-handoff-1.3.0 §6
// and the firmware repo's docs/probe-cap-test.md. A 1-24 h bench test of how
// a probe's cap changes its readings: a baseline with no caps, then one cap
// moved from probe to probe, optionally a final all-capped phase, with a
// person entering reference readings (thermostat, IR on a neutral target
// and on each probe's tip) once per phase.
//
// A port of the firmware repo's scripts/probe_test_report.py, whose output
// is the reference for this view: same window, same settling mask, same
// per-minute grouping, same fit. Where this differs from a "natural" way of
// doing it, it's because the script does it that way — keep them in step.
// Ports are 0-based throughout, as on the wire; the UI adds 1.
import type { LogRow, TelemetryRow } from '@/lib/types';
import { sampleTimeMs } from '@/lib/probes';

const FIELD = /(\w+)=(\S+)/g;

export function parseFields(message: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const match of Array.from(message.matchAll(FIELD))) fields[match[1]] = match[2];
  return fields;
}

const firstWord = (message: string) => message.split(' ', 1)[0];

// ---------------------------------------------------------------------------
// Sessions, from tag='probetest' rows:
//   start s=<id> dur_min=<m> ports=<p,..> all=<0|1>
//   caps s=<id> phase=<k> capped=<p,..|none>
//   end s=<id>    (finished)      stop s=<id>    (abandoned)

export type SessionStatus = 'finished' | 'abandoned' | 'open';

export type CapsChange = { at: string; phase: number; capped: number[] };

export type ProbeTestSession = {
  id: string; // the start time in epoch seconds
  startedAt: string; // the start row's device_time ?? created_at
  endedAt: string | null;
  // 'open' = a start with neither end nor stop: still running, or the unit
  // went offline mid-test. Tell them apart by the clock (see isOverdue).
  status: SessionStatus;
  durationMin: number | null;
  ports: number[];
  allCappedPhase: boolean;
  caps: CapsChange[];
};

function rowTime(row: Pick<LogRow, 'created_at' | 'device_time'>): string {
  return new Date(sampleTimeMs(row)).toISOString();
}

function portList(value: string | undefined): number[] {
  if (!value || value === 'none') return [];
  return value.split(',').map(Number).filter((n) => Number.isInteger(n));
}

// Newest first. Each start pairs with the end/stop for the same `s`.
export function sessionsFromLogs(rows: LogRow[]): ProbeTestSession[] {
  const sorted = [...rows].filter((r) => r.tag === 'probetest').sort((a, b) => sampleTimeMs(a) - sampleTimeMs(b));
  const sessions = new Map<string, ProbeTestSession>();
  for (const row of sorted) {
    const f = parseFields(row.message);
    const id = f.s;
    if (!id) continue;
    const word = firstWord(row.message);
    if (word === 'start') {
      sessions.set(id, {
        id,
        startedAt: rowTime(row),
        endedAt: null,
        status: 'open',
        durationMin: f.dur_min != null ? Number(f.dur_min) : null,
        ports: portList(f.ports),
        allCappedPhase: f.all === '1',
        caps: [],
      });
      continue;
    }
    const session = sessions.get(id);
    if (!session) continue; // its start aged out of the 60-day logs window
    if (word === 'caps') {
      session.caps.push({ at: rowTime(row), phase: Number(f.phase), capped: portList(f.capped) });
    } else if ((word === 'end' || word === 'stop') && session.status === 'open') {
      session.endedAt = rowTime(row);
      session.status = word === 'end' ? 'finished' : 'abandoned';
    }
  }
  return Array.from(sessions.values()).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

// An open session past its scheduled end (plus a little slack for the
// final "take the cap off and press Done") stopped reporting rather than
// still running — most likely the unit went offline.
export function isOverdue(session: ProbeTestSession, nowMs: number): boolean {
  if (session.status !== 'open' || session.durationMin == null) return false;
  return nowMs > new Date(session.startedAt).getTime() + (session.durationMin + 60) * 60_000;
}

// The script's --latest window: start to end/stop, or to now while open.
export function sessionWindow(session: ProbeTestSession, nowIso: string): { since: string; until: string } {
  return { since: session.startedAt, until: session.endedAt ?? nowIso };
}

// ---------------------------------------------------------------------------
// Analysis — probe_test_report.py, function for function.

export const SETTLE_MINUTES = 10;
const MINUTE_MS = 60_000;

type Cap = string; // 'capped' | 'uncapped' | 'unset'

type MinuteRow = { port: number; cap: Cap; temp: number; hum: number };

export type OffsetStats = {
  port: number;
  cap: Cap;
  minutes: number;
  meanTempC: number;
  meanHum: number;
  tempOffset: { mean: number; sd: number };
  humOffset: { mean: number; sd: number };
};

export type CapEffect = { port: number; tempC: number | null; hum: number | null };

export type ReferenceKind = 'tip' | 'target' | 'room' | 'roomH';

export type ReferenceComparison = {
  port: number;
  kind: ReferenceKind;
  uncapped: number[];
  capped: number[];
};

export type ProbeTestReport = {
  rows: number;
  minutes: number;
  comparedMinutes: number; // minutes with two or more probes
  settlingDropped: number; // port-minutes left out while settling
  referenceValues: number;
  offsets: OffsetStats[];
  capEffects: CapEffect[]; // null = needs minutes both capped and uncapped
  pooledCapEffect: { tempC: number; hum: number } | null;
  references: ReferenceComparison[];
  // Per minute, for the chart: each probe's temp/hum offset and its cap.
  series: { minute: number; port: number; cap: Cap; tempOffset: number; humOffset: number; settling: boolean }[];
};

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

// Sample standard deviation, as Python's statistics.stdev; 0 for one value.
function sd(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
}

// Least-squares slope of ys on xs, or null when xs don't vary.
export function slope(xs: number[], ys: number[]): number | null {
  if (xs.length < 2) return null;
  const mx = mean(xs);
  const my = mean(ys);
  const sxx = xs.reduce((a, x) => a + (x - mx) ** 2, 0);
  if (sxx < 1e-9) return null;
  return xs.reduce((a, x, i) => a + (x - mx) * (ys[i] - my), 0) / sxx;
}

const toMinute = (ms: number) => Math.floor(ms / MINUTE_MS) * MINUTE_MS;

export function analyzeProbeTest(
  telemetry: TelemetryRow[], // the device's per-port rows covering the window, any order
  referenceRows: LogRow[], // tag='reference' rows covering the window
  window: { since: string; until: string },
  sessionId: string | null,
  settleMinutes = SETTLE_MINUTES,
): ProbeTestReport {
  const sinceMs = new Date(window.since).getTime();
  const untilMs = new Date(window.until).getTime();
  const inWindow = (ms: number) => ms >= sinceMs && ms < untilMs;

  const rows = telemetry
    .filter((r) => r.port != null && inWindow(sampleTimeMs(r)))
    .sort((a, b) => sampleTimeMs(a) - sampleTimeMs(b) || a.id - b.id);
  const refs = referenceRows
    .filter((r) => r.tag === 'reference' && inWindow(sampleTimeMs(r)))
    .filter((r) => sessionId == null || parseFields(r.message).s === sessionId)
    .sort((a, b) => sampleTimeMs(a) - sampleTimeMs(b) || a.id - b.id);

  // minute -> port -> row; the last one in a minute wins.
  const byMinute = new Map<number, Map<number, MinuteRow>>();
  for (const r of rows) {
    const minute = toMinute(sampleTimeMs(r));
    const ports = byMinute.get(minute) ?? new Map<number, MinuteRow>();
    ports.set(r.port!, { port: r.port!, cap: r.probe_cap ?? 'unset', temp: r.temp_c, hum: r.hum });
    byMinute.set(minute, ports);
  }
  const minutes = Array.from(byMinute.keys()).sort((a, b) => a - b);

  // (minute, port) pairs within `settleMinutes` after that port's cap changed.
  const skip = new Set<string>();
  const skipKey = (minute: number, port: number) => `${minute}:${port}`;
  if (settleMinutes > 0) {
    const lastCap = new Map<number, Cap>();
    const changedAt = new Map<number, number>();
    for (const minute of minutes) {
      byMinute.get(minute)!.forEach((row, port) => {
        if (lastCap.has(port) && lastCap.get(port) !== row.cap) changedAt.set(port, minute);
        lastCap.set(port, row.cap);
        const changed = changedAt.get(port);
        if (changed != null && minute - changed < settleMinutes * MINUTE_MS) skip.add(skipKey(minute, port));
      });
    }
  }

  // Probe against probe, every minute. Each probe's offset from the group
  // mean (the mean includes the probe itself, and every probe read that
  // minute, settling or not), and x = (capped ? 1 : 0) - fraction of the
  // group capped. With bias b and cap effect e, offset = b' + e*x exactly,
  // so the slope of offset on x is e. Mean-capped minus mean-uncapped
  // would come out 11% low with one cap rotating through three probes.
  const offsetAcc = new Map<string, { port: number; cap: Cap; t: number[]; h: number[]; rawT: number[]; rawH: number[] }>();
  const fit = new Map<number, { x: number[]; t: number[]; h: number[] }>();
  const series: ProbeTestReport['series'] = [];
  let compared = 0;
  for (const minute of minutes) {
    const ports = Array.from(byMinute.get(minute)!.values());
    if (ports.length < 2) continue;
    compared++;
    const meanT = mean(ports.map((p) => p.temp));
    const meanH = mean(ports.map((p) => p.hum));
    const frac = ports.filter((p) => p.cap === 'capped').length / ports.length;
    for (const p of ports) {
      const dT = p.temp - meanT;
      const dH = p.hum - meanH;
      const settling = skip.has(skipKey(minute, p.port));
      series.push({ minute, port: p.port, cap: p.cap, tempOffset: dT, humOffset: dH, settling });
      if (settling) continue;
      const key = `${p.port}:${p.cap}`;
      const acc = offsetAcc.get(key) ?? { port: p.port, cap: p.cap, t: [], h: [], rawT: [], rawH: [] };
      acc.t.push(dT);
      acc.h.push(dH);
      acc.rawT.push(p.temp);
      acc.rawH.push(p.hum);
      offsetAcc.set(key, acc);
      const f = fit.get(p.port) ?? { x: [], t: [], h: [] };
      f.x.push((p.cap === 'capped' ? 1 : 0) - frac);
      f.t.push(dT);
      f.h.push(dH);
      fit.set(p.port, f);
    }
  }

  const offsets: OffsetStats[] = Array.from(offsetAcc.values())
    .sort((a, b) => a.port - b.port || a.cap.localeCompare(b.cap))
    .map((a) => ({
      port: a.port,
      cap: a.cap,
      minutes: a.t.length,
      meanTempC: mean(a.rawT),
      meanHum: mean(a.rawH),
      tempOffset: { mean: mean(a.t), sd: sd(a.t) },
      humOffset: { mean: mean(a.h), sd: sd(a.h) },
    }));

  const capEffects: CapEffect[] = [];
  const pooled = { x: [] as number[], t: [] as number[], h: [] as number[] };
  let fittedPorts = 0;
  for (const port of Array.from(fit.keys()).sort((a, b) => a - b)) {
    const f = fit.get(port)!;
    const eT = slope(f.x, f.t);
    const eH = slope(f.x, f.h);
    capEffects.push({ port, tempC: eT, hum: eT == null ? null : eH });
    if (eT == null) continue;
    fittedPorts++;
    // Pooled: each port centred on its own means, so biases stay out.
    const mx = mean(f.x);
    const mt = mean(f.t);
    const mh = mean(f.h);
    pooled.x.push(...f.x.map((x) => x - mx));
    pooled.t.push(...f.t.map((t) => t - mt));
    pooled.h.push(...f.h.map((h) => h - mh));
  }
  const pooledT = slope(pooled.x, pooled.t);
  const pooledH = slope(pooled.x, pooled.h);
  const pooledCapEffect = pooledT != null && pooledH != null && fit.size > 1 && fittedPorts > 0 ? { tempC: pooledT, hum: pooledH } : null;

  // Probe against the reference rounds.
  const vs = new Map<string, number[]>();
  const push = (port: number, cap: Cap, kind: ReferenceKind, value: number) => {
    const key = `${port}|${cap}|${kind}`;
    vs.set(key, [...(vs.get(key) ?? []), value]);
  };
  const near = (minute: number): [number, Map<number, MinuteRow>] => {
    for (const d of [0, -1, 1]) {
      const m = minute + d * MINUTE_MS;
      const ports = byMinute.get(m);
      if (ports) return [m, ports];
    }
    return [minute, new Map()];
  };
  for (const r of refs) {
    const f = parseFields(r.message);
    const [minute, ports] = near(toMinute(sampleTimeMs(r)));
    if (f.kind === 'probe' && r.temp_c != null) {
      const port = Number(f.port);
      if (!skip.has(skipKey(minute, port))) push(port, f.cap, 'tip', r.temp_c - Number(f.ir_c));
    } else if (f.kind === 'target' || f.kind === 'room') {
      const refT = Number(f.kind === 'target' ? f.ir_c : f.temp_c);
      const refH = f.kind === 'room' && f.hum != null ? Number(f.hum) : null;
      ports.forEach((row, port) => {
        if (skip.has(skipKey(minute, port))) return;
        push(port, row.cap, f.kind as ReferenceKind, row.temp - refT);
        if (refH != null) push(port, row.cap, 'roomH', row.hum - refH);
      });
    }
  }
  const refPorts = Array.from(new Set(Array.from(vs.keys()).map((k) => Number(k.split('|')[0])))).sort((a, b) => a - b);
  const references: ReferenceComparison[] = [];
  for (const port of refPorts) {
    for (const kind of ['tip', 'target', 'room', 'roomH'] as ReferenceKind[]) {
      const uncapped = vs.get(`${port}|uncapped|${kind}`) ?? [];
      const capped = vs.get(`${port}|capped|${kind}`) ?? [];
      if (uncapped.length || capped.length) references.push({ port, kind, uncapped, capped });
    }
  }

  return {
    rows: rows.length,
    minutes: minutes.length,
    comparedMinutes: compared,
    settlingDropped: skip.size,
    referenceValues: refs.length,
    offsets,
    capEffects,
    pooledCapEffect,
    references,
    series,
  };
}
