# Planning brief: HabiSync fleet monitoring & debugging webapp

This is a handoff brief for building a **separate webapp** (its own repo/
project) that reads from the Supabase project HabiSync devices already
report to. It is not a spec for changes to this firmware repo — the two
schema additions this originally recommended (see §3) have since been made
here, so the webapp can be designed directly against the corrected shape.

## 1. Goal

Given a fleet of HabiSync ESP32 controllers (each running a reptile
enclosure's heat/humidity/fan/lighting automation), build a read-only
monitoring and debugging tool that can, for any device and time range:

- Reconstruct what the device's full state was at any instant in that
  range — every outlet's on/off state, temperature/humidity readings,
  day/night mode, whether climate automation was enabled — as if replaying
  a recording, not just showing the current live state.
- Show the context needed to explain *why* — the event that caused each
  state change, the automation targets in effect, connectivity/reboot
  history around that time.
- Do this across the whole fleet, not just one device at a time, so a
  fleet-wide issue (e.g. several units losing WiFi at the same time) is
  visible as a pattern, not just N separate device pages.

This is a debugging tool for whoever maintains the fleet, not an end-user
dashboard — optimize for "explain this anomaly" over polish. The product
should also support collaborative investigation and guided remediation:
team members can leave notes and action items while reviewing a device or
fleet trend, and the app can surface simple owner-facing instructions when
a device needs a manual fix or follow-up.

## 2. Data source

Read [`docs/cloudlog-dataflow.md`](cloudlog-dataflow.md) and
[`scripts/supabase_schema.sql`](../scripts/supabase_schema.sql) in this repo
first — they're the ground truth for what ships and when. Summary:

- **`devices`** — one row per device, upserted every 5 min (heartbeat).
  Current-state only: name, fw_version, ip, rssi, free_heap, uptime_ms,
  active_backend, reset_reason, `outlet_roles` (jsonb array, position *i* =
  outlet *i*'s role label), `profile_config` (jsonb: reptile profile,
  climate targets, day/night schedule, OTA URL, Kasa IP), first_seen,
  last_seen.
- **`logs`** — append-only, one row per event. `level` (0-3), `tag`
  (boot/wifi/kasa/ota/sensor/event/cloudlog), free-text `message`,
  `uptime_ms`, `device_time` (null until the device's NTP-synced —
  `created_at` is the reliable server timestamp, always present), and
  `temp_f`/`hum` populated only on `tag='event'` rows (outlet/automation/
  day-night transitions, via the firmware's `logEvent()` hook). 60-day
  retention.
- **`telemetry`** — append-only, one row roughly every 60s per device:
  `temp_f`, `hum`, `outlet_mask` (bitfield, bit *i* = outlet *i*'s on/off
  state), `free_heap`, `rssi`. 30-day retention.

**Auth:** the on-device anon key is insert-only (plus upsert on `devices`)
by design — it cannot read `logs`/`telemetry`. The webapp needs an
`authenticated` Supabase Auth session (e.g. a simple email/password or
magic-link login gating the whole app) and should read through Supabase's
client library or PostgREST with that session's JWT, never the anon key or
a service-role key shipped to the browser. If a service-role key is needed
for some admin action, keep it server-side only (a Next.js API route /
Supabase Edge Function), never in client-side code.

## 3. Data-model gaps — now fixed, read this before designing the reducer

The original schema was built for "ship logs and let a human read them in
Studio," not for programmatic timeline reconstruction. Both gaps flagged
here have since been fixed in this repo (firmware + schema); this section
now documents the fix rather than a recommendation, since the reducer
should be built directly against the corrected shape below.

**(a) `outlet_roles`/`profile_config` historization.** `devices.outlet_roles`/
`profile_config` are still current-snapshot only (that row is upserted) —
but every settings save (climate targets, day/night schedule, outlet-role
assignment, backend switch, OTA URL) now *also* ships a standalone,
append-only `logs` row with `tag='config'`, carrying the same two fields
(`outlet_roles jsonb`, `profile_config jsonb`, added as columns on `logs`).
"What were this device's settings as of time T" is now:

```sql
select outlet_roles, profile_config from logs
where device_id = :id and tag = 'config' and created_at <= :t
order by created_at desc limit 1;
```

If no such row exists yet for a device (e.g. it hasn't had a settings save
since this shipped), fall back to `devices.profile_config`/`outlet_roles`
as a best-effort approximation — same as the original fallback plan.

**(b) Structured outlet transitions.** `logs` now has nullable
`outlet_index int2` / `outlet_state boolean` columns, populated alongside
the existing free-text `message` on every outlet on/off transition (via a
new `CloudLog::logOutletChange()`, called from `applyOutletState()` in
`src/main.cpp`). Read these columns directly for `tag='event'` rows where
they're non-null; `message` remains the human-readable display string, and
is still the only source for non-outlet events (day/night toggle,
automation enable/disable — these were not changed to carry outlet_index,
since they don't correspond to one specific outlet).

**Still true regardless:** `telemetry.outlet_mask` (historized, one full
snapshot per minute) remains the authoritative source for "was outlet *i*
physically on" — cross-check it against the reconstructed state from
`logs` rather than trusting either source alone, since a config row only
records that a save happened, not a guarantee every subsequent telemetry
sample matches it.

**Devices with data from before this shipped** will have a gap: no
`tag='config'` rows exist for that period, and old `event` rows lack
`outlet_index`/`outlet_state`. Treat pre-upgrade history as
approximation-only (current `devices` snapshot + free-text `message`
parsing as a fallback), same as if this fix hadn't been made.

## 4. Core features

1. **Fleet overview** — table of all `devices` rows: name, last_seen (with
   a stale/offline indicator once it exceeds ~2x the 5-min heartbeat
   interval), fw_version, active_backend, current temp/hum from the latest
   telemetry row, a small health rollup (recent error-log count, free_heap
   trend, RSSI). Sortable/filterable; this is the "what needs attention
   right now" view.

2. **Device timeline / playback view** — pick a device + time range (with
   quick presets: last hour/day/week, plus custom range respecting the
   30/60-day retention windows) and get:
   - A merged, time-ordered feed of `logs` (all levels/tags) and
     `telemetry` samples for that window.
   - A **scrubber/slider** across the range. Dragging it reconstructs and
     displays the full device state at that instant: every outlet's
     on/off (icon per role, same visual language as the physical
     dashboard's device-icon grid), temp/humidity gauges, automation
     enabled/disabled, day/night mode — derived per the reducer in §5.
   - Temp/humidity as a line chart over the range, with the climate
     targets (from the historized `logs.tag='config'` row in effect at
     each point, per §3) drawn as a shaded band, so "was it out of range"
     is visible at a glance.
   - Every `logs` row plotted as a marker on the timeline, color-coded by
     level (reuse the error/warn/info/debug palette from
     `cloudlog-dataflow.md`), hoverable for the full message + reason.

3. **Context panel at the scrubbed instant** — a plain-English state
   summary ("Heater ON since 14:12 — temperature below target range";
   "Automation: enabled"; "Day/Night: day, Day Light ON per schedule"),
   the reset_reason and boot event if a reboot is within the visible
   window, WiFi drop/reconnect markers, and any OTA status changes.

4. **Fleet-wide event search** — filter across all devices by tag, level,
   free-text message, and time range (e.g. "every ERROR in the last 24h
   across the fleet," "every device that dropped WiFi more than twice
   today"). This is what surfaces a shared root cause across units.

5. **Collaborative investigation notes** — allow authenticated users to add
   notes to a device, a specific time window, or a specific event. Notes can
   capture observations, hypotheses, and handoff context while a problem is
   being investigated.

6. **Recommended actions / remediation workflows** — attach lightweight
   action items to a device or incident, such as "check WiFi stability",
   "retest outlet mapping", or "replace failed sensor". These can be:
   - internal team actions for investigation and follow-up
   - owner-facing instructions that guide the device owner through a fix
   - tracked with statuses like open, in progress, or resolved

7. **Owner-facing guidance view** — for issues that need manual intervention,
   surface a simple checklist or set of instructions to the device owner,
   without turning the app into a remote-control system. This should make it
   easier for the owner to try a resolution and then report back.

8. **Derived anomaly flags** (nice-to-have, second pass): temp/hum outside
   target range for longer than the automation's own hysteresis should
   allow; `free_heap` trending down over days (possible leak); WiFi
   flapping frequency; a device's local log-drop counter (`CloudLog`'s
   "N entries dropped" synthetic WARN) firing, meaning the ring buffer
   overflowed and there's a gap in that device's record.

## 5. State reconstruction algorithm (the core of §4.2)

For a device + time range `[t0, t1]`:

1. Fetch `telemetry` rows in range, ordered by `created_at` asc — these are
   full, authoritative snapshots (temp_f, hum, outlet_mask, free_heap,
   rssi) roughly every 60s. This is the backbone.
2. Fetch `logs` rows in range, ordered by `created_at` asc — finer-grained
   events between telemetry samples, plus non-outlet context (WiFi, boot,
   OTA, sensor failures).
3. Resolve the active `outlet_roles`/`profile_config` for the range: the
   most recent `logs` row with `tag='config'` at or before each instant
   (per §3). Fall back to the current `devices.outlet_roles`/
   `profile_config` — with a visible "config shown is current, may not
   match this historical period" disclaimer in the UI — only for devices/
   periods that predate this fix (no `config` row exists yet).
4. To render state at a scrubbed instant `t`:
   - Take the most recent `telemetry` sample at or before `t` as the base
     outlet_mask/temp/hum.
   - Overlay any `logs` outlet-transition events between that sample and
     `t`, reading the structured `outlet_index`/`outlet_state` columns
     directly (message-parsing is only a fallback for data that predates
     §3).
   - Map `outlet_mask` bits to roles via the resolved `outlet_roles` from
     step 3.
5. Prefer `device_time` over `created_at` when present for *display*
   (it's the device's own clock, matches what a user would have seen
   on-device at the time), but always sort/query by `created_at` (it's
   monotonic and always populated; `device_time` is null pre-NTP-sync and
   can jump on first sync).

## 6. Non-functional notes

- **Read-only for device control.** No remote control of devices from this
  app — that's out of scope and a different trust boundary (would need a
  device-addressable command channel that doesn't exist today). The app can
  still support authenticated writes for notes and remediation actions in
  its own workflow tables.
- **Pagination/windowing.** A device can accumulate tens of thousands of
  telemetry/log rows within the retention window; don't fetch a whole
  device's history unbounded — page or downsample (e.g. telemetry can be
  bucketed/averaged for wide time ranges, full-resolution only when zoomed
  into a narrow window).
- **Retention-aware.** Respect the 60-day (`logs`) / 30-day (`telemetry`)
  purge — a time-range picker should not silently offer dates that will
  return nothing without explanation.
- **Multiple devices, one project.** All queries filter by `device_id`;
  there's no per-tenant isolation in the schema (every `authenticated` user
  can read the whole fleet) — fine for an internal debugging tool, not
  something to expose to end customers as-is.

## 7. Open questions for whoever builds this

- Should the reducer bother supporting the pre-§3 fallback (current-config
  approximation) at all, or is it acceptable to only fully support devices/
  time ranges from when this shipped onward?
- Auth model: a single shared login for whoever debugges the fleet, or
  real per-user Supabase Auth accounts?
- Any preferred stack? No constraint from the firmware side — this is a
  clean separate project talking to Supabase over PostgREST/the JS client;
  a React/Next.js + a charting lib (e.g. Observable Plot, uPlot, or
  Recharts) is a reasonable default given the timeline-scrubbing and
  charting needs, but pick whatever the builder is most productive in.
- How much of the note/action workflow should be in v1? A minimal version
  could support notes plus simple action status; a fuller version could add
  assignment, ownership, and owner-facing instruction flows.
- What role model should we support? A shared internal team workspace, or
  distinct team and owner views with different permissions?
