// The probe cap test analysis — src/lib/probeTest.ts, a port of the
// firmware repo's scripts/probe_test_report.py. The synthetic sessions have
// a known bias and cap effect per probe, unequal on purpose, so the joint
// fit must recover each cap's own effect; the naive "capped mean minus
// uncapped mean" is checked to come out wrong, which is why the handoff
// says not to use it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeProbeTest, isOverdue, jointFit, parseFields, sessionsFromLogs, sessionWindow } from '../src/lib/probeTest';
import { BIAS, EFFECT, HUM_EFFECT, T0, at, awkwardSession, log, session } from './fixtures/probeTestSessions';

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

test('recovers each cap’s own effect when the caps differ', () => {
  // EFFECT is +0.5 / +0.8 / +0.2 °C, HUM_EFFECT -2 / -3 / -1 %RH. Fitting
  // each probe on its own (this view's first version) gave 0.49/0.65/0.35.
  const report = analyzeProbeTest(session(), [], { since: at(0), until: at(240) }, '1');
  for (const effect of report.capEffects) {
    assert.ok(Math.abs(effect.tempC! - EFFECT[effect.port]) < 1e-9, `port ${effect.port} temp ${effect.tempC}`);
    assert.ok(Math.abs(effect.hum! - HUM_EFFECT[effect.port]) < 1e-9, `port ${effect.port} hum ${effect.hum}`);
  }
  // The mean of the probes' effects.
  assert.ok(Math.abs(report.pooledCapEffect!.tempC - 0.5) < 1e-9);
  assert.equal(BIAS.length, 3);
});

test('joint fit: caps only ever moved together come back null; a probe never capped has no effect', () => {
  const p = (port: number, capped: boolean, temp: number) => ({ port, capped, temp, hum: 50 });
  // Ports 0 and 1, the only two probes, only ever capped together: only
  // the difference between their caps shows, not either one.
  const together = Array.from({ length: 20 }, (_, m) => [p(0, m >= 10, 24 + (m >= 10 ? 1 : 0)), p(1, m >= 10, 24)]);
  assert.equal(jointFit(together), null);
  // Add a never-capped third probe and they separate: it anchors the group,
  // so each capped probe's own shift shows.
  const anchored = Array.from({ length: 20 }, (_, m) => [p(0, m >= 10, 24 + (m >= 10 ? 1 : 0)), p(1, m >= 10, 24), p(2, false, 24)]);
  const sep = jointFit(anchored)!;
  assert.ok(Math.abs(sep.get(0)!.tempC - 1) < 1e-9 && Math.abs(sep.get(1)!.tempC) < 1e-9);
  // One probe never capped: it's simply not in the result.
  const one = Array.from({ length: 20 }, (_, m) => [p(0, m >= 10, 24 + (m >= 10 ? 0.5 : 0)), p(2, false, 24)]);
  const fit = jointFit(one)!;
  assert.deepEqual(Array.from(fit.keys()), [0]);
  assert.ok(Math.abs(fit.get(0)!.tempC - 0.5) < 1e-9);
});

test('a session’s window ends when its time is up, not when Done is pressed', () => {
  const sessions = sessionsFromLogs([
    log(0, 'probetest', 'start s=7 dur_min=240 ports=0,1,2 all=0'),
    log(681, 'probetest', 'end s=7'), // Done pressed 7 h after time ran out
  ]);
  assert.deepEqual(sessionWindow(sessions[0], at(900)), { since: at(0), until: at(240) });
  // Still running: up to now. Stopped early: up to the stop.
  const open = sessionsFromLogs([log(0, 'probetest', 'start s=8 dur_min=240 ports=0,1 all=0')])[0];
  assert.equal(sessionWindow(open, at(100)).until, at(100));
  const stopped = sessionsFromLogs([log(0, 'probetest', 'start s=9 dur_min=240 ports=0,1 all=0'), log(30, 'probetest', 'stop s=9')])[0];
  assert.equal(sessionWindow(stopped, at(900)).until, at(30));
});

// fixtures/awkwardSession(): unequal cap effects, a final all-capped phase,
// a drifting room, rounding, a probe dropping out, a backlog uploaded under
// one created_at, reference rounds, and the caps left on 30 min past the
// scheduled end. The numbers are what the firmware repo's
// scripts/probe_test_report.py printed for exactly these rows (2026-10-12,
// via a harness that fed it the fixture instead of Supabase), and the cap
// effects are also the true ones.
test('matches probe_test_report.py on an awkward session', () => {
  const { telemetry, logs } = awkwardSession();
  const latest = sessionsFromLogs(logs)[0];
  assert.equal(latest.id, '2');
  assert.equal(latest.status, 'finished');
  const r = analyzeProbeTest(telemetry, logs, sessionWindow(latest, at(1000)), latest.id);
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
      [2, '+0.80', '-3.0'],
      [3, '+0.20', '-1.0'],
    ],
  );
  assert.deepEqual([fmt(r.pooledCapEffect!.tempC, 2), fmt(r.pooledCapEffect!.hum, 1)], ['+0.50', '-2.0']);

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

  // The rounds as entered, this session's only.
  assert.deepEqual(report.rounds, [
    {
      at: at(30),
      phase: 0,
      roomC: 25,
      roomHum: 55,
      targetIrC: 24,
      probes: [{ port: 0, cap: 'uncapped', irC: 23, readingC: 24.5 }],
    },
  ]);
});
