import type { LightWindow, MisterWindow, ProfileConfig } from '@/lib/types';

// Firmware 0.26.0 gave each light up to three independent daily windows
// (docs/automation-rules.md §6). The old scalar pairs still ship, but they
// carry only `*_ranges[0]` — so anything that reads day_light_on/uvb_on/
// basking_on directly silently loses every window after the first, and
// computes "should be off" straight through them. This module is the only
// place that should touch those fields; everything else calls lightWindows().

// The three scheduled lights, and deliberately nothing else. `mister_ranges`
// (docs/automation-rules.md §4a) is the same window shape but is NOT a
// LightRole: fan assist folds over exactly these three (§5a), and mister
// windows carry an always-false `fan` key that must not join that fold.
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
 * The returned windows deliberately have no `fan` field even though one is
 * on the wire: see MisterWindow in src/lib/types.ts.
 */
export function misterWindows(profileConfig: ProfileConfig | null): MisterWindow[] | null {
  if (!profileConfig) return null;

  // Key presence, not devices.fw_version — same reasoning as lightWindows().
  const ranges = profileConfig.mister_ranges;
  return Array.isArray(ranges) ? ranges : [];
}
