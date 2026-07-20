import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeOutletMismatches,
  NEW_DEVICE_GRACE_MS,
  OUTLET_ACTUATION_GRACE_MS,
  OUTLET_MISMATCH_DEBOUNCE_SAMPLES,
  type LastLoggedOutletState,
} from '../src/lib/queries';
import type { Device, TelemetryRow } from '../src/lib/types';

const FIRST_SEEN = '2026-01-01T00:00:00.000Z';

function makeDevice(overrides: Partial<Device> = {}): Device {
  return {
    device_id: 'dev-1',
    name: 'Test Device',
    fw_version: '1.0.0',
    ip: '10.0.0.1',
    rssi: -50,
    free_heap: 100000,
    uptime_ms: 0,
    active_backend: 'kasa',
    reset_reason: 'power-on',
    outlet_roles: ['Heater', 'Mister', 'Fan'],
    profile_config: {
      profile: 'Leopard Gecko',
      enabled: true,
      hum_low: 30,
      hum_high: 40,
      day_light_on: '07:00',
      day_light_off: '20:00',
      uvb_on: '08:00',
      uvb_off: '20:00',
      timezone: 'America/New_York',
      ota_url: '',
    },
    first_seen: FIRST_SEEN,
    last_seen: FIRST_SEEN,
    ...overrides,
  };
}

// newest-first, matching computeOutletMismatches's documented contract
function telemetryAt(isoTimes: string[], outletMask: number): TelemetryRow[] {
  return isoTimes.map((created_at, i) => ({
    id: i,
    device_id: 'dev-1',
    created_at,
    temp_c: 25,
    hum: 35,
    outlet_mask: outletMask,
    free_heap: 100000,
    rssi: -50,
  }));
}

function secondsAfterFirstSeen(seconds: number): string {
  return new Date(new Date(FIRST_SEEN).getTime() + seconds * 1000).toISOString();
}

function minutesAfterFirstSeen(minutes: number): string {
  return secondsAfterFirstSeen(minutes * 60);
}

function logged(outletState: boolean, loggedAtSeconds: number): Map<number, LastLoggedOutletState> {
  return new Map([[0, { outletState, loggedAt: secondsAfterFirstSeen(loggedAtSeconds) }]]);
}

test('flags a real, well-established mismatch outside both grace periods', () => {
  const device = makeDevice();
  // Heater (index 0) logged OFF a long time ago, and telemetry has shown it
  // ON for the whole debounce window since — well past both the new-device
  // and actuation grace periods.
  const times = [minutesAfterFirstSeen(120), minutesAfterFirstSeen(119)];
  const telemetry = telemetryAt(times, 0b001);

  const mismatches = computeOutletMismatches(device, telemetry, logged(false, 100 * 60));

  assert.deepEqual(mismatches, [{ outletIndex: 0, role: 'Heater', loggedState: false, actualState: true }]);
});

test('suppresses a mismatch within NEW_DEVICE_GRACE_MS of first_seen', () => {
  const device = makeDevice();
  const withinGraceMinutes = NEW_DEVICE_GRACE_MS / 60_000 - 1;
  const times = [minutesAfterFirstSeen(withinGraceMinutes), minutesAfterFirstSeen(withinGraceMinutes - 1)];
  const telemetry = telemetryAt(times, 0b001);

  // boot default, outlet not wired yet — loggedAt irrelevant, short-circuits earlier
  assert.deepEqual(computeOutletMismatches(device, telemetry, logged(false, 0)), []);
});

test('resumes flagging right after the new-device grace period elapses', () => {
  const device = makeDevice();
  const graceMinutes = NEW_DEVICE_GRACE_MS / 60_000;
  const times = [minutesAfterFirstSeen(graceMinutes + 10), minutesAfterFirstSeen(graceMinutes + 9)];
  const telemetry = telemetryAt(times, 0b001);

  const mismatches = computeOutletMismatches(device, telemetry, logged(false, 0));

  assert.deepEqual(mismatches, [{ outletIndex: 0, role: 'Heater', loggedState: false, actualState: true }]);
});

test('suppresses a mismatch within OUTLET_ACTUATION_GRACE_MS of the logged transition', () => {
  const device = makeDevice();
  // hs-2ac964, 2026-07-20: the OFF command logged at 23:00:28 didn't show up
  // in telemetry until 23:00:58 — the 2 samples taken before that landed
  // inside this window and would otherwise have been flagged even though
  // the outlet caught up on its own one sample later.
  const latestSampleSeconds = 120 * 60;
  const times = [secondsAfterFirstSeen(latestSampleSeconds), secondsAfterFirstSeen(latestSampleSeconds - 60)];
  const telemetry = telemetryAt(times, 0b001);
  const loggedAtSeconds = latestSampleSeconds - OUTLET_ACTUATION_GRACE_MS / 1000 + 30; // 30s inside the grace window

  assert.deepEqual(computeOutletMismatches(device, telemetry, logged(false, loggedAtSeconds)), []);
});

test('resumes flagging once OUTLET_ACTUATION_GRACE_MS has elapsed since the logged transition', () => {
  const device = makeDevice();
  const latestSampleSeconds = 120 * 60;
  const times = [secondsAfterFirstSeen(latestSampleSeconds), secondsAfterFirstSeen(latestSampleSeconds - 60)];
  const telemetry = telemetryAt(times, 0b001);
  const loggedAtSeconds = latestSampleSeconds - OUTLET_ACTUATION_GRACE_MS / 1000 - 30; // 30s past the grace window

  const mismatches = computeOutletMismatches(device, telemetry, logged(false, loggedAtSeconds));

  assert.deepEqual(mismatches, [{ outletIndex: 0, role: 'Heater', loggedState: false, actualState: true }]);
});

test('never flags an outlet with no logged transition at all, grace periods aside', () => {
  const device = makeDevice();
  const times = [minutesAfterFirstSeen(9999), minutesAfterFirstSeen(9998)];
  const telemetry = telemetryAt(times, 0b001);

  assert.deepEqual(computeOutletMismatches(device, telemetry, new Map()), []);
});

test('requires at least OUTLET_MISMATCH_DEBOUNCE_SAMPLES telemetry rows', () => {
  const device = makeDevice();
  const times = [minutesAfterFirstSeen(9999)];
  assert.equal(times.length < OUTLET_MISMATCH_DEBOUNCE_SAMPLES, true);
  const telemetry = telemetryAt(times, 0b001);

  assert.deepEqual(computeOutletMismatches(device, telemetry, logged(false, 0)), []);
});

// Recreation of the actual hs-2ac964 investigation (2026-07-20), using the
// real device shape, timestamps, and outlet_mask values pulled via SQL —
// not synthetic numbers — to confirm the fix resolves the exact case that
// prompted it, not just an abstract approximation of it.
test('recreates the hs-2ac964 Day Light false positive and no longer flags it', () => {
  const hs2ac964 = makeDevice({
    device_id: 'hs-2ac964',
    outlet_roles: ['Heater', 'Mister', 'Fan', 'Day Light', 'UVB Light', 'Plug 6'],
    first_seen: '2026-07-18T20:23:02.284251Z',
  });

  // The 2 most recent telemetry samples as of 23:00:31 (when fleet health
  // actually ran) — both still mask=12 (0b001100: Fan + Day Light on),
  // i.e. taken *before* the Kasa plug physically responded at 23:00:58.
  const telemetryAtDetectionTime: TelemetryRow[] = [
    { id: 101, device_id: 'hs-2ac964', created_at: '2026-07-20T22:59:58.843818Z', temp_c: 24, hum: 38, outlet_mask: 12, free_heap: 90000, rssi: -55 },
    { id: 100, device_id: 'hs-2ac964', created_at: '2026-07-20T22:58:38.227457Z', temp_c: 24, hum: 38, outlet_mask: 12, free_heap: 90000, rssi: -55 },
  ];

  // The real logged transition: "Day Light [3] turned OFF — scheduled
  // night window", logged 23:00:28.873469 — 3s before the debounce window
  // above was evaluated, ~30s before telemetry actually confirmed it.
  const lastLoggedByOutlet = new Map([
    [3, { outletState: false, loggedAt: '2026-07-20T23:00:28.873469Z' }],
  ]);

  assert.deepEqual(computeOutletMismatches(hs2ac964, telemetryAtDetectionTime, lastLoggedByOutlet), []);
});

// Companion check: the same device/outlet genuinely stuck (mask never
// catches up even once OUTLET_ACTUATION_GRACE_MS has passed) still gets
// flagged — the fix suppresses the ~30s command round-trip, not real bugs.
test('still flags Day Light on hs-2ac964 if the mismatch had actually persisted', () => {
  const hs2ac964 = makeDevice({
    device_id: 'hs-2ac964',
    outlet_roles: ['Heater', 'Mister', 'Fan', 'Day Light', 'UVB Light', 'Plug 6'],
    first_seen: '2026-07-18T20:23:02.284251Z',
  });

  // Same mask=12 (Day Light still on) but sampled well after the logged
  // OFF's actuation grace period has elapsed — a genuinely stuck outlet.
  const telemetryMuchLater: TelemetryRow[] = [
    { id: 201, device_id: 'hs-2ac964', created_at: '2026-07-20T23:15:00.000000Z', temp_c: 24, hum: 38, outlet_mask: 12, free_heap: 90000, rssi: -55 },
    { id: 200, device_id: 'hs-2ac964', created_at: '2026-07-20T23:14:00.000000Z', temp_c: 24, hum: 38, outlet_mask: 12, free_heap: 90000, rssi: -55 },
  ];

  const lastLoggedByOutlet = new Map([
    [3, { outletState: false, loggedAt: '2026-07-20T23:00:28.873469Z' }],
  ]);

  const mismatches = computeOutletMismatches(hs2ac964, telemetryMuchLater, lastLoggedByOutlet);

  assert.deepEqual(mismatches, [{ outletIndex: 3, role: 'Day Light', loggedState: false, actualState: true }]);
});
