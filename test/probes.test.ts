// HabiSync 1.0's per-probe telemetry — src/lib/probes.ts. Row and config
// shapes are copied from real hs-f0a798 / hs-f0a74c rows (2026-10-11).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyBand,
  isMonitorOnly,
  latestPerSeries,
  sampleTime,
  seriesLabel,
  splitByPort,
  tankForSeries,
  tanksOf,
} from '../src/lib/probes';
import { computeOutletMismatches } from '../src/lib/queries';
import type { Device, ProfileConfig, TelemetryRow } from '../src/lib/types';

function row(id: number, port: number | null, created_at: string, device_time: string | null, temp_c = 24, hum = 60): TelemetryRow {
  return {
    id,
    device_id: 'hs-f0a798',
    created_at,
    device_time,
    port,
    probe_cap: port == null ? null : 'uncapped',
    temp_c,
    hum,
    outlet_mask: null,
    free_heap: 255352,
    rssi: -56,
  };
}

const CONFIG = {
  tanks: [
    { port: 3, name: 'Tank 4', profile: 'Crested Gecko', temp_low_c: 21, temp_high_c: 27, hum_low: 50, hum_high: 70 },
    { port: 0, name: 'Tanky', profile: 'Bearded Dragon', temp_low_c: 24, temp_high_c: 32, hum_low: 30, hum_high: 40 },
  ],
  profile: 'Bearded Dragon',
  temp_low_c: 24,
  temp_high_c: 32,
  hum_low: 30,
  hum_high: 40,
  board: 'habisync-1_0',
} as unknown as ProfileConfig;

test('tells the lines apart by board or by major version', () => {
  assert.equal(isMonitorOnly({ fw_version: '1.2.0', profile_config: CONFIG }), true);
  assert.equal(isMonitorOnly({ fw_version: '1.0.0', profile_config: {} as ProfileConfig }), true);
  assert.equal(isMonitorOnly({ fw_version: '0.99.0', profile_config: { board: 'habisync-1_0' } as ProfileConfig }), true);
  assert.equal(isMonitorOnly({ fw_version: '0.35.0', profile_config: { board: 'esp32s3' } as ProfileConfig }), false);
});

test('splits a batch into one series per port, ordered by sample time', () => {
  // A backlog after an outage: every row lands with one created_at; only
  // device_time keeps them apart.
  const landed = '2026-10-11T22:51:10.184098+00:00';
  const rows = [
    row(5, 1, landed, '2026-10-11T22:51:08+00:00'),
    row(4, 0, landed, '2026-10-11T22:51:08+00:00'),
    row(3, 1, landed, '2026-10-11T22:50:08+00:00'),
    row(2, 0, landed, '2026-10-11T22:50:08+00:00'),
    row(1, null, '2026-10-11T20:00:00+00:00', null),
  ];
  const series = splitByPort(rows);
  assert.deepEqual(Array.from(series.keys()), [null, 0, 1]);
  assert.deepEqual(series.get(0)!.map((r) => r.id), [2, 4]);
  assert.deepEqual(series.get(1)!.map((r) => r.id), [3, 5]);
  assert.equal(latestPerSeries(rows).get(1)!.id, 5);
  assert.equal(sampleTime(rows[4]), '2026-10-11T20:00:00+00:00', 'falls back to created_at with no device clock');
});

test('matches each port to its tank, and a port-less row to the first tank', () => {
  assert.deepEqual(tanksOf(CONFIG).map((t) => t.port), [0, 3]);
  assert.equal(tankForSeries(CONFIG, 3)!.name, 'Tank 4');
  assert.equal(tankForSeries(CONFIG, null)!.name, 'Tanky');
  assert.equal(tankForSeries(CONFIG, 1), null, 'port 1 is a hidden tank');
  assert.equal(seriesLabel(CONFIG, 1), 'Port 2 (hidden tank)');
});

test('a 1.0.0 config with no tanks[] still has its one tank', () => {
  const legacy = { profile: 'Ball Python', temp_low_c: 25, temp_high_c: 31, hum_low: 50, hum_high: 60 } as ProfileConfig;
  assert.deepEqual(tanksOf(legacy).map((t) => [t.port, t.temp_low_c]), [[0, 25]]);
});

test('bands are [low, high)', () => {
  assert.equal(classifyBand(23.9, 24, 32), 'low');
  assert.equal(classifyBand(24, 24, 32), 'in');
  assert.equal(classifyBand(31.9, 24, 32), 'in');
  assert.equal(classifyBand(32, 24, 32), 'high');
});

test('the devkit outlet rules never run on a 1.x unit', () => {
  const device = {
    device_id: 'hs-f0a798',
    name: 'HabiSync',
    fw_version: '1.3.0',
    ip: '',
    rssi: -56,
    free_heap: 0,
    uptime_ms: 3_600_000,
    active_backend: null,
    reset_reason: 'power-on',
    outlet_roles: null,
    profile_config: CONFIG,
    first_seen: '2026-10-01T00:00:00Z',
    last_seen: '2026-10-11T22:51:10Z',
  } as Device;
  const telemetry = [row(2, 0, '2026-10-11T22:51:10Z', null), row(1, 0, '2026-10-11T22:50:10Z', null)];
  assert.deepEqual(computeOutletMismatches(device, telemetry, new Map([[0, { outletState: true, loggedAt: '2026-10-01T00:00:00Z' }]])), {
    mismatches: [],
    checkedOutletIndexes: [],
  });
});
