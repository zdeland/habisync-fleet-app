// The probe cap test analysis — src/lib/probeTest.ts, a port of the
// firmware repo's scripts/probe_test_report.py. The synthetic session has a
// known bias and cap effect per probe, so the fit must recover them
// exactly; the naive "capped mean minus uncapped mean" is checked to come
// out low, which is why the handoff says not to use it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeProbeTest, isOverdue, parseFields, sessionsFromLogs } from '../src/lib/probeTest';
import type { LogRow, TelemetryRow } from '../src/lib/types';

const T0 = Date.parse('2026-10-11T22:14:00Z');
const at = (min: number) => new Date(T0 + min * 60_000).toISOString();

function log(min: number, tag: 'probetest' | 'reference', message: string, temp_c: number | null = null): LogRow {
  return {
    id: min * 10 + Math.floor(Math.random() * 10),
    device_id: 'hs-f0a798',
    level: 2,
    tag,
    message,
    uptime_ms: 0,
    device_time: at(min),
    created_at: at(min),
    temp_c,
    hum: null,
    outlet_index: null,
    outlet_state: null,
    outlet_roles: null,
    profile_config: null,
  };
}

const BIAS = [0.3, -0.1, -0.2]; // °C, per port
const EFFECT = [0.5, 0.8, 0.2]; // °C a cap adds, per port
const HUM_EFFECT = [-2, -3, -1];

// 4 phases x 60 min: baseline, then the one cap on port 0, 1, 2. The room
// drifts, which the per-minute group mean must cancel.
function session(): TelemetryRow[] {
  const rows: TelemetryRow[] = [];
  let id = 0;
  for (let min = 0; min < 240; min++) {
    const phase = Math.floor(min / 60);
    const room = 24 + Math.sin(min / 30);
    for (let port = 0; port < 3; port++) {
      const capped = phase > 0 && phase - 1 === port;
      rows.push({
        id: ++id,
        device_id: 'hs-f0a798',
        created_at: at(min),
        device_time: at(min),
        port,
        probe_cap: capped ? 'capped' : 'uncapped',
        temp_c: room + BIAS[port] + (capped ? EFFECT[port] : 0),
        hum: 60 + (capped ? HUM_EFFECT[port] : 0),
        outlet_mask: null,
        free_heap: 0,
        rssi: -50,
      });
    }
  }
  return rows;
}

test('parses key=value fields', () => {
  assert.deepEqual(parseFields('start s=1791756852 dur_min=240 ports=0,1,2 all=0'), {
    s: '1791756852',
    dur_min: '240',
    ports: '0,1,2',
    all: '0',
  });
});

test('pairs each start with its own end or stop; an unmatched start is open', () => {
  const sessions = sessionsFromLogs([
    log(0, 'probetest', 'start s=100 dur_min=60 ports=0,3 all=0'),
    log(2, 'probetest', 'stop s=100'),
    log(3, 'probetest', 'start s=200 dur_min=240 ports=0,1,2 all=1'),
    log(70, 'probetest', 'caps s=200 phase=1 capped=0'),
    log(250, 'probetest', 'end s=200'),
    log(300, 'probetest', 'start s=300 dur_min=60 ports=0 all=0'),
  ]);
  assert.deepEqual(
    sessions.map((s) => [s.id, s.status, s.ports, s.allCappedPhase, s.caps.map((c) => c.capped)]),
    [
      ['300', 'open', [0], false, []],
      ['200', 'finished', [0, 1, 2], true, [[0]]],
      ['100', 'abandoned', [0, 3], false, []],
    ],
  );
  assert.equal(isOverdue(sessions[0], T0 + 330 * 60_000), false);
  assert.equal(isOverdue(sessions[0], T0 + 430 * 60_000), true);
});

test('recovers the cap effect exactly when every cap has the same effect', () => {
  const rows = session().map((r) => (r.probe_cap === 'capped' ? { ...r, temp_c: r.temp_c - EFFECT[r.port!] + 0.5 } : r));
  const report = analyzeProbeTest(rows, [], { since: at(0), until: at(240) }, '1');
  assert.equal(report.comparedMinutes, 240);
  // Settling: 10 minutes after each port's cap goes on and comes off.
  assert.equal(report.settlingDropped, 10 * 5);
  for (const effect of report.capEffects) {
    assert.ok(Math.abs(effect.tempC! - 0.5) < 1e-9, `port ${effect.port} temp ${effect.tempC}`);
  }
  assert.ok(Math.abs(report.pooledCapEffect!.tempC - 0.5) < 1e-9);

  // The naive estimate the handoff warns against, for contrast: with one
  // cap among three probes it comes out low.
  const port0 = report.offsets.filter((o) => o.port === 0);
  const naive =
    port0.find((o) => o.cap === 'capped')!.tempOffset.mean - port0.find((o) => o.cap === 'uncapped')!.tempOffset.mean;
  assert.ok(naive < 0.5 - 0.01, `naive ${naive} should undershoot 0.5`);
});

// A session built to be awkward — unequal cap effects, a final all-capped
// phase, a drifting room, a probe dropping out, a backlog uploaded under
// one created_at, reference rounds — and the numbers the firmware repo's
// scripts/probe_test_report.py printed for exactly these rows (run on
// 2026-10-11 via a harness that fed it this data instead of Supabase).
// With unequal effects the method is not exact (port 2 is truly +0.8,
// port 3 +0.2) — the point here is parity with the script, not truth.
function awkwardSession(): { telemetry: TelemetryRow[]; logs: LogRow[] } {
  const iso = (ms: number) => new Date(ms).toISOString();
  const bias = [0.3, -0.1, -0.2];
  const effect = [0.5, 0.8, 0.2];
  const humEffect = [-2, -3, -1];
  const telemetry: TelemetryRow[] = [];
  const logs: LogRow[] = [];
  let id = 0;
  const addLog = (ms: number, tag: 'probetest' | 'reference', message: string, temp_c: number | null = null, hum: number | null = null) =>
    logs.push({ ...log(0, tag, message, temp_c), id: ++id, hum, device_time: iso(ms), created_at: iso(ms + 900) });
  addLog(T0 - 600_000, 'probetest', 'start s=1 dur_min=240 ports=0,1,2 all=1');
  addLog(T0 - 540_000, 'probetest', 'stop s=1');
  addLog(T0, 'probetest', 'start s=2 dur_min=300 ports=0,1,2 all=1');
  for (let min = 0; min < 300; min++) {
    const phase = Math.floor(min / 60);
    const t = T0 + min * 60_000 + 8_000;
    const room = 24 + Math.sin(min / 25) + min * 0.002;
    const rh = 60 + Math.cos(min / 40) * 3;
    if (min % 60 === 0 && phase > 0) addLog(t, 'probetest', `caps s=2 phase=${phase} capped=${phase === 4 ? '0,1,2' : phase - 1}`);
    for (let port = 0; port < 3; port++) {
      if (port === 2 && min >= 130 && min < 134) continue;
      const capped = phase === 4 || (phase > 0 && phase - 1 === port);
      const created = min >= 200 && min < 215 ? T0 + 215 * 60_000 : t + 2_000;
      telemetry.push({
        id: ++id,
        device_id: 'hs-test',
        created_at: iso(created),
        device_time: iso(t),
        port,
        probe_cap: capped ? 'capped' : 'uncapped',
        temp_c: Math.round((room + bias[port] + (capped ? effect[port] : 0) + Math.sin(min * 7 + port) * 0.05) * 10) / 10,
        hum: Math.round((rh + (capped ? humEffect[port] : 0)) * 10) / 10,
        outlet_mask: null,
        free_heap: 0,
        rssi: -50,
      });
    }
    if (min % 60 === 30) {
      for (let port = 0; port < 3; port++) {
        const capped = phase === 4 || (phase > 0 && phase - 1 === port);
        addLog(
          t + 20_000,
          'reference',
          `s=2 ph=${phase} kind=probe port=${port} cap=${capped ? 'capped' : 'uncapped'} ir_c=${(room - 0.6 + port * 0.1).toFixed(2)}`,
          room + bias[port],
          rh,
        );
      }
      addLog(t + 20_000, 'reference', `s=2 ph=${phase} kind=target ir_c=${(room - 0.4).toFixed(2)}`);
      addLog(t + 20_000, 'reference', `s=2 ph=${phase} kind=room temp_c=${(room + 1).toFixed(2)}${phase % 2 ? ` hum=${(rh - 4).toFixed(0)}` : ''}`);
    }
  }
  addLog(T0 + 300 * 60_000 + 30_000, 'probetest', 'end s=2');
  return { telemetry, logs };
}

test('matches probe_test_report.py on an awkward session', () => {
  const { telemetry, logs } = awkwardSession();
  const latest = sessionsFromLogs(logs)[0];
  assert.equal(latest.id, '2');
  assert.equal(latest.status, 'finished');
  const r = analyzeProbeTest(telemetry, logs, { since: latest.startedAt, until: latest.endedAt! }, latest.id);
  assert.deepEqual([r.rows, r.minutes, r.comparedMinutes, r.settlingDropped, r.referenceValues], [896, 300, 300, 70, 25]);

  const fmt = (v: number, d: number) => `${v >= 0 ? '+' : ''}${v.toFixed(d)}`;
  assert.deepEqual(
    r.offsets.map((o) => [
      o.port + 1,
      o.cap,
      o.minutes,
      o.meanTempC.toFixed(2),
      o.meanHum.toFixed(1),
      fmt(o.tempOffset.mean, 2),
      o.tempOffset.sd.toFixed(2),
      fmt(o.humOffset.mean, 1),
      o.humOffset.sd.toFixed(1),
    ]),
    [
      [1, 'capped', 100, '24.49', '58.2', '+0.46', '0.17', '-0.7', '0.7'],
      [1, 'uncapped', 170, '25.02', '60.6', '+0.19', '0.13', '+0.4', '0.4'],
      [2, 'capped', 100, '24.67', '57.1', '+0.31', '0.12', '-1.5', '0.5'],
      [2, 'uncapped', 170, '24.44', '60.6', '-0.17', '0.08', '+0.3', '0.3'],
      [3, 'capped', 110, '24.36', '61.1', '-0.30', '0.22', '+0.2', '0.8'],
      [3, 'uncapped', 176, '24.05', '59.4', '-0.34', '0.11', '+0.5', '0.4'],
    ],
  );
  assert.deepEqual(
    r.capEffects.map((e) => [e.port + 1, fmt(e.tempC!, 2), fmt(e.hum!, 1)]),
    [
      [1, '+0.50', '-2.0'],
      [2, '+0.65', '-2.5'],
      [3, '+0.34', '-1.5'],
    ],
  );
  assert.deepEqual([fmt(r.pooledCapEffect!.tempC, 2), fmt(r.pooledCapEffect!.hum, 1)], ['+0.49', '-2.0']);

  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const cell = (xs: number[], d: number) => (xs.length ? `${fmt(mean(xs), d)} (n=${xs.length})` : '-');
  assert.deepEqual(
    r.references.map((x) => [x.port + 1, x.kind, cell(x.uncapped, x.kind === 'roomH' ? 1 : 2), cell(x.capped, x.kind === 'roomH' ? 1 : 2)]),
    [
      [1, 'tip', '+0.90 (n=3)', '+0.90 (n=2)'],
      [1, 'target', '+0.74 (n=3)', '+1.20 (n=2)'],
      [1, 'room', '-0.66 (n=3)', '-0.20 (n=2)'],
      [1, 'roomH', '+3.5 (n=1)', '+2.1 (n=1)'],
      [2, 'tip', '+0.40 (n=3)', '+0.40 (n=2)'],
      [2, 'target', '+0.33 (n=3)', '+1.11 (n=2)'],
      [2, 'room', '-1.07 (n=3)', '-0.29 (n=2)'],
      [2, 'roomH', '+3.8 (n=2)', '-'],
      [3, 'tip', '+0.20 (n=3)', '+0.20 (n=2)'],
      [3, 'target', '+0.15 (n=3)', '+0.44 (n=2)'],
      [3, 'room', '-1.25 (n=3)', '-0.96 (n=2)'],
      [3, 'roomH', '+4.1 (n=1)', '+2.5 (n=1)'],
    ],
  );
});

test('a baseline-only session has no cap effect yet', () => {
  const baseline = session().filter((r) => Date.parse(r.created_at) < T0 + 60 * 60_000);
  const report = analyzeProbeTest(baseline, [], { since: at(0), until: at(60) }, '1');
  assert.ok(report.capEffects.every((e) => e.tempC == null));
  assert.equal(report.pooledCapEffect, null);
  assert.equal(report.offsets.length, 3);
});

test('compares probes with the reference rounds at the nearest minute, for this session only', () => {
  const refs = [
    log(30, 'reference', 's=1 ph=0 kind=probe port=0 cap=uncapped ir_c=23.00', 24.5),
    log(30, 'reference', 's=1 ph=0 kind=target ir_c=24.00'),
    log(30, 'reference', 's=1 ph=0 kind=room temp_c=25.00 hum=55'),
    log(30, 'reference', 's=9 ph=0 kind=target ir_c=0'),
  ];
  const report = analyzeProbeTest(session(), refs, { since: at(0), until: at(240) }, '1');
  assert.equal(report.referenceValues, 3);
  const tip = report.references.find((r) => r.port === 0 && r.kind === 'tip')!;
  assert.deepEqual(tip.uncapped.map((v) => Number(v.toFixed(6))), [1.5]);
  const target = report.references.find((r) => r.port === 1 && r.kind === 'target')!;
  const roomT = 24 + Math.sin(30 / 30);
  assert.ok(Math.abs(target.uncapped[0] - (roomT + BIAS[1] - 24)) < 1e-9);
  const roomH = report.references.find((r) => r.port === 2 && r.kind === 'roomH')!;
  assert.deepEqual(roomH.uncapped, [5]);
});
