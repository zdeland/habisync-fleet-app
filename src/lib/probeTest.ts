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

const MINUTE_MS = 60_000;

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

// The script's --latest window: start to the scheduled end (start +
// duration), or to an earlier stop, or to now while still running. Not to
// the end row: that's written when someone presses Done, which can be hours
// after time ran out, with the last cap still on and the readings outside
// the test.
export function sessionWindow(session: ProbeTestSession, nowIso: string): { since: string; until: string } {
  let untilMs = Date.parse(session.endedAt ?? nowIso);
  if (session.durationMin != null) {
    untilMs = Math.min(untilMs, Date.parse(session.startedAt) + session.durationMin * MINUTE_MS);
  }
  return { since: session.startedAt, until: new Date(untilMs).toISOString() };
}

// ---------------------------------------------------------------------------
// Analysis — probe_test_report.py, function for function.

export const SETTLE_MINUTES = 10;

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

// One round of reference readings as the person entered them (the unit
// takes °F and logs °C). Not part of the script's report, which only shows
// probe-minus-reference; here so the readings themselves can be seen.
export type ReferenceRound = {
  at: string; // sample time of the round's rows
  phase: number | null;
  roomC: number | null; // the thermostat's temperature
  roomHum: number | null; // the thermostat's humidity, if it shows one
  targetIrC: number | null; // IR on the neutral target (the tape patch)
  probes: { port: number; cap: string; irC: number; readingC: number | null }[]; // IR on each tip
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
  rounds: ReferenceRound[]; // oldest first
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

// Solves a·x = b for each b in bs (Gaussian elimination, partial pivoting);
// null when a is singular, i.e. the data can't separate the unknowns.
function solve(a: number[][], bs: number[][]): number[][] | null {
  const n = a.length;
  const m = a.map((row, i) => [...row, ...bs.map((b) => b[i])]);
  const scale = Math.max(1e-300, ...a.flat().map(Math.abs));
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(m[r][col]) > Math.abs(m[piv][col])) piv = r;
    if (Math.abs(m[piv][col]) < 1e-9 * scale) return null;
    [m[col], m[piv]] = [m[piv], m[col]];
    for (let r = 0; r < n; r++) {
      if (r === col || m[r][col] === 0) continue;
      const f = m[r][col] / m[col][col];
      m[r] = m[r].map((x, j) => x - f * m[col][j]);
    }
  }
  return bs.map((_, j) => m.map((row, i) => row[n + j] / m[i][i]));
}

export type FitPoint = { port: number; capped: boolean; temp: number; hum: number };

// Every probe's bias and cap effect at once — the script's joint_fit(). The
// model is reading[p,m] = room[m] + bias[p] + effect[p]·capped[p,m];
// subtracting each minute's mean over its probes removes room[m], leaving
//   offset[p,m] = bias[p] − mean(bias) + effect[p]·capped[p,m]
//                 − mean over the minute's probes of effect[q]·capped[q,m]
// which is linear in the biases and effects, so least squares solves them
// together — exact whatever the schedule and whatever each cap's own effect.
// (Fitting each probe on its own, as the first version did, is exact only
// when every cap has the same effect: while probe A is uncapped and B is
// capped, A's offset moves by B's effect, not A's.)
// Returns each port that was both capped and uncapped → its effect, or null
// when the schedule can't separate them (e.g. probes only capped together).
export function jointFit(minutes: FitPoint[][]): Map<number, { tempC: number; hum: number }> | null {
  const ports = Array.from(new Set(minutes.flat().map((p) => p.port))).sort((a, b) => a - b);
  const everCapped = new Set(minutes.flat().filter((p) => p.capped).map((p) => p.port));
  const everUncapped = new Set(minutes.flat().filter((p) => !p.capped).map((p) => p.port));
  const ePorts = ports.filter((p) => everCapped.has(p) && everUncapped.has(p));
  if (ePorts.length === 0) return null;
  // A probe always capped (or never) has its cap folded into its bias.
  const bCol = new Map(ports.map((p, i) => [p, i]));
  const eCol = new Map(ePorts.map((p, i) => [p, ports.length + i]));
  const k = ports.length + ePorts.length;
  const ata = Array.from({ length: k }, () => new Array<number>(k).fill(0));
  const atyT = new Array<number>(k).fill(0);
  const atyH = new Array<number>(k).fill(0);
  const add = (row: number[], yT: number, yH: number) => {
    const nz = row.map((v, i) => [i, v]).filter(([, v]) => v !== 0);
    for (const [i, vi] of nz) {
      atyT[i] += vi * yT;
      atyH[i] += vi * yH;
      for (const [j, vj] of nz) ata[i][j] += vi * vj;
    }
  };
  for (const m of minutes) {
    if (m.length < 2) continue;
    const meanT = mean(m.map((p) => p.temp));
    const meanH = mean(m.map((p) => p.hum));
    for (const p of m) {
      const row = new Array<number>(k).fill(0);
      for (const q of m) {
        const w = (q.port === p.port ? 1 : 0) - 1 / m.length;
        row[bCol.get(q.port)!] += w;
        const e = eCol.get(q.port);
        if (q.capped && e != null) row[e] += w;
      }
      add(row, p.temp - meanT, p.hum - meanH);
    }
  }
  // Biases are only known relative to each other: pin their sum to 0.
  add(new Array<number>(k).fill(0).map((_, i) => (i < ports.length ? 1 : 0)), 0, 0);
  const sol = solve(ata, [atyT, atyH]);
  if (!sol) return null;
  return new Map(ePorts.map((p) => [p, { tempC: sol[0][eCol.get(p)!], hum: sol[1][eCol.get(p)!] }]));
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
  // minute, settling or not) is the descriptive table and chart; the cap
  // effect comes from jointFit() over the same minutes, settling
  // port-minutes left out. Mean-capped minus mean-uncapped would come out
  // 11% low with one cap rotating through three probes.
  const offsetAcc = new Map<string, { port: number; cap: Cap; t: number[]; h: number[]; rawT: number[]; rawH: number[] }>();
  const fitMinutes: FitPoint[][] = [];
  const series: ProbeTestReport['series'] = [];
  let compared = 0;
  for (const minute of minutes) {
    const ports = Array.from(byMinute.get(minute)!.values());
    if (ports.length < 2) continue;
    compared++;
    const meanT = mean(ports.map((p) => p.temp));
    const meanH = mean(ports.map((p) => p.hum));
    const counted: FitPoint[] = [];
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
      counted.push({ port: p.port, capped: p.cap === 'capped', temp: p.temp, hum: p.hum });
    }
    if (counted.length >= 2) fitMinutes.push(counted);
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

  const effects = jointFit(fitMinutes);
  const testedPorts = Array.from(new Set(fitMinutes.flat().map((p) => p.port))).sort((a, b) => a - b);
  const capEffects: CapEffect[] = testedPorts.map((port) => {
    const e = effects?.get(port);
    return { port, tempC: e ? e.tempC : null, hum: e ? e.hum : null };
  });
  // The mean of the probes' effects, when there's more than one.
  const fitted = capEffects.filter((e) => e.tempC != null);
  const pooledCapEffect =
    fitted.length > 1 ? { tempC: mean(fitted.map((e) => e.tempC!)), hum: mean(fitted.map((e) => e.hum!)) } : null;

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

  // The rounds as entered: a round's rows are written together and share a
  // sample time, so group on that (and the phase, in case two land close).
  const roundsByKey = new Map<string, ReferenceRound>();
  for (const r of refs) {
    const f = parseFields(r.message);
    const at = new Date(sampleTimeMs(r)).toISOString();
    const phase = f.ph != null ? Number(f.ph) : null;
    const key = `${at}|${phase}`;
    const round = roundsByKey.get(key) ?? { at, phase, roomC: null, roomHum: null, targetIrC: null, probes: [] };
    if (f.kind === 'room') {
      round.roomC = f.temp_c != null ? Number(f.temp_c) : null;
      round.roomHum = f.hum != null ? Number(f.hum) : null;
    } else if (f.kind === 'target') {
      round.targetIrC = Number(f.ir_c);
    } else if (f.kind === 'probe') {
      round.probes.push({ port: Number(f.port), cap: f.cap, irC: Number(f.ir_c), readingC: r.temp_c });
    }
    roundsByKey.set(key, round);
  }
  const rounds = Array.from(roundsByKey.values()).map((round) => ({
    ...round,
    probes: round.probes.sort((a, b) => a.port - b.port),
  }));

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
    rounds,
    series,
  };
}
