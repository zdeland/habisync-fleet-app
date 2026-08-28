// Unit tests for the shared sustained-out-of-range detector backing the
// favorite-device climate-alert emails (docs/climate-alerts.md). This file
// imports supabase/functions/_shared/climateDetection.ts directly — that
// file is also imported, unmodified, by the Deno Edge Function at
// supabase/functions/climate-alerts/index.ts. Keep it free of Deno/Node-only
// APIs so both imports keep working; see the doc comment at the top of that
// file for why.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectSustainedCondition,
  outOfRange,
  SUSTAINED_OUT_OF_RANGE_MS,
  MAX_SAMPLE_GAP_MS,
  type TelemetrySample,
} from '../supabase/functions/_shared/climateDetection';

const LOW = 70;
const HIGH = 82;
const isOutOfRange = outOfRange(LOW, HIGH);

// Newest-first, one sample per minute unless noted — matches how the Edge
// Function queries telemetry (`order by created_at desc`).
function samplesAgo(valuesNewestFirst: number[], stepMs = 60_000, nowMs = 10_000_000): TelemetrySample[] {
  return valuesNewestFirst.map((value, i) => ({ createdAtMs: nowMs - i * stepMs, value }));
}

test('in-range latest sample is never violating, regardless of history', () => {
  const samples = samplesAgo([75, 90, 90, 90]); // clean now, was out of range before
  const result = detectSustainedCondition(samples, isOutOfRange, SUSTAINED_OUT_OF_RANGE_MS, MAX_SAMPLE_GAP_MS);
  assert.equal(result.isViolatingNow, false);
  assert.equal(result.isSustainedViolation, false);
  assert.equal(result.violatingSinceMs, null);
});

test('out of range but under the 3-minute threshold is not sustained', () => {
  // 0, -1, -2 min: out of range for 2 minutes only.
  const samples = samplesAgo([90, 90, 90, 72]);
  const result = detectSustainedCondition(samples, isOutOfRange, SUSTAINED_OUT_OF_RANGE_MS, MAX_SAMPLE_GAP_MS);
  assert.equal(result.isViolatingNow, true);
  assert.equal(result.isSustainedViolation, false);
});

test('out of range for exactly 3 minutes counts as sustained (boundary is inclusive)', () => {
  const samples = samplesAgo([90, 90, 90, 90]); // now, -1, -2, -3 min — 3-minute span
  const result = detectSustainedCondition(samples, isOutOfRange, SUSTAINED_OUT_OF_RANGE_MS, MAX_SAMPLE_GAP_MS);
  assert.equal(result.isViolatingNow, true);
  assert.equal(result.isSustainedViolation, true);
  assert.equal(result.violatingSinceMs, 10_000_000 - 3 * 60_000);
});

test('out of range well past 3 minutes is sustained', () => {
  const samples = samplesAgo([95, 91, 90, 88, 85, 84]); // 5-minute span
  const result = detectSustainedCondition(samples, isOutOfRange, SUSTAINED_OUT_OF_RANGE_MS, MAX_SAMPLE_GAP_MS);
  assert.equal(result.isViolatingNow, true);
  assert.equal(result.isSustainedViolation, true);
});

test('a gap wider than MAX_SAMPLE_GAP_MS breaks the streak instead of bridging it', () => {
  // Latest two samples (now, -1 min) are out of range — only a 1-minute
  // streak on their own. An earlier out-of-range run 8 minutes back must
  // NOT be stitched on across that gap into a false 8-minute streak.
  const samples: TelemetrySample[] = [
    { createdAtMs: 10_000_000, value: 90 },
    { createdAtMs: 10_000_000 - 60_000, value: 88 },
    { createdAtMs: 10_000_000 - 8 * 60_000, value: 91 },
    { createdAtMs: 10_000_000 - 9 * 60_000, value: 92 },
  ];
  const result = detectSustainedCondition(samples, isOutOfRange, SUSTAINED_OUT_OF_RANGE_MS, MAX_SAMPLE_GAP_MS);
  assert.equal(result.isViolatingNow, true);
  assert.equal(result.isSustainedViolation, false);
  assert.equal(result.violatingSinceMs, 10_000_000 - 60_000);
});

test('back in range after a prior sustained streak reports not-violating-now', () => {
  const samples = samplesAgo([76, 90, 90, 90, 90]); // clean now, was sustained-out-of-range before
  const result = detectSustainedCondition(samples, isOutOfRange, SUSTAINED_OUT_OF_RANGE_MS, MAX_SAMPLE_GAP_MS);
  assert.equal(result.isViolatingNow, false);
  assert.equal(result.isSustainedViolation, false);
  assert.equal(result.latestValue, 76);
});

test('no samples at all is not violating', () => {
  const result = detectSustainedCondition([], isOutOfRange, SUSTAINED_OUT_OF_RANGE_MS, MAX_SAMPLE_GAP_MS);
  assert.equal(result.isViolatingNow, false);
  assert.equal(result.isSustainedViolation, false);
  assert.equal(result.latestAtMs, null);
});
