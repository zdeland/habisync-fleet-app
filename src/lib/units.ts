import type { ProfileConfig } from '@/lib/types';

export function celsiusToFahrenheit(c: number): number {
  return c * (9 / 5) + 32;
}

export function fahrenheitToCelsius(f: number): number {
  return (f - 32) * (5 / 9);
}

// For converting a *span* (e.g. TEMP_HYSTERESIS_C, a delta not a point) —
// no +32 offset, since that only applies to absolute temperatures. Using
// celsiusToFahrenheit() on a hysteresis band by mistake would be off by 32°.
export function celsiusDeltaToFahrenheit(deltaC: number): number {
  return deltaC * (9 / 5);
}

// profile_config's temp target range can be under either key set — see the
// comment on ProfileConfig in src/lib/types.ts for why. This is the only
// place that should read temp_low_c/temp_high_c/temp_low_f/temp_high_f
// directly; everything else should call this instead.
export function tempRangeC(profileConfig: ProfileConfig | null): { low: number; high: number } | null {
  if (!profileConfig) return null;
  if (profileConfig.temp_low_c != null && profileConfig.temp_high_c != null) {
    return { low: profileConfig.temp_low_c, high: profileConfig.temp_high_c };
  }
  if (profileConfig.temp_low_f != null && profileConfig.temp_high_f != null) {
    return { low: fahrenheitToCelsius(profileConfig.temp_low_f), high: fahrenheitToCelsius(profileConfig.temp_high_f) };
  }
  return null;
}
