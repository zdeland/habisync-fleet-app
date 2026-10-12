// Synthetic probe cap test sessions for test/probeTest.test.ts, with known
// biases and cap effects per probe. Shared so the same rows can be fed to
// the firmware repo's scripts/probe_test_report.py to check the two agree.
import type { LogRow, TelemetryRow } from '../../src/lib/types';

export const T0 = Date.parse('2026-10-11T22:14:00Z');
export const at = (min: number) => new Date(T0 + min * 60_000).toISOString();

export function log(min: number, tag: 'probetest' | 'reference', message: string, temp_c: number | null = null): LogRow {
  return {
    id: min * 10,
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

export const BIAS = [0.3, -0.1, -0.2]; // °C, per port
export const EFFECT = [0.5, 0.8, 0.2]; // °C a cap adds, per port
export const HUM_EFFECT = [-2, -3, -1];

// 4 phases x 60 min: baseline, then the one cap on port 0, 1, 2. The room
// drifts, which the per-minute group mean must cancel. No noise or
// rounding, so a correct fit recovers EFFECT exactly.
export function session(): TelemetryRow[] {
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

// A session built to be awkward: unequal cap effects, a final all-capped
// phase, a drifting room, readings rounded to 0.1 °C with a little ripple, a
// probe dropping out, a backlog uploaded under one created_at, an abandoned
// start before it, reference rounds, and Done pressed after time ran out.
export function awkwardSession(): { telemetry: TelemetryRow[]; logs: LogRow[] } {
  const iso = (ms: number) => new Date(ms).toISOString();
  const telemetry: TelemetryRow[] = [];
  const logs: LogRow[] = [];
  let id = 0;
  const addLog = (ms: number, tag: 'probetest' | 'reference', message: string, temp_c: number | null = null, hum: number | null = null) =>
    logs.push({ ...log(0, tag, message, temp_c), id: ++id, hum, device_time: iso(ms), created_at: iso(ms + 900) });
  addLog(T0 - 600_000, 'probetest', 'start s=1 dur_min=240 ports=0,1,2 all=1');
  addLog(T0 - 540_000, 'probetest', 'stop s=1');
  addLog(T0, 'probetest', 'start s=2 dur_min=300 ports=0,1,2 all=1');
  // 30 min past the scheduled end, with the caps still on: outside the test.
  for (let min = 0; min < 330; min++) {
    const phase = Math.min(4, Math.floor(min / 60));
    const t = T0 + min * 60_000 + 8_000;
    const room = 24 + Math.sin(min / 25) + min * 0.002;
    const rh = 60 + Math.cos(min / 40) * 3;
    if (min % 60 === 0 && phase > 0 && min < 300) {
      addLog(t, 'probetest', `caps s=2 phase=${phase} capped=${phase === 4 ? '0,1,2' : phase - 1}`);
    }
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
        temp_c: Math.round((room + BIAS[port] + (capped ? EFFECT[port] : 0) + Math.sin(min * 7 + port) * 0.05) * 10) / 10,
        hum: Math.round((rh + (capped ? HUM_EFFECT[port] : 0)) * 10) / 10,
        outlet_mask: null,
        free_heap: 0,
        rssi: -50,
      });
    }
    if (min % 60 === 30 && min < 300) {
      for (let port = 0; port < 3; port++) {
        const capped = phase === 4 || (phase > 0 && phase - 1 === port);
        addLog(
          t + 20_000,
          'reference',
          `s=2 ph=${phase} kind=probe port=${port} cap=${capped ? 'capped' : 'uncapped'} ir_c=${(room - 0.6 + port * 0.1).toFixed(2)}`,
          room + BIAS[port],
          rh,
        );
      }
      addLog(t + 20_000, 'reference', `s=2 ph=${phase} kind=target ir_c=${(room - 0.4).toFixed(2)}`);
      addLog(t + 20_000, 'reference', `s=2 ph=${phase} kind=room temp_c=${(room + 1).toFixed(2)}${phase % 2 ? ` hum=${(rh - 4).toFixed(0)}` : ''}`);
    }
  }
  addLog(T0 + 330 * 60_000 + 30_000, 'probetest', 'end s=2');
  return { telemetry, logs };
}
