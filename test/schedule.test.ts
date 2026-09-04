// Pins src/lib/schedule.ts's feature-detection forks — the ones the firmware
// handoffs keep insisting must never become version comparisons:
//
//   - whether a snapshot has the lighting `*_ranges` arrays at all (0.26.0+)
//     vs. the pre-multi-window scalar pairs,
//   - per mister window, whether it is 0.29.0+'s start-plus-duration or a
//     0.28.0 on/off pair (docs/automation-rules.md §4a-i), and
//   - whether a snapshot carries `mister_ranges` (0.28.0+) or `fan_ranges`
//     (0.33.0+) at all, each of which reads as [] when absent.
//
// Every shape here is permanently live, because historized tag='config' rows
// keep whatever shape they were written under — so these are not
// transitional cases that eventually get deleted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fanWindows, isMisterDurationWindow, lightWindows, misterWindows } from '../src/lib/schedule';
import type { MisterWindow, ProfileConfig } from '../src/lib/types';

// Only the fields these functions read; the rest of ProfileConfig is
// irrelevant here and a full fixture would just obscure which key matters.
function config(overrides: Partial<ProfileConfig>): ProfileConfig {
  return {
    profile: 'Test',
    enabled: true,
    hum_low: 50,
    hum_high: 70,
    day_light_on: '00:00',
    day_light_off: '00:00',
    uvb_on: '00:00',
    uvb_off: '00:00',
    timezone: 'UTC0',
    ota_url: '',
    ...overrides,
  };
}

test('lightWindows returns every window, whatever the array length', () => {
  // The per-light caps are not uniform and have already moved once (§6a:
  // 0.32.0 took day light to 2 and UVB to 1). Nothing may assume three.
  const one = [{ on: '07:00', off: '19:00' }];
  const five = [
    { on: '01:00', off: '02:00' },
    { on: '03:00', off: '04:00' },
    { on: '05:00', off: '06:00' },
    { on: '07:00', off: '08:00' },
    { on: '09:00', off: '10:00' },
  ];

  assert.deepEqual(lightWindows(config({ uvb_ranges: one }), 'uvb'), one);
  assert.deepEqual(lightWindows(config({ basking_ranges: five }), 'basking'), five);
});

test('lightWindows distinguishes "no such role" from "nothing scheduled"', () => {
  // null means the snapshot says nothing about the role at all; [] is a real
  // answer meaning never on. Conflating them renders a definite claim about
  // a device that predates the role.
  assert.equal(lightWindows(config({}), 'basking'), null);
  assert.deepEqual(lightWindows(config({ basking_ranges: [] }), 'basking'), []);
  assert.deepEqual(lightWindows(config({ basking_on: '09:00', basking_off: '09:00' }), 'basking'), []);
});

test('lightWindows prefers the array over the first-window scalars', () => {
  // §6's trap: the scalars still ship on 0.26.0+ but carry only ranges[0],
  // so reading them silently drops every later window.
  const ranges = [
    { on: '08:00', off: '11:00' },
    { on: '15:00', off: '18:00' },
  ];
  const snapshot = config({ uvb_on: '08:00', uvb_off: '11:00', uvb_ranges: ranges });
  assert.deepEqual(lightWindows(snapshot, 'uvb'), ranges);
});

test('misterWindows reads an absent key as [], not as unknown', () => {
  // §4a: a pre-0.28.0 device has no key, and the humidistat-only formula is
  // exactly right there — so [] rather than null, which is reserved for "no
  // config at all".
  assert.equal(misterWindows(null), null);
  assert.deepEqual(misterWindows(config({})), []);
  assert.deepEqual(misterWindows(config({ mister_ranges: [] })), []);
});

test('misterWindows passes both wire shapes through unnormalized', () => {
  // Deliberately not normalized to one shape: which form a snapshot used is
  // a real fact about that snapshot, and the 0.28.0 pair cannot be rewritten
  // as a duration without lying (the upgrade caps migrated spans at 300s).
  const mixed: MisterWindow[] = [
    { on: '07:30', off: '07:45' },
    { on: '21:00', duration_s: 15 },
  ];
  assert.deepEqual(misterWindows(config({ mister_ranges: mixed })), mixed);
});

test('isMisterDurationWindow forks on duration_s, not on the release', () => {
  assert.equal(isMisterDurationWindow({ on: '07:30', duration_s: 15 }), true);
  assert.equal(isMisterDurationWindow({ on: '07:30', off: '07:45' }), false);

  // The shortest and longest legal spikes (5s and 300s, always a multiple of
  // 5) both read as durations — 5 in particular must not be mistaken for a
  // falsy-ish absent key.
  assert.equal(isMisterDurationWindow({ on: '00:00', duration_s: 5 }), true);
  assert.equal(isMisterDurationWindow({ on: '00:00', duration_s: 300 }), true);
});

test('fanWindows reads an absent key as [], not as unknown', () => {
  // §5b, and the same call as the mister's: a pre-0.33.0 device has no key,
  // and the three-term fan formula is exactly right there. [] rather than
  // null, which stays reserved for "no config at all".
  //
  // This is the ordinary case rather than a legacy one — 0.33.0 ships the
  // array empty until a keeper fills in the Fan Schedule card — and it is
  // also the case §11's anomaly gate turns on, so it is worth pinning
  // separately from the populated shape below.
  assert.equal(fanWindows(null), null);
  assert.deepEqual(fanWindows(config({})), []);
  assert.deepEqual(fanWindows(config({ fan_ranges: [] })), []);
});

test('fanWindows returns every window, whatever the array length', () => {
  // Cap is three today (§6a) and nothing may encode that, exactly as with
  // the lights. Midnight wrap is expressed the same way too — an `off`
  // earlier than its `on` — and passes through untouched rather than being
  // split or reordered.
  const wrapping = [
    { on: '06:00', off: '07:00' },
    { on: '22:00', off: '23:30' },
    { on: '23:45', off: '00:15' },
  ];
  assert.deepEqual(fanWindows(config({ fan_ranges: wrapping })), wrapping);
  assert.deepEqual(fanWindows(config({ fan_ranges: [{ on: '06:00', off: '07:00' }] })), [
    { on: '06:00', off: '07:00' },
  ]);
});

test('a fan window carries no fan assist flag', () => {
  // §5b: the fan cannot assist itself, so firmware never writes the key
  // here. `w.fan` is a compile error on FanWindow — the whole point, since a
  // generic fold of `r.fan AND in_window(r)` over every *_ranges array would
  // otherwise read undefined and silently drop the §5b term.
  //
  // The type is the real guard; this asserts the runtime half, that nothing
  // in the reader invents the key on the way through.
  const [window] = fanWindows(config({ fan_ranges: [{ on: '06:00', off: '07:00' }] })) ?? [];
  assert.equal('fan' in window, false);
});
