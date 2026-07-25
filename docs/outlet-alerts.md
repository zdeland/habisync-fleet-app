# Outlet alerts: closing/escalating "needs attention" outlet mismatches

## What this is

`src/lib/queries.ts`'s `computeOutletMismatches` detects when an outlet's
actual state (`telemetry.outlet_mask`) disagrees with the last logged
`tag='event'` transition for `OUTLET_MISMATCH_DEBOUNCE_SAMPLES` (2)
consecutive telemetry samples — see
[`firmware-handoff-untracked-outlet-transition.md`](firmware-handoff-untracked-outlet-transition.md)
and its fix,
[`firmware-outlet-logging-gaps-fixed.md`](firmware-outlet-logging-gaps-fixed.md).

Detection is suppressed entirely for `NEW_DEVICE_GRACE_MS` (15 min) after a
device's `first_seen`: a brand-new device routinely reports a mismatch for
a few minutes while its outlets are still being wired/paired (a Kasa plug
not joined yet, a relay not yet under firmware control), where the last
logged transition is just a boot default rather than a real disagreement.
Even with auto-resolve (below) an alert flagged during that window is
avoidable noise rather than something to clean up after the fact — better
to suppress detection outright than rely on the outlet happening to get
re-checked and cleared before anyone looks.

It's also suppressed for `OUTLET_ACTUATION_GRACE_MS` (90s) after the last
logged transition itself, regardless of how many telemetry samples have
disagreed since. Confirmed against a real case (`hs-2ac964`, 2026-07-20,
Day Light): firmware logged an OFF command at 23:00:28, but the Kasa plug's
own network round-trip meant telemetry didn't confirm the physical flip
until 23:00:58 — the 2 samples taken in between (both still showing the
old state) were enough to satisfy `OUTLET_MISMATCH_DEBOUNCE_SAMPLES` and
get flagged, even though the outlet caught up on its own one sample later
and stayed correct. That's the reverse of the timing
`OUTLET_MISMATCH_DEBOUNCE_SAMPLES` exists for (flip happens, log lags
behind it) — here the log lands first and the physical actuation lags
behind *it*.

It's also suppressed for `REBOOT_GRACE_MS` (3 min) after a detected reboot —
`msSinceDeviceBoot` derives the device's current boot instant from
`devices.last_seen - devices.uptime_ms` (both come from the same heartbeat
upsert, so no telemetry history is needed to know this). A reboot or Kasa
reconnect forces every outlet to a known state via `turnOffAllOutlets()`,
then the periodic Kasa resync and/or `ClimateController` can flip several
back within seconds — each flip now logs correctly (see
[`firmware-outlet-logging-gaps-fixed.md`](firmware-outlet-logging-gaps-fixed.md)),
but there's the same kind of brief physical-flip-before-log-row-lands window
as `OUTLET_ACTUATION_GRACE_MS` covers, just triggered by a reboot's burst of
flips instead of one command. Confirmed against a real case (`hs-2b93f4`,
2026-07-21, interrupt-watchdog reset): the whole reconnect-and-resettle
sequence finished in well under a minute, so this grace period gives it
roughly a 3x margin.

That detection alone is just a live computation — nothing persists it, so
there was no way to acknowledge one, mark it as being worked on, or tell it
apart from a brand new occurrence. `outlet_alerts`
([`supabase/outlet_alerts.sql`](../supabase/outlet_alerts.sql)) is a new,
webapp-owned table that gives each detected mismatch a lifecycle:

```
(detected) --> open --escalate--> escalated
                 |                    |
                 +------ close -------+
                 |                    |
                 +--- self-clears  ---+
                         |
                         v
               closed / auto_resolved
```

- **open** — created automatically the first time a mismatch is detected
  (on any fleet or device page load — see `syncOutletAlerts` in
  `src/lib/alerts.ts`). No one has looked at it yet.
- **escalated** — a human clicked "Escalate" on the device page: this needs
  a real fix, not just an acknowledgement.
- **auto_resolved** — `syncOutletAlerts` itself moved it here, with no human
  involved: on a later pass, the outlet it's tracking was actually
  evaluated again (present in that pass's `checkedOutletIndexes` — see
  `computeOutletMismatches`) and was no longer mismatching. Typical cause is
  a reboot-flicker alert (see `REBOOT_GRACE_MS` above) that settled back to
  matching within a poll or two, before anyone got to it. `auto_resolved_at`
  is set; `closed_by`/`closed_at` are not, since nothing to attribute it to.
- **closed** — a human clicked "Close": this occurrence is dismissed. If
  the *same* mismatch is detected again later (same `mismatch_since`), it
  stays closed — closing is a real dismissal, not a snooze. A genuinely new
  episode (the old mismatch resolved and a different one started) opens a
  fresh alert regardless of the old one's status.

An alert only ever leaves open/escalated for one of three reasons: a human
closes it, a human escalates it, or `syncOutletAlerts` auto-resolves it
because the outlet it's tracking was checked again and found clean. Nothing
about an outlet's mismatch stopping being detected is inferred silently — an
outlet not evaluated on a given pass (inside a grace period, or too few
telemetry samples) leaves its existing alert untouched either way, since
silence isn't evidence.

`auto_resolved` and `closed` differ in one important way if the *same*
mismatch comes back: `closed` stays closed (a human's dismissal is sticky,
not a snooze), but `auto_resolved` always reopens as a fresh alert — the
system, not a person, made that call, and a recurrence just proved it
wrong. This is a narrower exception to the original "only two explicit
actions change status" design than a general auto-resolve heuristic would
be: it only fires for outlets the code has *actually just re-checked and
confirmed clean*, not for outlets it simply hasn't looked at in a while.

## How it feeds the fleet table's health status

The fleet table's HEALTHY/WARNING/CRITICAL status
(`src/components/FleetTable.tsx`'s `deriveStatus`) also factors in
`DeviceHealth.activeOutletAlerts`: a device with an escalated alert can
never show HEALTHY (it's treated as CRITICAL), and a merely-open alert
floors it at WARNING. An outlet alert is still a human-managed workflow
item — it stays open/escalated until someone actively closes it, so it can
in principle be "old" (the device may have since gotten a firmware update,
or the specific outlet may have flipped back) — but until it's closed, the
webapp treats "an outlet isn't reliably under firmware control" as
disqualifying for a HEALTHY badge. It's still broken out separately in its
own **Attention** column too, sourced from the same
`DeviceHealth.activeOutletAlerts` (`getActiveOutletAlerts` excludes both
`closed` and `auto_resolved` — see above), so you can see open vs.
escalated counts at a glance rather than just the rolled-up tier.

## Where the writes happen

- `syncOutletAlerts` (`src/lib/alerts.ts`) — reconciles live-detected
  mismatches into `outlet_alerts` (insert if new/re-opened episode, refresh
  snapshot fields if unchanged in status, auto-resolve if the outlet's own
  alert is open/escalated but the outlet itself is no longer mismatching).
  Takes `checkedOutletIndexes` alongside `snapshots` specifically so it can
  tell "checked, now clean" apart from "not evaluated this pass" — only the
  former is safe to auto-resolve. Called from both `getFleetHealth`
  (fleet-wide, using a coarse 2-sample `mismatch_since`) and the device page
  (using `getOutletAttention`'s deeper, more accurate scan —
  `syncOutletAlerts` only ever refines `mismatch_since` earlier, never
  later, when both have touched the same row).
- `closeOutletAlert` / `escalateOutletAlert`
  (`src/app/devices/[deviceId]/actions.ts`) — Next.js Server Actions,
  called directly from the device page's "Close"/"Escalate" buttons
  (`DeviceTimeline.tsx`'s `AttentionAlertItem`). Both record which
  `auth.users` id acted and revalidate the fleet + device pages.

## Alert history (bottom of the device page)

`DeviceTimeline.tsx`'s `AlertHistorySection` renders every `outlet_alerts`
row ever created for that device (open, escalated, auto-resolved, and
closed — not just the currently-active ones the "Needs attention" card
above shows), newest-first, via `getOutletAlertHistory` (`src/lib/alerts.ts`).
Each entry shows the detected mismatch, and — if it's been acted on — when
it was escalated and/or closed and by whom (resolved from `closed_by`/
`escalated_by`'s `auth.users` id to an email via the `profiles` table,
`supabase/profiles.sql`, kept in sync via trigger since the webapp
otherwise has no access to `auth.users` directly), or when it was
auto-resolved (`auto_resolved_at`, no actor — the system decided this one).
An alert that was escalated and later closed shows both events, not just
the final one.

The "Needs attention" card itself also shows a lightweight, best-effort
hint when an open/escalated alert's `mismatch_since` lands within 30 minutes
of the device's current boot (same `msSinceDeviceBoot` used for
`REBOOT_GRACE_MS`, just a wider display-only window): "Device rebooted at
…, may be reconnect-flicker — verify before escalating." This can only see
the device's *current* boot — if it's rebooted again since the alert
opened, the hint won't fire even if an earlier reboot was the real cause.

## Setup required

This repo has no Supabase CLI/migrations setup — run both
[`supabase/outlet_alerts.sql`](../supabase/outlet_alerts.sql) and
[`supabase/profiles.sql`](../supabase/profiles.sql)
by hand, in that order, against the project's SQL editor before this
feature will work. Until then, `getFleetHealth`/the device page's sync
calls will fail with `relation "outlet_alerts" does not exist`, and the
alert history will fail to resolve actor emails.

If `outlet_alerts` already exists from before the `auto_resolved` status was
added (2026-07-21), also run
[`supabase/add_auto_resolved_status_2026-07-21.sql`](../supabase/add_auto_resolved_status_2026-07-21.sql)
by hand once — it widens the `status` check constraint, adds
`auto_resolved_at`, and updates the partial unique index. `outlet_alerts.sql`
already reflects the post-migration schema for any future fresh install.

If `outlet_alert_actors` (a view directly over `auth.users`) already exists
from before 2026-07-22 — it was flagged by Supabase's security advisor as
exposing `auth.users` to `authenticated`, even though it only ever projected
`id`/`email` — run
[`supabase/replace_outlet_alert_actors_with_profiles_2026-07-22.sql`](../supabase/replace_outlet_alert_actors_with_profiles_2026-07-22.sql)
instead of `profiles.sql`. It creates the same `profiles` table (kept in
sync via an `auth.users` trigger instead of a live view) and drops the old
view. Same exposure as before (id+email, `authenticated` only — signups are
invite-only, see `src/app/invite/actions.ts`), just a shape the advisor
doesn't flag.

**Gotcha already hit once:** `CREATE POLICY` alone is not enough — RLS
policies only restrict rows on top of a base table-level `GRANT` that must
already exist, and this project's schema does not auto-apply one to new
tables (same issue `docs/known-issues.md` documents for `devices`/anon).
Both SQL files include an explicit `grant ... to authenticated` for this
reason — confirmed necessary live (querying returned `42501 permission
denied` without it), not just theoretical.

## Known limitations

- **No notification channel yet.** "Escalate" is a status flag, not an
  alert to anyone — there's still no cron/notification infra in this repo
  (see the "we will add an alert mechanism later" note from when the
  underlying detection was first built). A human has to be looking at the
  fleet or device page to see it.
- **Fleet-wide sync writes on every page load/poll.** Same pragmatic
  tradeoff as the rest of this app's read path (no background jobs exist)
  — writes are idempotent and cheap once steady-state, but this means a GET
  request has a side effect, which isn't typical REST practice.
- **`role` is a snapshot, not live.** If a device's outlet roles get
  reassigned after an alert is created, the alert still shows the role name
  from detection time.
- **Reboot detection only sees the current boot.** `msSinceDeviceBoot`
  (`REBOOT_GRACE_MS` and the "Needs attention" card's reboot hint) derives
  boot time from the device's latest `devices` row — a device that's
  rebooted multiple times since an alert opened only shows its most recent
  boot, not the one that actually caused it.
- **Auto-resolve can't tell "settled correctly" apart from "still wrong but
  stopped disagreeing by coincidence."** It only checks that the outlet is
  no longer mismatching *right now* — same trust level as the live
  detection itself, no extra scrutiny before clearing the "needs attention"
  status.
