import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeOutletMismatches, NEW_DEVICE_GRACE_MS, OUTLET_MISMATCH_DEBOUNCE_SAMPLES } from '../src/lib/queries';
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

function minutesAfterFirstSeen(minutes: number): string {
  return new Date(new Date(FIRST_SEEN).getTime() + minutes * 60_000).toISOString();
}

test('flags a real, well-established mismatch outside the grace period', () => {
  const device = makeDevice();
  // Heater (index 0) logged OFF, but telemetry has shown it ON for the
  // whole debounce window, long after the device's first-ever telemetry.
  const times = [minutesAfterFirstSeen(120), minutesAfterFirstSeen(119)];
  const telemetry = telemetryAt(times, 0b001);
  const loggedState = new Map([[0, false]]);

  const mismatches = computeOutletMismatches(device, telemetry, loggedState);

  assert.deepEqual(mismatches, [{ outletIndex: 0, role: 'Heater', loggedState: false, actualState: true }]);
});

test('suppresses a mismatch within NEW_DEVICE_GRACE_MS of first_seen', () => {
  const device = makeDevice();
  const withinGraceMinutes = NEW_DEVICE_GRACE_MS / 60_000 - 1;
  const times = [minutesAfterFirstSeen(withinGraceMinutes), minutesAfterFirstSeen(withinGraceMinutes - 1)];
  const telemetry = telemetryAt(times, 0b001);
  const loggedState = new Map([[0, false]]); // boot default, outlet not wired yet

  assert.deepEqual(computeOutletMismatches(device, telemetry, loggedState), []);
});

test('resumes flagging right after the grace period elapses', () => {
  const device = makeDevice();
  const graceMinutes = NEW_DEVICE_GRACE_MS / 60_000;
  const times = [minutesAfterFirstSeen(graceMinutes + 1), minutesAfterFirstSeen(graceMinutes)];
  const telemetry = telemetryAt(times, 0b001);
  const loggedState = new Map([[0, false]]);

  const mismatches = computeOutletMismatches(device, telemetry, loggedState);

  assert.deepEqual(mismatches, [{ outletIndex: 0, role: 'Heater', loggedState: false, actualState: true }]);
});

test('never flags an outlet with no logged transition at all, grace period aside', () => {
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

  assert.deepEqual(computeOutletMismatches(device, telemetry, new Map([[0, false]])), []);
});
