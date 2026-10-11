// Firmware 0.35.0's sensor trust gates as the cloud sees them —
// src/lib/sensorFaults.ts, plus the two paths through evaluateClimateStep
// that climate_vectors.json doesn't reach (the log-driven override, and the
// automation toggle that clears a latch).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateClimateStep, INITIAL_CLIMATE_STATE, type ClimateProfile } from '../src/lib/automation';
import {
  activeSensorFaults,
  detectSensorAnomalies,
  faultsAt,
  parseSensorEdge,
  sensorFaultEpisodes,
} from '../src/lib/sensorFaults';
import type { Device, LogRow, LogTag, ProfileConfig, TelemetryRow } from '../src/lib/types';

const T0 = Date.parse('2026-09-15T12:00:00.000Z');
const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();

const HUM_FAULT = 'Humidity sensor not trusted (no rise while misting) at 28.4 %RH — mister held off until the reading recovers';
const HUM_OK = 'Humidity sensor trusted again at 29.5 %RH — mister back under humidistat control';
const TEMP_FAULT = 'Temperature sensor not trusted (implausible reading) at nan C — heater held off until the reading recovers';

function log(minutes: number, tag: LogTag, message: string, profile_config: Partial<ProfileConfig> | null = null): LogRow {
  return {
    id: minutes,
    device_id: 'dev-1',
    level: 0,
    tag,
    message,
    uptime_ms: 0,
    device_time: null,
    created_at: at(minutes),
    temp_c: null,
    hum: null,
    outlet_index: null,
    outlet_state: null,
    outlet_roles: null,
    profile_config: profile_config as ProfileConfig | null,
  };
}

function device(overrides: Partial<Device> = {}): Device {
  return {
    device_id: 'dev-1',
    name: 'Test',
    fw_version: '0.35.0',
    ip: '',
    rssi: -50,
    free_heap: 0,
    // booted at minute -60, seen at minute 120
    uptime_ms: 180 * 60_000,
    active_backend: 'kasa',
    reset_reason: 'power-on',
    outlet_roles: ['Heater', 'Mister', 'Fan'],
    profile_config: { enabled: true, temp_low_c: 24, temp_high_c: 32, hum_low: 30, hum_high: 40 } as ProfileConfig,
    first_seen: at(-1000),
    last_seen: at(120),
    ...overrides,
  };
}

function sample(minutes: number, temp_c: number, hum: number, outlet_mask = 0): TelemetryRow {
  return { id: minutes, device_id: 'dev-1', created_at: at(minutes), temp_c, hum, outlet_mask, free_heap: 0, rssi: -50 };
}

test('parses both edges on both channels, and ignores other sensor rows', () => {
  assert.deepEqual(parseSensorEdge({ tag: 'sensor', message: HUM_FAULT }), {
    channel: 'hum',
    kind: 'fault',
    reason: 'no rise while misting',
    value: 28.4,
  });
  assert.deepEqual(parseSensorEdge({ tag: 'sensor', message: HUM_OK }), {
    channel: 'hum',
    kind: 'recovered',
    reason: null,
    value: 29.5,
  });
  const temp = parseSensorEdge({ tag: 'sensor', message: TEMP_FAULT });
  assert.equal(temp?.channel, 'temp');
  assert.equal(temp?.reason, 'implausible reading');
  assert.ok(Number.isNaN(temp?.value));
  assert.equal(parseSensorEdge({ tag: 'sensor', message: 'SHT30 read failed' }), null);
  assert.equal(parseSensorEdge({ tag: 'event', message: HUM_FAULT }), null);
});

test('an episode ends at its recovery row, a boot row, or automation switched off', () => {
  const episodes = sensorFaultEpisodes([
    log(0, 'sensor', HUM_FAULT),
    log(5, 'sensor', HUM_OK),
    log(10, 'sensor', HUM_FAULT),
    log(20, 'boot', 'v0.35.0 up after power-on'),
    log(30, 'sensor', TEMP_FAULT),
    log(40, 'config', 'settings saved', { enabled: true }),
    log(50, 'config', 'settings saved', { enabled: false }),
    log(60, 'sensor', HUM_FAULT),
  ]);
  assert.deepEqual(
    episodes.map((e) => [e.channel, e.startedAt, e.endedAt, e.endedBy]),
    [
      ['hum', at(0), at(5), 'recovered'],
      ['hum', at(10), at(20), 'reboot'],
      ['temp', at(30), at(50), 'automation-off'],
      ['hum', at(60), null, null],
    ],
  );
  assert.deepEqual(faultsAt(episodes, at(3)), { temp: false, hum: true });
  assert.deepEqual(faultsAt(episodes, at(7)), { temp: false, hum: false });
  assert.deepEqual(faultsAt(episodes, at(45)), { temp: true, hum: false });
  assert.deepEqual(faultsAt(episodes, at(90)), { temp: false, hum: true });
});

test('the two channels latch independently', () => {
  const episodes = sensorFaultEpisodes([log(0, 'sensor', HUM_FAULT), log(5, 'sensor', TEMP_FAULT), log(9, 'sensor', HUM_OK)]);
  assert.deepEqual(faultsAt(episodes, at(7)), { temp: true, hum: true });
  assert.deepEqual(faultsAt(episodes, at(10)), { temp: true, hum: false });
});

test('an open fault older than the current boot is not active', () => {
  const rows = [log(-90, 'sensor', HUM_FAULT), log(30, 'sensor', TEMP_FAULT)];
  const active = activeSensorFaults(device(), rows, sample(120, 25, 35));
  assert.deepEqual(
    active.map((f) => f.channel),
    ['temp'],
  );
});

test('no fault is active while automation is off', () => {
  const rows = [log(30, 'sensor', TEMP_FAULT)];
  const off = device({ profile_config: { enabled: false } as ProfileConfig });
  assert.deepEqual(activeSensorFaults(off, rows, null), []);
});

test('a fault escalates once its channel reads below the low threshold', () => {
  const rows = [log(30, 'sensor', TEMP_FAULT), log(31, 'sensor', HUM_FAULT)];
  const cold = activeSensorFaults(device(), rows, sample(120, 22, 35));
  assert.deepEqual(
    cold.map((f) => [f.channel, f.escalated]),
    [
      ['temp', true],
      ['hum', false],
    ],
  );
  const dry = activeSensorFaults(device(), rows, sample(120, 26, 20));
  assert.deepEqual(
    dry.map((f) => [f.channel, f.escalated]),
    [
      ['temp', false],
      ['hum', true],
    ],
  );
});

const PROFILE: ClimateProfile = { tempLow: 24, tempHigh: 32, humidityLow: 30, humidityHigh: 40 };

test('a logged fault overrides the replay; simulated watchdogs stay out of it', () => {
  // Mister on with humidity falling for many steps: the simulated watchdog
  // would latch by step 4, but with the override saying "trusted" the
  // humidistat keeps misting, as it must when replaying 60s telemetry.
  let state = INITIAL_CLIMATE_STATE;
  for (const hum of [29, 28.8, 28.6, 28.4, 28.2, 28.0]) {
    const result = evaluateClimateStep(state, PROFILE, true, 28, hum, { temp: false, hum: false });
    state = result.state;
    assert.equal(result.decision.mist, true, `hum ${hum}`);
  }
  const faulted = evaluateClimateStep(state, PROFILE, true, 33, 45, { temp: true, hum: true });
  assert.deepEqual(faulted.decision, { heat: false, mist: false, fan: false, tooHot: false, tooHumid: false });
});

test('switching automation off and on clears a simulated latch, as setEnabled() does', () => {
  let state = evaluateClimateStep(INITIAL_CLIMATE_STATE, PROFILE, true, 28, 0).state;
  assert.equal(state.humFaulted, true);
  state = evaluateClimateStep(state, PROFILE, true, 28, 25).state; // risen above 0 + 1.0 -> would clear anyway
  state = evaluateClimateStep(state, PROFILE, true, 28, 0).state;
  assert.equal(state.humFaulted, true);
  state = evaluateClimateStep(state, PROFILE, true, 28, 0.5).state;
  assert.equal(state.humFaulted, true, 'still implausible, no rise');
  state = evaluateClimateStep(state, PROFILE, false, 28, 0.5).state;
  assert.equal(state.humFaulted, true, 'disabled freezes state, does not clear it');
  const resumed = evaluateClimateStep(state, PROFILE, true, 28, 25);
  assert.equal(resumed.state.humFaulted, false);
  assert.equal(resumed.decision.mist, true);
});

const noRoles = () => -1;
const roles = (_row: TelemetryRow, role: 'Heater' | 'Mister') => ['Heater', 'Mister', 'Fan'].indexOf(role);

test('flags humidity pinned at 0.0 while temperature moves, once per streak', () => {
  const rows = [sample(0, 25, 40), sample(1, 25.1, 0), sample(2, 25.2, 0), sample(3, 25.3, 0), sample(4, 25.4, 0)];
  const found = detectSensorAnomalies(rows, '0.35.0', noRoles);
  assert.deepEqual(
    found.map((a) => [a.kind, a.since, a.at]),
    [['hum-pinned-zero', at(1), at(3)]],
  );
  const wholePartDead = rows.map((r) => ({ ...r, temp_c: 25 }));
  assert.equal(detectSensorAnomalies(wholePartDead, '0.35.0', noRoles).filter((a) => a.kind === 'hum-pinned-zero').length, 0);
});

test('flags a temperature that never moves while humidity does', () => {
  const rows = Array.from({ length: 31 }, (_, i) => sample(i, 26.4, 35 + (i % 3)));
  assert.deepEqual(
    detectSensorAnomalies(rows, '0.35.0', noRoles).map((a) => [a.kind, a.at]),
    [['temp-stuck', at(29)]],
  );
  assert.deepEqual(detectSensorAnomalies(rows.slice(0, 29), '0.35.0', noRoles), []);
});

test('flags a heater running 15 min without a rise, as a runaway before 0.35.0', () => {
  const rows = Array.from({ length: 16 }, (_, i) => sample(i, 23 - i * 0.01, 35, 0b001));
  const gated = detectSensorAnomalies(rows, '0.35.0', roles);
  assert.deepEqual(
    gated.map((a) => [a.kind, a.at, a.runaway]),
    [['heater-no-rise', at(15), false]],
  );
  assert.equal(detectSensorAnomalies(rows, '0.34.0', roles)[0].runaway, true);
  const warming = rows.map((r, i) => ({ ...r, temp_c: 23 + i * 0.05 }));
  assert.deepEqual(detectSensorAnomalies(warming, '0.35.0', roles), []);
});

test('flags a mister on across three samples with humidity flat or falling', () => {
  const rows = [sample(0, 26, 29, 0b010), sample(1, 26.1, 28.8, 0b010), sample(2, 26.2, 28.6, 0b010)];
  assert.deepEqual(
    detectSensorAnomalies(rows, '0.35.0', roles).map((a) => [a.kind, a.at]),
    [['mister-no-rise', at(2)]],
  );
  const responding = [sample(0, 26, 29, 0b010), sample(1, 26.1, 29.6, 0b010), sample(2, 26.2, 30.2, 0b010)];
  assert.deepEqual(detectSensorAnomalies(responding, '0.35.0', roles), []);
});

test('a gap longer than six minutes breaks a streak', () => {
  const rows = [sample(0, 26, 29, 0b010), sample(1, 26.1, 28.8, 0b010), sample(10, 26.2, 28.6, 0b010)];
  assert.deepEqual(detectSensorAnomalies(rows, '0.35.0', roles), []);
});
