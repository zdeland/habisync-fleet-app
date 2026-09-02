// docs/automation-rules.md §11 requires manual-test rows to be excluded from
// every anomaly check, and there are two prefixes for that, from two
// different dashboard buttons, sharing no naming convention. The second one
// arrived in firmware 0.32.0 and a startsWith('test:') check missed it
// entirely — these pin both.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isTestReason, reasonOnly } from '../src/lib/logReasons';

test('reasonOnly keeps the reason after the first dash', () => {
  assert.equal(reasonOnly('Heater [1] turned ON — temperature below target range'), 'temperature below target range');
  // Em-dash and hyphen both, since firmware has used both over time.
  assert.equal(reasonOnly('Fan [3] turned OFF - within range'), 'within range');
  // A message with no dash at all is its own reason, not an empty string.
  assert.equal(reasonOnly('device rebooted'), 'device rebooted');
  // The reason itself can contain further dashes — take the first split only.
  assert.equal(
    reasonOnly('Mister [2] turned OFF — scheduled mist window held off — enclosure too humid'),
    'scheduled mist window held off — enclosure too humid',
  );
});

test('isTestReason catches the /climate-test prefix', () => {
  assert.equal(isTestReason('Heater [1] turned ON — test: temperature below target range'), true);
});

test('isTestReason catches the manual mister check, which has no colon', () => {
  // Firmware 0.32.0. Both edges must be caught: an anomaly check that saw
  // only the opening row would read the spike as never having ended.
  assert.equal(isTestReason('Mister [2] turned ON — test pulse — manual mister check'), true);
  assert.equal(isTestReason('Mister [2] turned OFF — test pulse complete'), true);
});

test('isTestReason leaves real automation reasons alone', () => {
  // Including 0.32.0's rewritten lighting text, which replaced
  // "scheduled day window"/"scheduled night window".
  assert.equal(isTestReason('Basking Spot [5] turned ON — inside its scheduled window'), false);
  assert.equal(isTestReason('Basking Spot [5] turned OFF — outside its scheduled window'), false);
  assert.equal(isTestReason('Mister [2] turned ON — scheduled mist window'), false);
  assert.equal(isTestReason('UVB Light [4] turned OFF — forced off — enclosure too hot'), false);
  assert.equal(isTestReason('Heater [1] turned ON — temperature below target range'), false);
});
