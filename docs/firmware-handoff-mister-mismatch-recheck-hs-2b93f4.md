# hs-2b93f4 ("Desk Window") Mister mismatch: resolved — crash-reboots open as a separate issue

**Status as of 2026-07-21: resolved (Mister alert), independently confirmed
by two separate checks plus a third direct verification below. New issue
opened, not yet root-caused: recurring interrupt-watchdog crash-reboots.**

## Mister alert: stale, safe to close

`hs-2b93f4` was showing the outlet-mismatch alert for the Mister outlet
(`outlet_index: 2`), reported by a user who noticed it was confusing given
automation for this device has been disabled since 2026-07-20 evening.

Confirmed, from three independent checks against the live device (not
Supabase — `logs`/`outlet_alerts` reject both `anon` and `service_role`
reads with `42501`; `scripts/supabase_schema.sql` never grants either role
`SELECT` on those tables, so only `devices`, which is anon-readable by
design, and the device's own local HTTP API were usable):

- Mister is **physically off**, checked directly via `/outlets`
  (`http://192.168.0.185/outlets`) across two different device boots.
- `fw_version: 0.8.0` already includes both `logOutletChange()` fixes from
  [`firmware-outlet-logging-gaps-fixed.md`](firmware-outlet-logging-gaps-fixed.md).
  The fix shipped as `0.7.1` (`CHANGELOG.md`, 2026-07-19); `0.7.1` is a
  confirmed git ancestor of `0.8.0`.
- **The fix is directly observed working**, via the device's own local
  `/events` endpoint (`http://192.168.0.185/events` — a short ring buffer of
  recent log lines, independent of the Supabase `logs` table) during the
  `"interrupt watchdog"` crash-reconnect:

  ```
  Day Light [0] turned OFF — Kasa (re)connected — defaulting off
  UVB Light [4] turned OFF — Kasa (re)connected — defaulting off
  Day Light [0] turned ON — scheduled day window
  UVB Light [4] turned ON — scheduled day window
  Fan [3] turned ON — humidity at safety ceiling
  ```

  `turnOffAllOutlets()`'s fixed logging path fired correctly on a real
  crash-recovery reconnect. Mister isn't in that block because it was
  already off pre-crash — no flip, nothing to log under `if (ok && wasOn)`.
  That's expected, not a gap.

**Why the alert is still open despite all this being fine:**
[`outlet-alerts.md`](outlet-alerts.md) documents `outlet_alerts` as never
auto-closing by design ("match exactly what was asked for — two buttons —
rather than invent an auto-resolve heuristic"). `computeOutletMismatches`
is a live, self-healing recomputation, but a previously-opened
`outlet_alerts` row isn't touched once its condition clears —
`syncOutletAlerts` only opens/refreshes rows for currently-detected
mismatches.

**Action item:** open the device page and click **Close** on the Mister/
outlet-2 alert (`DeviceTimeline.tsx`'s `AttentionAlertItem` →
`closeOutletAlert` Server Action). Sign-in-gated, needs a human.

## Crash reboots: open issue, not yet root-caused

Two reboots observed on this device within about a day, confirmed live
against its `devices` row and local API (not inferred from a stale
snapshot — re-checked minutes apart with `uptime_ms` progressing
consistently, confirming one continuous boot rather than a glitchy read):

1. `reset_reason: "software restart"` — consistent with the `0.8.0` OTA
   landing, ~2026-07-20T23:30:22Z.
2. `reset_reason: "interrupt watchdog"` — a genuine crash, ~2026-07-21
   15:30Z. Heap was healthy (222728 bytes free) and WiFi signal was fine
   (-58 dBm) at the following boot, so not a memory or connectivity
   problem.

An interrupt-watchdog reset means an ISR (or an interrupts-disabled
section) ran long enough to trip `ESP_RST_INT_WDT`. Worth checking as
likely causes: what runs during a Kasa reconnect (KLAP crypto/handshake,
JSON parsing of `get_child_device_list`), and what runs during a
config-save/rename (a device rename likely goes through the same
config-save path) — particularly `Preferences`/NVS flash writes or
commits, a classic ESP32 interrupt-watchdog trip cause when contending
with WiFi's own flash access.

**Not yet done:** reading the firmware source for
`connectKasaIfNeeded()`/Kasa reconnect handling and the config-save
handlers to find what's actually blocking. Separate investigation, in
progress — this doc's scope is the Mister alert, not the crash root cause.

## History

1. Initial handoff asked firmware to confirm whether `0.8.0` includes the
   `0.7.1` fix and whether this device's mismatch was stale pre-fix history
   or a fresh gap.
2. First "resolved" pass used a `devices` snapshot (`"software restart"`,
   ~15h49m uptime) to conclude no firmware action was needed — flagged as
   premature once a live re-check showed the device had crash-rebooted
   (`"interrupt watchdog"`) since that snapshot was taken, the exact trigger
   condition the original bug was about.
3. This revision resolves that gap: the crash-reconnect was caught live and
   its logging behavior directly inspected via the device's own `/events`
   endpoint, independent of both the stale snapshot and of Supabase (which
   remains unreachable for `logs`/`outlet_alerts` without an authenticated
   session). The fix is confirmed working; the crash itself is real and
   still open, tracked separately above.
