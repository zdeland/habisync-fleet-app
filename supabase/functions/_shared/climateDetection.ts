// Pure, dependency-free "has this metric been out of range for N minutes"
// detector for the favorite-device climate-alert email feature — see
// docs/climate-alerts.md.
//
// This file is imported from TWO different runtimes with no shared build
// step between them:
//   - supabase/functions/climate-alerts/index.ts (Deno, via a relative
//     import — Supabase Edge Functions can import from a `_shared/`
//     directory outside their own function folder)
//   - test/climateDetection.test.ts (Node, via this repo's existing
//     `tsx --test` runner — see test/automation.test.ts)
// Keep it free of any Deno-only (`Deno.*`) or Node-only (`node:*`) API so it
// can be imported unmodified by both. Deno requires explicit file
// extensions on relative imports; tsx tolerates them too, so this file is
// always imported as `climateDetection.ts` (or `.js` after Deno's own
// resolution), never bare.

export type TelemetrySample = { createdAtMs: number; value: number };

export type SustainedConditionResult = {
  isViolatingNow: boolean; // latest sample alone, regardless of streak length
  isSustainedViolation: boolean; // streak covers >= sustainedForMs, ending at latest sample
  violatingSinceMs: number | null; // start of the contiguous streak, if isViolatingNow
  latestValue: number | null;
  latestAtMs: number | null;
};

export const SUSTAINED_OUT_OF_RANGE_MS = 3 * 60_000;

// A bit past the documented 5-minute connectivity-failure flush backoff
// (docs/cloudlog-dataflow.md: telemetry normally flushes every ~30-60s, but
// backs off to every 5 min on a network hiccup) — wide enough to tolerate
// normal backoff without treating it as broken evidence, tight enough that
// a genuine multi-sample-wide gap doesn't get bridged into a false
// "sustained" streak.
export const MAX_SAMPLE_GAP_MS = 6 * 60_000;

// samplesNewestFirst: newest-first samples for ONE metric on ONE device
// (e.g. { createdAtMs, value: temp_c } or { createdAtMs, value: hum }).
// isViolating: the condition being watched for — deliberately a predicate
// rather than hardcoded low/high thresholds, so a future non-range alert
// type (see docs/climate-alerts.md's Extensibility section — e.g. a boolean
// flag like "device offline") can reuse this exact walk-backward/gap engine
// with a different one-line predicate, no changes needed here.
// sustainedForMs: e.g. SUSTAINED_OUT_OF_RANGE_MS.
// maxGapMs: e.g. MAX_SAMPLE_GAP_MS — a gap between two *consecutive* samples
// wider than this breaks the streak: a real disconnect isn't "sustained out
// of range," it's unknown.
export function detectSustainedCondition(
  samplesNewestFirst: TelemetrySample[],
  isViolating: (value: number) => boolean,
  sustainedForMs: number,
  maxGapMs: number,
): SustainedConditionResult {
  if (samplesNewestFirst.length === 0) {
    return { isViolatingNow: false, isSustainedViolation: false, violatingSinceMs: null, latestValue: null, latestAtMs: null };
  }

  const latest = samplesNewestFirst[0];
  const isViolatingNow = isViolating(latest.value);

  if (!isViolatingNow) {
    return {
      isViolatingNow: false,
      isSustainedViolation: false,
      violatingSinceMs: null,
      latestValue: latest.value,
      latestAtMs: latest.createdAtMs,
    };
  }

  // Walk backward while every sample stays violating AND consecutive
  // samples aren't spaced further apart than maxGapMs (a real disconnect
  // breaks the streak rather than letting two far-apart readings count as
  // one continuous episode).
  let streakStartMs = latest.createdAtMs;
  for (let i = 0; i < samplesNewestFirst.length - 1; i++) {
    const current = samplesNewestFirst[i];
    const older = samplesNewestFirst[i + 1];
    if (!isViolating(older.value)) break;
    if (current.createdAtMs - older.createdAtMs > maxGapMs) break;
    streakStartMs = older.createdAtMs;
  }

  const durationMs = latest.createdAtMs - streakStartMs;
  return {
    isViolatingNow: true,
    isSustainedViolation: durationMs >= sustainedForMs,
    violatingSinceMs: streakStartMs,
    latestValue: latest.value,
    latestAtMs: latest.createdAtMs,
  };
}

// Convenience predicate for today's two metrics (temp/humidity range
// checks) — the only shape of condition this feature ships with initially.
export function outOfRange(low: number, high: number): (value: number) => boolean {
  return (value) => value < low || value > high;
}
