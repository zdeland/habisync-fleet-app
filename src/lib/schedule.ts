import type { LightWindow, MisterDurationWindow, MisterWindow, ProfileConfig } from '@/lib/types';

// Firmware 0.26.0 gave each light several independent daily windows
// (docs/automation-rules.md §6). The old scalar pairs still ship, but they
// carry only `*_ranges[0]` — so anything that reads day_light_on/uvb_on/
// basking_on directly silently loses every window after the first, and
// computes "should be off" straight through them. This module is the only
// place that should touch those fields; everything else calls lightWindows().
//
// How MANY windows is per-array and has already changed once (0.32.0 moved
// day light 3->2, UVB 3->1, mister 3->5; see §6). Nothing here is allowed to
// care: unused windows have always been omitted, so an array's length was
// never its cap, and callers OR across whatever arrives. Don't reintroduce a
// literal 3 anywhere downstream of this module.

// The three scheduled lights, and deliberately nothing else. `mister_ranges`
// (docs/automation-rules.md §4a) is NOT a LightRole: fan assist folds over
// exactly these three (§5a), and a mister window must never join that fold
// — on 0.28.0 it carries an always-false `fan` key, and 0.29.0 dropped the
// key outright. Nor is it the same shape any more (§4a's duration fork).
// Read those through misterWindows() below instead.
export type LightRole = 'day_light' | 'uvb' | 'basking';

const SCALARS: Record<LightRole, { on: keyof ProfileConfig; off: keyof ProfileConfig }> = {
  day_light: { on: 'day_light_on', off: 'day_light_off' },
  uvb: { on: 'uvb_on', off: 'uvb_off' },
  basking: { on: 'basking_on', off: 'basking_off' },
};

const RANGES: Record<LightRole, keyof ProfileConfig> = {
  day_light: 'day_light_ranges',
  uvb: 'uvb_ranges',
  basking: 'basking_ranges',
};

/**
 * The scheduled on/off windows for one light, as a list to be OR'd over.
 *
 * `[]` is a real answer meaning "never scheduled on" — distinct from `null`,
 * which means this snapshot says nothing about the role at all (no config,
 * or a pre-0.26.0 device that has never heard of Basking Spot).
 *
 * The returned windows are deliberately unnormalized: firmware neither sorts
 * nor merges them, so they may overlap and arrive in any order. Don't assume
 * a disjoint, ordered set.
 *
 * Each window also carries the `fan` assist flag. It drives the Fan outlet,
 * not this light's own, so it means nothing to a caller asking "is this
 * light on" — it's here because fan assist ORs across all three roles'
 * windows at once (docs/automation-rules.md §5a), which is exactly what
 * this function makes reachable.
 */
export function lightWindows(profileConfig: ProfileConfig | null, role: LightRole): LightWindow[] | null {
  if (!profileConfig) return null;

  // Feature-detect on key presence, not devices.fw_version. On a `devices`
  // row the two can't disagree (fw_version and profile_config ship in the
  // same heartbeat upsert), but historized tag='config' rows are append-only
  // and keep whatever shape they were written under — so a device upgraded
  // last Tuesday has old-shape rows before that point and new-shape rows
  // after, and version-gating a historical check against its *current*
  // version reads the wrong branch for half its own history.
  const ranges = profileConfig[RANGES[role]];
  if (Array.isArray(ranges)) return ranges as LightWindow[];

  const { on, off } = SCALARS[role];
  const onTime = profileConfig[on];
  const offTime = profileConfig[off];
  if (typeof onTime !== 'string' || typeof offTime !== 'string') return null;

  // Equal times mean "never on" under the in_window rule (§6), on either
  // shape. Collapsing to [] rather than passing the pair through keeps a
  // no-schedule light from rendering as a literal "00:00 – 00:00" window,
  // which is how 0.26.0 serializes an empty array back into the scalars.
  if (onTime === offTime) return [];

  return [{ on: onTime, off: offTime }];
}

/**
 * The scheduled mist windows to be OR'd over for §4a's `mist_window` term.
 *
 * `null` means this snapshot says nothing at all (no config). Everything
 * else is a list, `[]` included: an absent `mister_ranges` key is a
 * pre-0.28.0 device, and §4a specifies that as `[]` rather than "unknown"
 * — the humidistat-only formula is exactly right there, so no version gate
 * and no scalar fallback (none exists) are needed. That does make "firmware
 * predates the feature" and "the keeper scheduled no spikes" indistinguish-
 * able, which is fine for the decision logic and worth remembering before
 * rendering either as a definite statement about the device.
 *
 * Windows are unnormalized, exactly like the lighting ones — unsorted,
 * possibly overlapping, possibly wrapping past midnight.
 *
 * The returned windows are a UNION of two shapes and are deliberately not
 * normalized to one: run each through isMisterDurationWindow() before
 * reading its span. See MisterWindow in src/lib/types.ts.
 */
export function misterWindows(profileConfig: ProfileConfig | null): MisterWindow[] | null {
  if (!profileConfig) return null;

  // Key presence, not devices.fw_version — same reasoning as lightWindows().
  const ranges = profileConfig.mister_ranges;
  return Array.isArray(ranges) ? ranges : [];
}

/**
 * Which of the two `mister_ranges` shapes a window is (§4a).
 *
 * `duration_s` present means 0.29.0+'s start-plus-duration form; otherwise
 * it's a 0.28.0 `on`/`off` pair. That is the fork the firmware handoff
 * specifies, and it is deliberately key presence rather than a
 * `fw_version` comparison: BOTH shapes are live and neither ages out.
 * Historized tag='config' rows keep whatever shape they were written
 * under, so a device that has been through the 0.28.0 → 0.29.0 upgrade has
 * a permanent stripe of old-shape rows in its own history — version-gating
 * a historical check against its current version reads the wrong branch for
 * that stripe, exactly as in lightWindows().
 *
 * Spans differ by more than arithmetic. A 0.28.0 window is two
 * minute-resolution clock times, evaluated with §6's `in_window`. A 0.29.0
 * window is a start time plus a duration in SECONDS (5-300, always a
 * multiple of 5), so `open` is
 * `((now_local_seconds - to_seconds(on)) mod 86400) < duration_s` — which
 * needs a SECONDS-resolution local clock. Rounding it to the minute
 * resolution the rest of automation-rules.md uses computes a 5s spike as
 * either never on or a full minute on.
 *
 * Neither span is computed here: that needs the device's resolved local
 * time, the same thing blocking §6-8 (see src/lib/automation.ts). This
 * function exists so that when it lands, the fork is already made in one
 * place, and so the UI can render each shape as what it actually is.
 */
export function isMisterDurationWindow(window: MisterWindow): window is MisterDurationWindow {
  return 'duration_s' in window;
}
