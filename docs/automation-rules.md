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
Two things about that field: it carries `FIRMWARE_VERSION` verbatim, so the
wire values have **no `v` prefix** even though the git tags do (`0.26.0` in
the DB, `v0.26.0` in the firmware repo), and the release line skips
straight from `0.24.1` to `0.26.0` — nothing ever reported `0.25.0`, which
was never committed, tagged, or built (§5a). Prefer key-presence feature
detection to version comparisons regardless: a historized `tag='config'`
row keeps the shape it was written under, so a device's *current* version
misjudges its own past rows (§6, §11).

Implemented in this repo as `src/lib/automation.ts` (Heater/Mister/Fan
only so far — see that file for why the lighting rules aren't implemented
yet), tested against `test/fixtures/climate_vectors.json` in
`test/automation.test.ts`. The lighting schedule's *shape* is already read
by `src/lib/schedule.ts`, which is the only place that should touch the
`*_ranges`/scalar fields directly (§6).

## 1. Inputs

Per device, per instant:

- **`telemetry.temp_c`, `telemetry.hum`** — the only live sensor readings
  shipped. Both already in the units used for automation decisions (temp in
  °C, humidity in %RH) — see §2. Devices on firmware predating the Celsius
  wire-format change instead shipped `temp_f`, in Fahrenheit — check
  `devices.fw_version` before assuming which one a given row uses.
- **`devices.profile_config`** (or the historized `logs.tag='config'` row
  in effect at that instant, per the webapp plan §3) — `enabled`,
  `temp_low_c`, `temp_high_c`, `hum_low`, `hum_high`, `day_light_ranges`,
  `uvb_ranges`, `basking_ranges` (each window carrying `on`, `off` and the
  `fan` assist flag of §5a), `mister_ranges` (**not** the same window shape
  since 0.29.0 — `on` plus `duration_s` in seconds, and no `fan`; §4a-i),
  `timezone`. Same firmware-version caveat
  in both directions — older snapshots carry `temp_low_f`/`temp_high_f`
  instead of the Celsius pair, and carry the single-window scalars
  (`day_light_on`/`day_light_off`, `uvb_on`/`uvb_off`) instead of the
  `*_ranges` arrays. The scalars still ship on 0.26.0+ but no longer tell
  the whole story — read them only as described in §6.
- **`devices.outlet_roles`** (or the matching historized `logs` row) — a
  jsonb array, position *i* = outlet *i*'s role label. Match against the
  literal strings `"Heater"`, `"Mister"`, `"Fan"`, `"Day Light"`,
  `"UVB Light"`, `"Basking Spot"` (exact spelling from
  `outletRoleLabel()`; the last is firmware 0.26.0+) — any other
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
- **Clock resolution is not uniform.** Every schedule rule in this document
  compares at **minute** resolution except one: a 0.29.0+ mister window is a
  start plus `duration_s` **seconds**, as short as 5 (§4a-i). Evaluate that
  one at minute resolution and a 5-second spike computes as never on or a
  full minute on. `duration_s` is seconds, never minutes.
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

## 4. Mister (hysteresis humidistat, plus scheduled spikes)

Outlet role: `"Mister"`. Same shape as Heater, humidity-flavored, no unit
conversion needed:

```
if hum >= hum_high:                      mist = OFF   // safety ceiling
elif mist == OFF and hum < hum_low:      mist = ON
elif mist == ON  and hum >= hum_low + 3.0: mist = OFF
else:                                     mist = <unchanged>
```

Call that boolean `humidistat`. It was the entire rule through 0.27.0, and
is unchanged by everything that follows — same thresholds, same 3.0 %RH
hysteresis, same ceiling. Since 0.28.0 it is **one of two terms**.

### 4a. Scheduled mist windows (firmware 0.28.0+)

`profile_config` gains a fourth ranges array. **It has two wire shapes**, and
which one a snapshot uses is decided per window, on key presence — see 4a-i
below. The outer formula is the same under both:

```
mist = humidistat OR (mist_window AND NOT hum_trigger)

mist_window = ANY(span_open(r) for r in mister_ranges)
```

Each window spikes the Mister at a fixed time of day regardless of where
humidity currently sits — a deliberate spike on top of the reactive
humidistat, which through 0.27.0 was the only thing driving that outlet.
There is no day/night concept in this rule to special-case: a night-time
spike is a window that wraps past midnight, expressed like any other.

**Not a new role.** `outlet_roles` is unchanged and `outlet_mask` doesn't
change structurally — this is the existing `"Mister"` outlet gaining a
second input, not a new role label to match.

Properties to get right — the four the firmware handoff calls out, plus one
about `hum_trigger` that its formula implies but doesn't spell out:

- **It is purely additive**, like fan assist (§5a). A window can only turn
  the mister *on*; it never cuts short a mist the humidistat already wants.
  A device with an empty `mister_ranges` computes identically to 0.27.0.
- **The humidity ceiling overrides it.** This is the one place it departs
  from fan assist, which is unconditionally additive: a scheduled spike into
  an already-saturated enclosure is suppressed — the direct analogue of the
  too-hot cutout suppressing a basking window (§8). Both halves of the
  formula are ceiling-gated, so at or above `hum_high` the mister is off
  whatever the schedule says.
- **`hum_trigger` is §5's existing latch, not a fresh comparison.** It is
  the same boolean the vent fan reacts to, and it carries hysteresis: it
  stays ON until `hum < hum_high - 3.0`. So the schedule half is suppressed
  across a **wider** band than the humidistat's own instantaneous
  `hum >= hum_high` ceiling. Re-deriving it as `hum >= hum_high` re-opens a
  scheduled spike partway down the fan's dead band, while the real device
  keeps it shut.
- **No mister window ever feeds `fan_assist`** — see §5a. 0.28.0 writes a
  `fan` key here and it is always `false`; 0.29.0 dropped the key from this
  array outright. The rule is the same either way, and neither shape's key
  is represented in `MisterWindow` (`src/lib/types.ts`) so that `w.fan`
  fails to compile rather than quietly contributing a term.
- **It needs a synced clock**, like every schedule term (§9). Without one
  the term is false and the mister runs on the humidistat alone — so a
  just-booted device is *less* on than a naive recompute expects, never
  more.

Reading the array:

- **An absent key means `[]`.** Pre-0.28.0 devices emit no `mister_ranges`
  at all, and the humidistat-only formula stays correct for them: no version
  gating, same key-presence feature detection as §6. Note this is a
  *second*, outer key-presence check — whether the array exists — layered
  over §4a-i's per-window one. They are independent: an array can exist and
  be empty, and a device that emits the array tells you nothing about which
  window shape it writes.
- Absent and `[]` are therefore indistinguishable in effect, and that's
  fine. They differ in *meaning* ("firmware predates the feature" vs. "the
  keeper scheduled no spikes"), which only matters if you want to surface
  the feature's availability in the UI.
- **There is no scalar first-window companion** — no `mister_on`/
  `mister_off`. The scalars on the other three arrays exist only to keep
  pre-multi-window validators working; nothing ever read a mister schedule,
  so there's no back-compat surface to preserve and §6's first-window trap
  has no analogue here. Read `mister_ranges` or nothing.
- Windows are unsorted and may overlap, same as §6. Its cap has since moved
  to five, and the lighting arrays' caps are now neither three nor equal to
  each other — see §6a, and don't encode any of those numbers.

**Why this needs attention, and why it's less urgent than §5a's.** A
validator still on the humidistat-only formula sees the Mister ON with
`humidistat` OFF and flags a stuck relay — structurally the same false
positive as the fan-assist trap. The difference is blast radius: basking
windows are `fan`-ticked by default, so §5a's trap fires on ordinary
out-of-the-box devices, whereas **all mister windows ship unused**, because
misting has always been purely reactive and an upgrading device has to keep
behaving exactly as it did. So this only fires on a device where a keeper
has actually gone and scheduled a spike — real, but self-inflicted per
device rather than fleet-wide on upgrade.

This repo computes only the `humidistat` term (the schedule half needs the
same local clock that blocks §6-8), so `src/lib/automation.ts`'s
`decision.mist` is now a **lower bound** — see the comment on
`ClimateDecision` before building any mister check on it.

#### 4a-i. Two shapes: fork per window on `duration_s`

0.28.0 reused the lighting windows' writer verbatim, and that was the wrong
shape for a mister. **0.29.0, published the day after, replaced it.**

```json
"mister_ranges": [{"on": "07:30", "off": "07:45", "fan": false}]   // 0.28.0
"mister_ranges": [{"on": "07:30", "duration_s": 15}]               // 0.29.0+
```

Why it had to change: a pair of minute-resolution clock times cannot
express anything shorter than **60 seconds of water**, which is far more
than a humidity spike wants — and 0.28.0 only re-evaluated the mister every
30s, so even 60s was not reliably executable. 0.29.0 stores a duration in
5-second increments and ticks fast enough to honour it (§10).

`duration_s` is **seconds** — always a multiple of 5, between 5 and 300.

```
for r in mister_ranges:
    if "duration_s" in r:
        span_open(r) = ((now_local_seconds - to_seconds(r.on)) mod 86400) < r.duration_s
    else:
        span_open(r) = in_window(now_local, r.on, r.off)   # 0.28.0 rows only
```

**Discriminate on the key, never on `fw_version`.**

| Window carries | Shape | Emitted by |
|---|---|---|
| `duration_s` | start + duration | 0.29.0+ |
| `off` | on/off pair | 0.28.0 only |

This is **permanent, not transitional**. The 0.28.0-emitting population is
small — one day of releases, windows unused by default — but historized
`tag='config'` rows keep whatever shape they were written under, so a
device that went through the upgrade carries a stripe of old-shape rows in
its own history forever. Version-gating a historical check against that
device's *current* version reads the wrong branch for the stripe, exactly
as in §6.

`isMisterDurationWindow()` in `src/lib/schedule.ts` is the single place
this repo makes the decision.

**Seconds resolution is mandatory for the duration form.** Every other rule
in this document compares at minute resolution. Do that here and a 5-second
spike computes as either never on or a full minute on — both wrong, and the
second one wrong in the direction that manufactures anomalies. Whatever
eventually resolves the device's local time (the blocker in §6-8) must not
round to the minute on the way.

**Upgrading rewrites a keeper's spike lengths.** A 0.28.0 device migrating
to 0.29.0 converts in place: the old on-time becomes the start, and the old
span becomes the duration **capped at 300s**. A keeper who set a 15-minute
window in 0.28.0 gets a 5-minute one. That is device behavior, not wire
format — but it means a device's reported spike length can change across
the upgrade with nobody having edited it, and it is why the UI renders a
0.28.0 pair as a pair rather than normalizing it into a duration it no
longer runs.

#### 4a-ii. What is actually confirmed

Both shapes above are **code-inspected, not observed.** This has now been
outstanding across four firmware handoffs and is the one thing still owed
to us: nobody has captured a `profile_config` row containing a *populated*
`mister_ranges` in either form.

What we do have:

- **An observed empty array.** On 2026-08-31 `hs-2e5540` ("ZRD Test Unit")
  carried `"mister_ranges": []` while reporting `fw_version = 0.27.0`, and
  the other two 0.27.0 devices had no such key at all. So the array does
  ship **empty** — what an upgrading device needs in order to keep behaving
  exactly as it did — and there is **no** `mister_on`/`mister_off` scalar
  companion.
- **Proof that `fw_version` cannot gate this feature.** The device with the
  key and the two without reported the *identical* version string; that
  bench unit was running an unreleased build whose version had not been
  bumped. Key presence isn't merely the better signal here as it is in §6,
  it is the only signal that exists — and this is precisely the case a
  version check would have gotten wrong. It is also why §4a-i's per-window
  fork is on key presence and not on a release number.
- **Observed `logs` rows for real spikes**, scheduled and manual, with the
  durations in §10a. So the scheduled path demonstrably works end to end on
  a device even though the config snapshot that drives it has never been
  captured.

What that leaves: treat §4a-i's formula and both JSON shapes as the spec —
they match the firmware's own §4a and its shipped source — but **confirm
the wire format against a real snapshot before building the §11 mister
anomaly rules on it.** Not confirmed either: the 0.28.0 → 0.29.0 NVS
migration described above, and the Kasa backend's spike timing (§10a).

## 5. Fan (safety-ceiling vent, plus fan assist)

Outlet role: `"Fan"`. Independent of Heater/Mister — reacts only to the
*high* ceilings, never the low thresholds:

```
temp_trigger:
  if temp_c >= temp_high_c:                          temp_trigger = ON
  elif temp_trigger == ON and temp_c < temp_high_c - 1.0: temp_trigger = OFF

hum_trigger:
  if hum >= hum_high:                                hum_trigger = ON
  elif hum_trigger == ON and hum < hum_high - 3.0:    hum_trigger = OFF

fan = temp_trigger OR hum_trigger OR fan_assist
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

### 5a. Fan assist (firmware 0.27.0+)

Each lighting window (§6-8) carries a `fan` flag. A ticked window runs the
Fan for that window's duration — venting a bulb's heat while it's lit,
rather than waiting for the temperature to reach its ceiling. This is the
**third term** in the formula above, and it is new in 0.27.0:

```
fan_assist = ANY(r.fan AND in_window(now_local, r.on, r.off)
                 for r in day_light_ranges + uvb_ranges + basking_ranges)
```

**The fold is over those three arrays only.** A `fan_assist` reducer that
folds over "every `*_ranges` array" generically rather than naming the three
lights **is a bug as of 0.28.0**, and the history of `mister_ranges`'
`fan` key is a good argument for why the generic version was never safe:

- **0.28.0** serialised `fan` on mister windows too — always `false`,
  because the device never offers that checkbox there and venting mid-spike
  would fight the thing the window exists to do. It was in the JSON purely
  because that release reused the lighting windows' writer. A generic
  reducer stayed *quiet* here, and only because the key happened to be
  false.
- **0.29.0** dropped `fan` from the array entirely along with the rest of
  the reshape (§4a-i), so a generic reducer now reads `undefined` there
  instead. Also quiet, also by luck, and for a completely different reason
  than before.

Neither release ever made "fold over everything" correct — it made it
*undetectable*, twice, which is worse. `src/lib/schedule.ts` keeps the
mister out of its `LightRole` union for exactly this reason, and neither
`MisterWindow` shape has a `fan` field at all, so `w.fan` fails to compile
rather than silently contributing a term.

Firmware writes `fan` on every window, defaulting **true on basking
windows** and false elsewhere. That default is applied when the window is
written, not something a reader should re-derive — an absent flag is
false, and inferring true from the role would override a window a keeper
deliberately unticked.

Multi-window landed in 0.26.0 and fan assist in 0.27.0 — **two separate
published releases**, which splits the fleet three ways:

| Snapshot | `fw_version` | `*_ranges` | `fan` on its windows |
|---|---|---|---|
| Pre-multi-window (the un-upgraded fleet) | `0.24.1` and earlier | absent — use the scalars | n/a |
| Multi-window, no fan assist | `0.26.0` | present | **absent on every window** |
| Fan assist | `0.27.0` | present | written on every window |

So `*_ranges` present with **no** `fan` key anywhere is a real, deployed
shape, not a hypothetical: absent-means-false is load-bearing for an actual
generation of firmware, not merely a safe default. Never infer `fan` from
`*_ranges` being present — detect on the flag itself, exactly as §6 detects
multi-window on the array key.

Two things about that middle row worth knowing:

- **Nothing ever reported `fw_version = 0.25.0`.** That version was never
  committed, tagged, or built for OTA — its *contents* shipped as 0.26.0.
  "0.25.0 was never deployed" is true and says nothing about whether the
  ranges-only shape was; this document previously drew that inference and
  was wrong.
- **No device currently reports `0.26.0`, and the shape is still
  unconfirmed in our own data.** As of 2026-08-31 the fleet is three
  devices on `0.27.0` (all three carrying `fan` on every window, as above)
  and four long-stale devices on `0.8.1`–`0.18.4` with scalars only — so
  the "un-upgraded fleet" is far older than the `0.24.1` boundary in the
  table. Confirming the middle row means reading historized
  `tag='config'` rows, and `service_role` has no `SELECT` on `logs` (only
  what climate-alerts needs was granted); the webapp itself reads them
  through an authenticated session under RLS. Left unverified rather than
  widening that grant.
- **The 0.26.0-only window is narrow, and its reach isn't precisely
  known.** Both releases were published on 2026-08-30, so no device sat on
  0.26.0 for long; the firmware team can confirm it was tagged, pushed to
  OTA and heartbeated by at least a bench ESP32-S3, but not how many
  customer units ran it. Either way the shape outlives the version, because
  every device that heartbeated on it wrote append-only `tag='config'` rows
  that keep it forever — a device on 0.27.0 today still has 0.26.0-shaped
  rows in its own history. That is exactly why §6 and §11 insist on
  resolving against the snapshot in effect at the instant being judged
  rather than `devices.fw_version`. Expect the count of such rows to be
  small but non-zero.

Three properties worth holding onto:

- **It follows the window, not the bulb.** A light suppressed by the
  too-hot cutout (§7, §8) still contributes its term. That's deliberate:
  the enclosure is over its ceiling then, so `temp_trigger` wants the fan
  running anyway.
- **It is purely additive.** It only ever turns the fan on, never
  suppresses one the ceilings already want. A device with every box
  unticked behaves exactly like pre-0.27.0 firmware.
- **It needs a synced clock**, like every other schedule term — so the
  §9 NTP blind spot applies to the fan now too, not just to the lights.

**Why this one is urgent.** A validator still on the two-term formula sees
the fan ON with both triggers OFF and flags a stuck relay — the exact
anomaly in §11. Because basking windows are ticked by default, that fires
on ordinary, correctly-behaving devices rather than as a rare edge case.
This repo's `src/lib/automation.ts` computes only the two climate terms
today (the third needs the same local clock that blocks §6-8), so its
`decision.fan` is a **lower bound** — see the comment on `ClimateDecision`
before building any fan check on it.

## 6. Day Light

Outlet role: `"Day Light"`. Only evaluated while
`profile_config.enabled == true` **and** the device's clock has completed
NTP sync (see §9 — there's no direct signal for this in shipped data).
Given those hold:

```
day_light = ANY(in_window(now_local, r.on, r.off) for r in day_light_ranges)
```

Firmware 0.26.0 replaced the single `day_light_on`/`day_light_off` pair
with **several independent windows per day**, and did the same for UVB
(§7) and the new Basking Spot (§8). The light is on if `now_local` falls
in *any* window:

```
"day_light_ranges": [{"on": "07:00", "off": "19:00", "fan": false}],
"uvb_ranges":       [{"on": "08:00", "off": "11:00", "fan": false},
                     {"on": "15:00", "off": "18:00", "fan": false}],
"basking_ranges":   [{"on": "09:00", "off": "17:00", "fan": true}]
```

Each window's `fan` flag is fan assist — it drives the **Fan** outlet, not
the light's own, and is specified in §5a rather than here. It is absent
entirely on a 0.26.0 snapshot (§5a's table).

### 6a. How many windows — per array, and not stable

Through 0.31.0 every one of these arrays allowed three. As of **0.32.0**
the caps are per-array and differ:

| Array | Max windows | Was |
|---|---|---|
| `day_light_ranges` | 2 | 3 |
| `uvb_ranges` | 1 | 3 |
| `basking_ranges` | 3 | 3 |
| `mister_ranges` (§4a) | 5 | 3 |

**Nothing should read these numbers.** They are here to explain what you
will see in the data, not to be encoded anywhere. Iterating the array and
OR-ing `in_window` across it — which is what this section has always
specified — is correct under every one of these caps and under the next
change to them. `src/lib/schedule.ts` is the only place that touches the
arrays and does exactly that; the trap to avoid is a literal `3` appearing
downstream of it.

Unused windows have always been omitted, so **an array's length was never
its cap** and a shorter array has never meant anything on its own.

One consequence worth recognising before someone reports it as a fault: a
device that had a now-removed window configured (Day Light 3, UVB 2-3)
**stops running it** on upgrade. The value survives in the device's own
storage but is no longer read, so its `*_ranges` array simply gets shorter
between two consecutive historized `tag='config'` snapshots with **no
keeper action in between**. That is the upgrade, not a lost setting and not
a config that failed to save.

**Verified against live rows** (2026-08-31, the three 0.27.0 devices in
`devices`), after the firmware team flagged this shape as code-inspected
rather than observed. Everything above holds: the scalars carry exactly
`*_ranges[0]`, an empty array does collapse its scalars to
`"00:00"`/`"00:00"`, a second window is really there on `basking_ranges`,
and `fan` is written on every window — `true` on basking, `false` on day
light and UVB, matching §5a's default. (Firmware serialises the keys as
`{"on", "fan", "off"}`, not that key order means anything in JSON.)

Reading the arrays correctly:

- **Unused windows are omitted, not null-padded** — an array holds 0–3
  elements.
- **An empty array is valid and means "never scheduled on"** — not missing
  data, and *not* a signal to fall back to the scalars.
- Windows are **not normalized**: they may overlap, and they are not
  sorted. Don't assume a disjoint, ordered set.
- **The old scalar fields still ship, plus new `basking_on`/`basking_off`
  — but every one of them carries only the first window.**
  `day_light_on`/`day_light_off` = `day_light_ranges[0]`, or
  `"00:00"`/`"00:00"` if that array is empty; same for `uvb_*` and
  `basking_*`.
- **Fall back to the scalar pair only when the `*_ranges` key is absent**
  (a pre-0.26.0 device). Feature-detect on key presence rather than
  parsing `devices.fw_version`. On a `devices` row the two can't actually
  disagree — `fw_version` and `profile_config` ship in the same heartbeat
  upsert — but historized `logs.tag='config'` rows are append-only and
  keep the shape they were written under, so version-gating a *historical*
  check against the device's *current* version reads the wrong branch for
  every row predating that device's upgrade (§11 on resolving against the
  snapshot in effect at the instant being judged).
- The `"00:00"`/`"00:00"` case is self-consistent (equal on/off means
  never on, per `in_window` below) but is **not** a real midnight window —
  don't special-case midnight into existence.

A validator that keeps reading only the scalars computes "should be off"
for the entire duration of any second or third window, and flags a
sustained mismatch against `outlet_mask` — i.e. it reports a confident
firmware bug that isn't one. That failure mode looks plausible enough to
survive review, which makes it worse than a crash.

`in_window` is unchanged and applies per window. It handles a window
crossing midnight:

```
if on_time == off_time: return false
if on_time < off_time:  return on_time <= now < off_time
else:                   return now >= on_time OR now < off_time   // wraps past midnight
```

`now_local` = the device's local time (apply the resolved timezone from
§2) at the instant being evaluated, as minutes since midnight.

## 7. UVB Light

Outlet role: `"UVB Light"`. Same windows as Day Light (`uvb_ranges`,
independently configurable, read exactly as in §6), **plus** a forced-off
safety override layered on top: UVB bulbs are themselves a heat source, so
UVB is suppressed whenever the Fan's temperature trigger (§5) is active,
*regardless of the time window*:

```
uvb_window = ANY(in_window(now_local, r.on, r.off) for r in uvb_ranges)
uvb        = uvb_window AND NOT temp_trigger
```

Day Light is **not** subject to this override (assumed low-heat, e.g. LED)
— don't apply the same suppression to it. If a device's actual bulb runs
hot, that's a per-installation firmware customization, not default
behavior — check `fw_version`/notes before assuming this rule applies
identically everywhere.

## 8. Basking Spot

Outlet role: `"Basking Spot"` (firmware 0.26.0+). Its own windows
(`basking_ranges`, read exactly as in §6), under the **same** forced-off
heat override as UVB (§7) — a basking lamp is unambiguously a heat source:

```
basking_window = ANY(in_window(now_local, r.on, r.off) for r in basking_ranges)
basking        = basking_window AND NOT temp_trigger
```

Two things to get right:

- Reuse the **UVB** override path, not Day Light's unguarded one.
- It is **deliberately not coupled to the Heater's thermostat** (§3). It
  runs purely on its clock windows plus that safety ceiling — don't expect
  its state to track `temp_low_c`/`temp_high_c` in either direction, and
  don't infer a relationship from the two often being on together.

Its windows are also the ones firmware ticks for fan assist by default
(§5a) — so on a device with a basking schedule, expect the Fan to be on
through that window with neither ceiling trigger active. That is correct
behavior, not a stuck relay.

Nothing about `outlet_mask` changes structurally: Basking Spot is just
another outlet index, and unassigned means no bit moves, same as any other
absent role. Pre-0.26.0 devices never carry `"Basking Spot"` in
`outlet_roles` and have no `basking_*` fields at all.

## 9. What `enabled` does and doesn't cover

`profile_config.enabled == false` means **all six roles above go fully
manual** — Heater/Mister/Fan/Day Light/UVB/Basking Spot state is whatever a
human last set via the dashboard, and none of the formulas above apply.
Don't flag a mismatch during a disabled window; any state is "correct" by
definition.

**Known blind spot:** even with `enabled == true`, the scheduled lights fall back
to a manual `nightMode` toggle (not the schedule) whenever the device's
clock hasn't completed NTP sync yet — e.g. shortly after boot, or no
internet access. Nothing in `profile_config` or the heartbeat directly says
"clock synced: yes/no" today. Best available proxy: a very recent
`first_seen`/small `uptime_ms` on `devices`, or `logs.device_time` being
null on rows around that time (populated only once NTP has synced) —
treat a Day Light/UVB/Basking Spot mismatch as lower-confidence, not a
confirmed bug, in the minutes right after a boot event.

## 10. Cadence — bounds on "how stale is stale"

The on-device loop doesn't recompute continuously; use these to judge
whether an apparent mismatch is just normal lag vs. a real bug:

| What | Interval |
|---|---|
| Sensor read (updates live temp/hum) | 2s |
| Heater/Mister/Fan re-evaluation | 30s |
| Day Light/UVB/Basking schedule re-check | 15s |
| Fan assist re-evaluation (§5a) | 30s |
| Scheduled mist window re-evaluation (§4a) | 30s |
| Mister spike expiry tick (`applyMisterState()`) | 250ms (was 1s before 0.31.0) |
| Telemetry sample shipped | 60s |
| Heartbeat (`devices` upsert, `profile_config` snapshot) | 5 min |

A recomputed decision that disagrees with the reported `outlet_mask` for
one telemetry sample (≤60s) is expected noise from this cadence gap, not
necessarily an anomaly — only flag a mismatch that **persists across
multiple consecutive telemetry samples**.

Fan assist is written on the climate interval, not the faster schedule
one, so expect up to ~30s of lag at a ticked window's boundary — longer
than the lights' own 15s, on the same edge. A scheduled mist window (§4a)
is on the same interval for the same reason: up to ~30s at either edge of a
window, which for a 15-minute spike is a real fraction of its length. Don't
flag it.

### 10a. Every mister spike runs long, never short

A spike ends on the **first tick after it expires**, so the tick interval
is a uniform overshoot tail on every spike. It is quantisation, not drift:
the error is bounded by one tick and does not accumulate across spikes. And
it has a sign — **a spike is never delivered short**.

Measured on a deployed relay-backend device at the old 1s tick:

| Nominal | Delivered | Over |
|---|---|---|
| 5,000 ms (pulse) | 5,748 ms | +748 |
| 5,000 ms (pulse) | 5,743 ms | +743 |
| 15,000 ms (pulse) | 15,523 ms | +523 |
| 60,000 ms (pulse) | 60,234 ms | +234 |
| 120,000 ms (scheduled window) | 120,543 ms | +543 |

Every one is inside a single tick interval. Two things these rows settle
that were previously inference: the **scheduled** path works end to end on
real hardware, and on the relay backend the outlet actuation itself is fast
enough to disappear into the tick.

Caveats before treating a tail as a budget:

- **The 250ms tick's effect is unconfirmed.** 0.31.0 shipped after this
  run. The tail *should* fall below 250ms; nobody has measured it.
- **Kasa is unmeasured entirely.** Expect a variable WiFi round trip on top
  of the tick there, so a Kasa device's tail is neither this table's shape
  nor reliably bounded by the tick at all.

So: allow at least one tick of overshoot on any spike-duration check, and
treat a spike that ran **short** as the interesting signal — that direction
is not something the tick can produce.

## 11. Anomaly conditions worth flagging

**First, exclude manual test rows.** Two different dashboard buttons drive
the real decision logic and real outlets, and both log through the ordinary
`tag='event'` path. Neither reflects an automation decision, and both will
routinely fail every check below by design. Filter out any `logs` row whose
message reason starts with either:

| Prefix | Button | Notes |
|---|---|---|
| `test: ` | "Test Automation" (gauge-drag) | A simulated *sensor reading* run through the real logic — see `docs/known-issues.md`'s climate-test section for why its own `temp_c`/`hum` columns disagree with what drove it. |
| `test pulse` | manual mister check (0.32.0+) | A human firing a spike by hand. `test pulse — manual mister check` opens it, `test pulse complete` closes it. |

Note the two are **not one convention** — one has a colon and a following
reason, the other doesn't — so match them as two literal prefixes, and treat
the set as one that grows rather than a rule to infer. `isTestReason()` in
`src/lib/logReasons.ts` is the shared implementation, deliberately in `lib/`
rather than in the timeline component so an anomaly check can reach it.

**Second, don't key anything on the rest of the message text.** This
section's checks are all recomputations of state; that is deliberate, and
it has now paid off twice. 0.32.0 rewrote the lighting outlets' reason from
`scheduled day window`/`scheduled night window` to `inside its scheduled
window`/`outside its scheduled window` — because each light runs its own
independent windows and the old wording had only two words for the outcome,
so a basking spot whose window opens at 09:00 correctly switched off at
08:30 and logged `scheduled night window`, in the morning. The decision was
never wrong; the sentence was, and it cost the firmware team real time
chasing a phantom clock fault.

Any rule that had keyed off those strings would have broken **silently** —
the old text simply stops appearing. Treat every reason string in this
document, the test prefixes above included, as a thing that describes the
device to a human and may be rewritten in any release.

Given the above, a genuine candidate for "device not doing what its own
config says it should":

- Recomputed decision for a role disagrees with its `outlet_mask` bit for
  several consecutive telemetry samples (not just one), while
  `enabled == true` and (for the scheduled lights) the device is well past
  its last boot.
- Fan `outlet_mask` bit is ON while the recomputed `fan` is OFF (or vice
  versa) for a sustained stretch — flags either a stuck relay/Kasa outlet,
  or the device running firmware whose fan logic has diverged from this
  spec. **Only valid against all three terms** (§5a): `temp_trigger OR
  hum_trigger` alone reports a stuck relay for the whole duration of any
  ticked window, and basking windows are ticked by default, so the
  two-term version fires on healthy devices.

  Gate it on the snapshot, not on a version — the two-term formula is
  exactly right whenever **no window in that snapshot has `fan` ticked**,
  because `fan_assist` is then false at every instant. That covers the
  entire pre-multi-window fleet outright (no `*_ranges` at all means no
  ticked window) and every `0.26.0`-shaped snapshot (arrays present, the
  key absent on all of them), plus any 0.27.0 device with the boxes
  unticked — and needs no clock to determine. Where a ticked window does exist, skip the check
  until fan assist is actually computed rather than reporting a mismatch
  you know to be spurious.
- Mister `outlet_mask` bit is ON while the recomputed `humidistat` is OFF
  for a sustained stretch — the humidity-side sibling of the Fan bullet
  above, and **only valid against both terms** (§4a): the humidistat alone
  reports a stuck relay for the whole duration of any open mist window.

  Gate it on the snapshot rather than a version, exactly as with the fan —
  the one-term formula is exact whenever `mister_ranges` is absent or empty,
  because `mist_window` is then false at every instant, and that needs no
  clock to determine. Unlike the fan's gate this still covers most of the
  fleet *after* upgrading, since mister windows ship unused; where a device
  does have one, skip the check until the schedule half is actually computed
  rather than reporting a mismatch you know to be spurious.
- Mister `outlet_mask` bit is ON while the recomputed `hum_trigger` is
  active — the humidity-side twin of the UVB/Basking too-hot check below:
  the ceiling override isn't taking effect. This one needs no clock and no
  window gate, because the ceiling suppresses **both** halves of §4a's
  formula — no schedule can make it legal.

  One profile shape breaks that, though: where `hum_high - hum_low < 3.0`,
  humidity can fall below `hum_low` while `hum_trigger` is still latched
  (its release point, `hum_high - 3.0`, sits *below* `hum_low` there), which
  legitimately turns the humidistat half back on with the latch active.
  Check the band's width against the 3.0 %RH hysteresis before flagging a
  narrow profile.
- UVB or Basking Spot `outlet_mask` bit is ON while the recomputed
  `temp_trigger` is active — the forced-off override isn't taking effect
  (possible bug or pre-override firmware version). The check is identical
  for both roles; both are suppressed by the same signal (§7, §8).
- A profile/threshold implies an outlet role that has no matching entry in
  `outlet_roles` at all — automation is silently a no-op for that role;
  worth surfacing as a configuration gap, not a live-state anomaly.

Always resolve the anomaly against the **historized** `profile_config`/
`outlet_roles` in effect at that instant (per the webapp plan §3), not the
device's current settings — a threshold change made today shouldn't be
used to judge whether last week's behavior was correct.

### 11a. Verifying a mister spike actually fired

Every check above is a `telemetry.outlet_mask` comparison, and **none of
them can see a mister spike**. Telemetry samples every 60s; spikes run
5-300s, so most open and close entirely between two samples. A
spike-verification rule built on `outlet_mask` would report "never fired"
for spikes that fired perfectly.

`logs` can see them. Every outlet transition writes a row with structured
`outlet_index`/`outlet_state` columns and a `uptime_ms` stamp — **both
edges of every spike are there**. So:

- **Read `logs`, never `outlet_mask`, for anything spike-shaped.**
- **Compute duration from `uptime_ms`, not `device_time`.** `uptime_ms` is
  the device's own millisecond clock; `device_time` is second-resolution
  and cannot resolve a 5s spike at all.
- **Compare against §10a**, which says the delivered duration is the
  nominal one plus up to one tick, always over. Short is the signal.

Two things weaken a *negative* result specifically, and both mean absence
of a row is much weaker evidence than presence of one:

- These rows ship at **INFO**, so a device configured with a stricter
  minimum severity never sends them.
- CloudLog is a **best-effort queue** (`docs/cloudlog-dataflow.md`) — a
  dropped row is an ordinary outcome, not a fault.

So a rule of the form "these two edges exist and the gap between them is
wrong" is sound; "no row, therefore the spike didn't fire" is not.

The cause of a spike is in the reason text, subject to the whole of §11's
second warning about depending on that text:

| Text | Meaning |
|---|---|
| `scheduled mist window` | a configured spike (§4a) |
| `scheduled mist window held off — enclosure too humid` | the `hum_trigger` ceiling suppressed it — correct behavior, per §4a |
| `test pulse — manual mister check` | a human pressed a button — **not automation**, exclude per §11 |
| `test pulse complete` | that pulse's closing edge |

None of this is built. It is recorded because the earlier guidance said a
spike-verification rule was not buildable at all, which was true of
`outlet_mask` and wrong as a general claim.
