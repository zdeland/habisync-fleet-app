import type { LightWindow, ProfileConfig } from '@/lib/types';

// Firmware 0.26.0 gave each light up to three independent daily windows
// (docs/automation-rules.md §6). The old scalar pairs still ship, but they
// carry only `*_ranges[0]` — so anything that reads day_light_on/uvb_on/
// basking_on directly silently loses every window after the first, and
// computes "should be off" straight through them. This module is the only
// place that should touch those fields; everything else calls lightWindows().

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
