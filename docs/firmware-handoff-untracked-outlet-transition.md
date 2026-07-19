# Firmware handoff: outlet changed state with no logged transition

**Status as of 2026-07-19: root cause found and fixed firmware-side
(unreleased, sitting after 0.7.0) — see
[`firmware-outlet-logging-gaps-fixed.md`](firmware-outlet-logging-gaps-fixed.md)
for the fix, the two bypassed logging call sites, and a known remaining gap
on relay-backend devices. Webapp-side symptom patch (below) stays in place:
it's still needed for any device that hasn't picked up the fix yet, and
remains a reasonable permanent fallback regardless.**

## What happened

On `hs-2b93f4` ("Leopard Gecko"), the Mister outlet (`outlet_index: 2`) is
physically **off** right now, but the only `tag='event'` log row ever
recorded for that outlet is:

```json
{
  "created_at": "2026-07-18 18:47:39.704033+00",
  "message": "Mister [2] turned ON — humidity below target range",
  "outlet_index": 2,
  "outlet_state": true
}
```

No corresponding OFF transition exists for that outlet at all — not just
outside some query window, there simply isn't one in `logs`. Whatever turned
Mister off did so without going through `CloudLog::logOutletChange()` (or
whatever code path normally pairs an outlet flip with a `tag='event'` row).

Current humidity (64.4%) is well above this profile's `hum_high` (40%) —
high enough that Fan's independent humidity-safety-ceiling trigger has
correctly fired and logged its own event. So Mister turning off is the
*correct* outcome; it's the missing log row that's the bug.

## Why this matters

`logOutletChange()`'s structured `outlet_index`/`outlet_state` columns are
the ground truth this webapp (and any future tooling) uses to reconstruct
"why is this outlet in its current state, and since when" — see
[`monitoring-webapp-plan.md`](monitoring-webapp-plan.md) §4.2 and
[`cloudlog-dataflow.md`](cloudlog-dataflow.md). A transition that bypasses
that path is invisible to every consumer of `logs`, not just this one
screen.

## What we've ruled out

- **Not the `/climate-test` caveat** ([`known-issues.md`](known-issues.md)) —
  that path logs a normal `tag='event'` row, just prefixed `"test: "`. This
  row has no such prefix, and there's no second row at all, so this isn't a
  test-driven transition we're failing to distinguish; it's an actual missing
  log entry.
- **Not a query/webapp bug** — confirmed directly against `logs` via SQL,
  independent of the webapp's own fetch logic.

## Webapp-side fix already applied

`reconstructStateAt` (`src/lib/timeline.ts`) previously showed an outlet's
most recent logged transition's message/timestamp unconditionally, even when
that transition's own `outlet_state` disagreed with the outlet's actual
current state (from `telemetry.outlet_mask`) — i.e. it displayed "turned ON
— humidity below target range" as if that still explained *now*, when the
outlet is actually off. It now only shows the reason/timestamp when the
transition's `outlet_state` matches the outlet's current on/off state;
otherwise it shows just on/off with no (necessarily stale, possibly wrong)
explanation. This masks the *symptom* on this one screen — it doesn't find
or fix the underlying gap in what firmware logs.

## What's worth checking firmware-side

Any code path that can change a physical outlet's state without calling
through `logOutletChange()`:

- A manual toggle from the on-device dashboard/UI, if it calls the Kasa/relay
  backend directly rather than through the same `applyOutletState()` path
  `ClimateController` uses.
- Boot/reconnect/watchdog-reset handling that re-syncs or re-applies outlet
  state without logging (e.g. re-asserting a known state after a Wi-Fi drop
  or an ESP32 reset).
- Any place `ClimateController`'s computed state and the actual outlet write
  can diverge (state updated, but the write call and the log call aren't
  both guaranteed to run — e.g. one succeeds and the other is skipped by an
  early return).

## Suggested query to check how widespread this is

Across the fleet, for each outlet, does the last logged `outlet_state` for
that index still match the most recent `telemetry.outlet_mask` bit? A
mismatch on every device examined so far, or just this one, changes how
urgent this is:

```sql
select device_id, outlet_index, outlet_state, created_at
from logs
where tag = 'event' and outlet_index is not null
order by device_id, outlet_index, created_at desc;
```

Cross-reference each `(device_id, outlet_index)`'s most recent row above
against that device's latest `telemetry.outlet_mask` bit for the same index.
