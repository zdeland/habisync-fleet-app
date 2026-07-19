# Handoff: outlet transition logging gaps closed (unreleased, after 0.7.0)

> Received from the firmware team in response to
> [`firmware-handoff-untracked-outlet-transition.md`](firmware-handoff-untracked-outlet-transition.md).
> File/doc references below (`src/main.cpp`, `src/Relay.cpp`, `README.md`,
> `CHANGELOG.md`, `webapp-handoff.md`) are in the **firmware** repo, not this
> one — kept verbatim since they're the firmware team's pointers into their
> own tree.

## Background

Reported bug: on `hs-2b93f4` ("Leopard Gecko"), the Mister outlet was
physically off, but its only logged event was a `"turned ON"` row from
2026-07-18 18:47:39 — no OFF transition was ever logged. Confirmed not a
webapp query bug (checked via direct SQL) and not the `/climate-test`
prefix caveat (§3 of `webapp-handoff.md`). The webapp side already has a
defensive fix for the symptom: `timeline.ts`'s `reconstructStateAt` used to
show the last logged reason/timestamp even when its `outlet_state`
disagreed with the outlet's actual current state; it now only shows the
reason when it matches current state. That masks the symptom — it doesn't
explain why a real OFF transition went unlogged. This doc is the
firmware-side root cause and fix.

## Root cause: two independent logging bypasses

Every legitimate outlet write is supposed to go through `applyOutletState()`
(`src/main.cpp:298-316`), which pairs the write with a `logEvent()` →
`CloudLog::logOutletChange()` call. Two other code paths wrote to outlets
directly, skipping that pairing entirely:

1. **`turnOffAllOutlets()`** (`src/main.cpp:320-339`) called
   `backend.setOutlet(i, false)` directly with no logging at all. It runs on
   every Kasa (re)connect — including the one `setup()` triggers on every
   boot, and the one `connectKasaIfNeeded()` retries in `loop()` whenever
   `isDiscovered()` is false (e.g. after a crash/watchdog/brownout reset, or
   a dropped Kasa session). So any reboot or Kasa reconnect forced every
   outlet off with zero record of it happening — this is the most likely
   explanation for `hs-2b93f4`: a reset sometime after 18:47:39 would have
   silently dropped the Mister to OFF.
2. **The periodic Kasa state re-sync** (`src/main.cpp:2814-2836`) polls the
   strip every `KASA_REFRESH_INTERVAL_MS` and adopts whatever state it
   reports — picking up anything toggled via the Kasa app, the strip's own
   scheduling/overload protection, or a manual press on the strip itself. It
   updated `outletLastChanged` on a mismatch but never logged the
   transition.

Neither is a timing race — this firmware is single-threaded, so it's just
two call sites that were never wired to the logger.

## The fix

Both sites now log every real ON→OFF (or OFF→ON) flip they make, through the
same `logEvent()`/`CloudLog::logOutletChange()` path `applyOutletState()`
uses, so they produce normal `tag='event'` rows with structured
`outlet_index`/`outlet_state` columns — nothing new on the wire, no schema
change.

New `logs.message` text you'll start seeing:

| Trigger | Message pattern | `message` reason suffix |
|---|---|---|
| Boot / Kasa reconnect forcing outlets off | `"<Role> [<i>] turned OFF — Kasa (re)connected — defaulting off"` | `Kasa (re)connected — defaulting off` |
| Switching outlet backend (Kasa ↔ relay, via `/outlet-setup`) | `"<Role> [<i>] turned OFF — switching outlet backend"` | `switching outlet backend` |
| Kasa strip reports a state firmware didn't cause (app, strip schedule/overload protection, manual press on the strip) | `"<Role> [<i>] turned ON/OFF — changed outside firmware control"` | `changed outside firmware control` |

These are ordinary `tag='event'` rows — no new tag value, no new columns.
Only the reason text and the fact that a row now exists at all are new.

## What the webapp should do

1. **Don't revert the `reconstructStateAt` masking yet.** Devices only get
   this fix after their next firmware update — until a device's OTA check
   picks it up (checks every 6 hours per firmware `README.md`), it's still
   running the old logic and can still produce the silent gap this fix
   closes. The masking behavior is a reasonable permanent defensive fallback
   regardless (a device could still be running old firmware indefinitely if
   OTA is disabled or fails), so treat this as "the gap should now stop
   growing going forward, on updated devices" rather than "safe to assume
   the data is always consistent." Same reasoning applies to
   [`getOutletAttention`](../src/lib/queries.ts)'s fleet/device mismatch
   detection — it should keep flagging pre-fix devices; that's expected, not
   a false positive.
2. **Historical data before a device's update keeps the old symptom.** Any
   `hs-2b93f4`-style mismatch logged before this fix reaches that device
   will still show a stale ON row with no matching OFF — that's expected,
   not a regression.
3. **New reason strings, if you parse `message` for anything.** Per
   `automation-rules.md`'s existing guidance, you shouldn't be treating
   `logs.message` as ground truth for automation decisions anyway (always
   recompute from `telemetry.temp_c`/`hum`) — but if any tooling greps for
   known reason substrings (e.g. building a device timeline's "why" column),
   add the three new ones above alongside the existing automation reasons.
4. **No firmware version gate exists yet to key off of.** This hasn't been
   cut as a release yet — it's unreleased, sitting after `0.7.0` in
   firmware `CHANGELOG.md`. Once it ships as a numbered version, gate any
   "should I trust this device's outlet history" logic on
   `devices.fw_version` the same way §1.3 of `webapp-handoff.md` describes
   for the Celsius migration.

## Known remaining gap — not fixed here, flagging so it isn't assumed covered

`RelayStrip::configure()` (`src/Relay.cpp`, called from GPIO-relay-backend
boot init) also drives every pin to its inactive level via direct
`digitalWrite()` calls, bypassing logging the same way `turnOffAllOutlets()`
did for Kasa. This fix only covers the Kasa-backend paths
(`turnOffAllOutlets()` and the periodic refresh) that were the actual root
cause for `hs-2b93f4`. A relay-backend device rebooting would have the same
class of silent "boot forced this outlet off, no log row" gap. Worth a
follow-up if any relay-backend device shows the same symptom.
