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
Since alerts never auto-close (below), one flagged during that window
would otherwise sit open forever, long past the point the device is fully
configured and reporting correctly.

That detection alone is just a live computation — nothing persists it, so
there was no way to acknowledge one, mark it as being worked on, or tell it
apart from a brand new occurrence. `outlet_alerts`
([`supabase/outlet_alerts.sql`](../supabase/outlet_alerts.sql)) is a new,
webapp-owned table that gives each detected mismatch a lifecycle:

```
(detected) --> open --escalate--> escalated
                 |                    |
                 +------ close -------+
                         (either state)
                          v
                       closed
```

- **open** — created automatically the first time a mismatch is detected
  (on any fleet or device page load — see `syncOutletAlerts` in
  `src/lib/alerts.ts`). No one has looked at it yet.
- **escalated** — a human clicked "Escalate" on the device page: this needs
  a real fix, not just an acknowledgement.
- **closed** — a human clicked "Close": this occurrence is dismissed. If
  the *same* mismatch is detected again later (same `mismatch_since`), it
  stays closed — closing is a real dismissal, not a snooze. A genuinely new
  episode (the old mismatch resolved and a different one started) opens a
  fresh alert regardless of the old one's status.

Nothing auto-closes an alert when the live mismatch stops being detected —
only the two explicit actions change status. This was a deliberate choice
to match exactly what was asked for (two buttons) rather than invent an
auto-resolve heuristic on top.

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
`DeviceHealth.activeOutletAlerts` (non-closed rows only), so you can see
open vs. escalated counts at a glance rather than just the rolled-up tier.

## Where the writes happen

- `syncOutletAlerts` (`src/lib/alerts.ts`) — reconciles live-detected
  mismatches into `outlet_alerts` (insert if new/re-opened episode, refresh
  snapshot fields if unchanged in status, never touches `status` itself).
  Called from both `getFleetHealth` (fleet-wide, using a coarse 2-sample
  `mismatch_since`) and the device page (using `getOutletAttention`'s
  deeper, more accurate scan — `syncOutletAlerts` only ever refines
  `mismatch_since` earlier, never later, when both have touched the same
  row).
- `closeOutletAlert` / `escalateOutletAlert`
  (`src/app/devices/[deviceId]/actions.ts`) — Next.js Server Actions,
  called directly from the device page's "Close"/"Escalate" buttons
  (`DeviceTimeline.tsx`'s `AttentionAlertItem`). Both record which
  `auth.users` id acted and revalidate the fleet + device pages.

## Alert history (bottom of the device page)

`DeviceTimeline.tsx`'s `AlertHistorySection` renders every `outlet_alerts`
row ever created for that device (open, escalated, and closed — not just
the currently-active ones the "Needs attention" card above shows),
newest-first, via `getOutletAlertHistory` (`src/lib/alerts.ts`). Each entry
shows the detected mismatch, and — if it's been acted on — when it was
escalated and/or closed and by whom (resolved from `closed_by`/
`escalated_by`'s `auth.users` id to an email via the read-only
`outlet_alert_actors` view, `supabase/outlet_alert_actors.sql`, since the
webapp otherwise has no access to `auth.users` directly). An alert that was
escalated and later closed shows both events, not just the final one.

## Setup required

This repo has no Supabase CLI/migrations setup — run both
[`supabase/outlet_alerts.sql`](../supabase/outlet_alerts.sql) and
[`supabase/outlet_alert_actors.sql`](../supabase/outlet_alert_actors.sql)
by hand, in that order, against the project's SQL editor before this
feature will work. Until then, `getFleetHealth`/the device page's sync
calls will fail with `relation "outlet_alerts" does not exist`, and the
alert history will fail to resolve actor emails.

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
