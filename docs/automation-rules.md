# Climate & Lighting Automation Rules — Validator Reference

Exact decision logic behind every automated outlet change, extracted from
`ClimateController::evaluate()` (firmware repo's `src/Reptile.cpp`) and
`runClimateControl()`/`runDayNightSchedule()` (`src/main.cpp`). Intended for
the [fleet monitoring webapp](monitoring-webapp-plan.md) to independently
recompute "what should this device's outlets be doing right now" from raw
`telemetry`/`profile_config` data, and flag a divergence from what's
actually reported — i.e. an automated anomaly check, not just a replay of
the on-device decision.

This is a spec of intent, not a guarantee of current firmware behavior on
every device — cross-check `devices.fw_version` before trusting a
mismatch as a bug; older firmware may not implement a rule described here.

Implemented in this repo as `src/lib/automation.ts` (Heater/Mister/Fan
only so far — see that file for why Day Light/UVB aren't implemented yet),
tested against `test/fixtures/climate_vectors.json` in `test/automation.test.ts`.

## 1. Inputs

Per device, per instant:

- **`telemetry.temp_c`, `telemetry.hum`** — the only live sensor readings
  shipped. Both already in the units used for automation decisions (temp in
  °C, humidity in %RH) — see §2. Devices on firmware predating the Celsius
  wire-format change instead shipped `temp_f`, in Fahrenheit — check
  `devices.fw_version` before assuming which one a given row uses.
- **`devices.profile_config`** (or the historized `logs.tag='config'` row
  in effect at that instant, per the webapp plan §3) — `enabled`,
  `temp_low_c`, `temp_high_c`, `hum_low`, `hum_high`, `day_light_on`,
  `day_light_off`, `uvb_on`, `uvb_off`, `timezone`. Same firmware-version
  caveat — older snapshots carry `temp_low_f`/`temp_high_f` instead.
- **`devices.outlet_roles`** (or the matching historized `logs` row) — a
  jsonb array, position *i* = outlet *i*'s role label. Match against the
  literal strings `"Heater"`, `"Mister"`, `"Fan"`, `"Day Light"`,
  `"UVB Light"` (exact spelling from `outletRoleLabel()`) — any other
  string is an unassigned/generic outlet with no automation rule. A role
  absent from the array means that behavior is inactive entirely on that
  device; don't expect any corresponding `outlet_mask` bit to move.
- **`telemetry.outlet_mask`** — bit *i* = outlet *i*'s actual reported
  on/off state, to compare the recomputed decision against.

## 2. Unit conventions (read this before writing any comparison)

- **Everything here is Celsius, matching `ClimateController`'s native
  unit** — `profile_config.temp_low_c`/`temp_high_c` and `telemetry.temp_c`
  are shipped exactly as the automation logic sees them, no conversion in
  either direction. `TEMP_HYSTERESIS = 1.0°C` and `HUMIDITY_HYSTERESIS =
  3.0` percentage points apply directly to these values as-is — there's no
  unit boundary between "what the validator reads" and "what the firmware
  decided on" to get wrong. (This wasn't always true: firmware before the
  Celsius wire-format change pre-converted to Fahrenheit before shipping,
  which meant re-deriving a 1.8°F hysteresis band on every comparison.)
- **Humidity needs no conversion** — %RH on-device and in every shipped
  field, unchanged by the above.
- **Timezone is the sharpest remaining edge case.** `profile_config.timezone` is
  either a human-readable label from a fixed list (`"Eastern Time (New
  York)"`, `"Pacific Time (Los Angeles)"`, etc. — see `NAMED_TIMEZONES` in
  `src/main.cpp` — build your own label→IANA-zone lookup, since only the
  label ships, not a POSIX/IANA string) **or**, for a custom fixed offset,
  a string like `"UTC5"` built from `"UTC" + posixOffsetString(...)` — note
  the sign is **POSIX-inverted**: `"UTC5"` means **UTC−5**, not UTC+5.
  Getting this backwards puts every day/night decision ~10 hours off in the
  wrong direction. Named-zone entries apply real US DST transitions
  (`M3.2.0`/`M11.1.0` rules); the custom-offset path never applies DST.

## 3. Heater (hysteresis thermostat)

Outlet role: `"Heater"`. Formula (°C):

```
if temp_c >= temp_high_c:                     heat = OFF   // safety ceiling, no hysteresis on the way up
elif heat == OFF and temp_c < temp_low_c:      heat = ON
elif heat == ON  and temp_c >= temp_low_c + 1.0: heat = OFF
else:                                    heat = <unchanged>
```

**This is stateful** — the ON→OFF and OFF→ON thresholds differ
(`temp_low_c` vs. `temp_low_c + 1.0`), so you cannot evaluate a single
telemetry row in isolation. Replay `telemetry` rows **in chronological
order**, carrying the previous decision forward, exactly like the on-device
state machine does.

## 4. Mister (hysteresis humidistat)

Outlet role: `"Mister"`. Same shape as Heater, humidity-flavored, no unit
conversion needed:

```
if hum >= hum_high:                      mist = OFF   // safety ceiling
elif mist == OFF and hum < hum_low:      mist = ON
elif mist == ON  and hum >= hum_low + 3.0: mist = OFF
else:                                     mist = <unchanged>
```

## 5. Fan (dual safety-ceiling vent)

Outlet role: `"Fan"`. Independent of Heater/Mister — reacts only to the
*high* ceilings, never the low thresholds:

```
temp_trigger:
  if temp_c >= temp_high_c:                          temp_trigger = ON
  elif temp_trigger == ON and temp_c < temp_high_c - 1.0: temp_trigger = OFF

hum_trigger:
  if hum >= hum_high:                                hum_trigger = ON
  elif hum_trigger == ON and hum < hum_high - 3.0:    hum_trigger = OFF

fan = temp_trigger OR hum_trigger
```

Note the hysteresis band here sits **below the ceiling**
(`temp_high_c - 1.0`), a different location than the Heater's own band
(`temp_low_c + 1.0`) — don't reuse one dead-band calculation for both.

`fan` collapses two independent booleans via OR — this is *exactly* the
seam that caused the stale-reason bug fixed in firmware `0.5.0`. The
on-device `logs.message` text for a fan event ("temperature at safety
ceiling" / "humidity at safety ceiling" / "both" / "back to normal") is a
**best-effort narrative captured at the moment of the last on/off flip or
reason change on ≥0.5.0**, not a live value — for validation, always
recompute `temp_trigger`/`hum_trigger` yourself from `telemetry.temp_c`/
`hum` rather than parsing the message string. Devices on firmware `<
0.5.0` won't log a reason update at all when the cause shifts mid-ON —
expect the logged reason to go stale on those, independent of anything the
recomputed `fan` boolean says.

## 6. Day Light

Outlet role: `"Day Light"`. Only evaluated while
`profile_config.enabled == true` **and** the device's clock has completed
NTP sync (see §8 — there's no direct signal for this in shipped data).
Given those hold:

```
day_light = in_window(now_local, day_light_on, day_light_off)
```

`in_window` handles a window crossing midnight:

```
if on_time == off_time: return false
if on_time < off_time:  return on_time <= now < off_time
else:                   return now >= on_time OR now < off_time   // wraps past midnight
```

`now_local` = the device's local time (apply the resolved timezone from
§2) at the instant being evaluated, as minutes since midnight.

## 7. UVB Light

Outlet role: `"UVB Light"`. Same time window as Day Light
(`uvb_on`/`uvb_off`, independently configurable), **plus** a forced-off
safety override layered on top: UVB bulbs are themselves a heat source, so
UVB is suppressed whenever the Fan's temperature trigger (§5) is active,
*regardless of the time window*:

```
uvb_window = in_window(now_local, uvb_on, uvb_off)
uvb = uvb_window AND NOT temp_trigger
```

Day Light is **not** subject to this override (assumed low-heat, e.g. LED)
— don't apply the same suppression to it. If a device's actual bulb runs
hot, that's a per-installation firmware customization, not default
behavior — check `fw_version`/notes before assuming this rule applies
identically everywhere.

## 8. What `enabled` does and doesn't cover

`profile_config.enabled == false` means **all five roles above go fully
manual** — Heater/Mister/Fan/Day Light/UVB state is whatever a human last
set via the dashboard, and none of the formulas above apply. Don't flag a
mismatch during a disabled window; any state is "correct" by definition.

**Known blind spot:** even with `enabled == true`, Day Light/UVB fall back
to a manual `nightMode` toggle (not the schedule) whenever the device's
clock hasn't completed NTP sync yet — e.g. shortly after boot, or no
internet access. Nothing in `profile_config` or the heartbeat directly says
"clock synced: yes/no" today. Best available proxy: a very recent
`first_seen`/small `uptime_ms` on `devices`, or `logs.device_time` being
null on rows around that time (populated only once NTP has synced) —
treat a Day Light/UVB mismatch as lower-confidence, not a confirmed bug, in
the minutes right after a boot event.

## 9. Cadence — bounds on "how stale is stale"

The on-device loop doesn't recompute continuously; use these to judge
whether an apparent mismatch is just normal lag vs. a real bug:

| What | Interval |
|---|---|
| Sensor read (updates live temp/hum) | 2s |
| Heater/Mister/Fan re-evaluation | 30s |
| Day Light/UVB schedule re-check | 15s |
| Telemetry sample shipped | 60s |
| Heartbeat (`devices` upsert, `profile_config` snapshot) | 5 min |

A recomputed decision that disagrees with the reported `outlet_mask` for
one telemetry sample (≤60s) is expected noise from this cadence gap, not
necessarily an anomaly — only flag a mismatch that **persists across
multiple consecutive telemetry samples**.

## 10. Anomaly conditions worth flagging

**First, exclude test-driven rows.** The dashboard's "Test Automation" page
runs a fake reading through the real decision logic and outlet control —
any `logs` row with `message` starting `"test: "` reflects a simulated
input, not the device's real sensor state, and will routinely fail every
check below by design (see `docs/known-issues.md`'s climate-test section
for exactly why). Filter these out before evaluating anything that
follows.

Given the above, a genuine candidate for "device not doing what its own
config says it should":

- Recomputed decision for a role disagrees with its `outlet_mask` bit for
  several consecutive telemetry samples (not just one), while
  `enabled == true` and (for Day Light/UVB) the device is well past its
  last boot.
- Fan `outlet_mask` bit is ON while both recomputed `temp_trigger` and
  `hum_trigger` are OFF (or vice versa) for a sustained stretch — flags
  either a stuck relay/Kasa outlet, or the device running firmware whose
  fan logic has diverged from this spec.
- UVB `outlet_mask` bit is ON while the recomputed `temp_trigger` is
  active — the forced-off override isn't taking effect (possible bug or
  pre-override firmware version).
- A profile/threshold implies an outlet role that has no matching entry in
  `outlet_roles` at all — automation is silently a no-op for that role;
  worth surfacing as a configuration gap, not a live-state anomaly.

Always resolve the anomaly against the **historized** `profile_config`/
`outlet_roles` in effect at that instant (per the webapp plan §3), not the
device's current settings — a threshold change made today shouldn't be
used to judge whether last week's behavior was correct.
