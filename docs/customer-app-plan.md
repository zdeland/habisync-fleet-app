# Planning brief: HabiSync customer-facing app (SaaS)

This is a handoff brief for building a **separate app** (its own repo/
project) for device owners — as opposed to this repo, which is the internal
fleet-ops tool for whoever maintains the whole fleet. It is not a spec for
changes to this repo. See §0 for why these need to be two separate
products rather than one app serving both audiences.

## 0. Why this is a separate app, not a mode of this one

This repo's own planning brief already drew this line before any customer
app existed — [`monitoring-webapp-plan.md`](monitoring-webapp-plan.md) §6:

> there's no per-tenant isolation in the schema (every `authenticated` user
> can read the whole fleet) — fine for an internal debugging tool, not
> something to expose to end customers as-is.

Concretely, this repo:

- Has **no tenant isolation** — every RLS policy on `devices`/`logs`/
  `telemetry`/`outlet_alerts` grants "any authenticated user, whole fleet."
  Retrofitting per-owner scoping means rewriting every policy, not flipping
  a flag.
- Is **explicitly staff tooling** — "a debugging tool for whoever maintains
  the fleet, not an end-user dashboard... optimize for 'explain this
  anomaly' over polish" (`monitoring-webapp-plan.md` §1). Its vocabulary
  (outlet index, mismatch, escalate) and its "needs attention" framing
  assume a maintainer triaging many devices, not an owner checking on one
  enclosure.
- Runs at an **internal reliability bar**: hand-run SQL migrations (no
  migrations tool — see any file under [`../supabase/`](../supabase/)'s
  header comments), no error boundary anywhere in the app (an unhandled
  server error currently takes down the whole page), invite-only sign-in
  for a small known team.

None of that is a criticism of this repo — it's doing its job. It's the
reason the customer app needs its own schema-level tenancy, its own
vocabulary, and its own production-grade reliability practices from day
one, rather than inheriting this repo's internal-tool assumptions.

**What to reuse instead of rebuild:** the detection/automation logic in
this repo encodes real, hard-won fixes — each grace period and threshold
below has a "confirmed against a real device" incident behind it (see
[`outlet-alerts.md`](outlet-alerts.md), [`automation-rules.md`](automation-rules.md)).
Re-deriving these from scratch means re-earning bugs already fixed here.
Concretely, pull logic (not UI) from:

- `src/lib/queries.ts` — `computeOutletMismatches`, `msSinceDeviceBoot`,
  and every grace-period constant (§3 below).
- `src/lib/alerts.ts` — the `outlet_alerts` lifecycle rules (`syncOutletAlerts`'s
  auto-resolve vs. human-close distinction) — see §4.
- `src/lib/automation.ts` / [`automation-rules.md`](automation-rules.md) —
  the heater/mister/fan/lighting hysteresis rules, if the customer app ever
  needs to explain *why* an outlet is on, not just that it is.
- `src/lib/timeline.ts` — the state-reconstruction reducer
  (`monitoring-webapp-plan.md` §5), if the customer app offers any history
  view richer than "here's today's chart."

The plain-language copy already written for internal staff is a
reasonable starting point for customer-facing tone too — see the
"Enclosure Alerts, Explained" reference artifact from this project (badge
meanings, wait-time explanations, health-color meanings) — but treat it as
a first draft, not final customer copy; a customer audience has different
expectations (reassurance, what-happens-next) than staff triaging alerts.

## 1. Goal

Given a HabiSync device an individual owns (one or a handful of reptile
enclosures, not a fleet), build a **owner-facing app** that can:

- Show the current state of their enclosure(s) in plain language: is it
  warm/humid enough, is the heater/mister/lights doing what they should,
  is everything connected.
- Notify the owner when something needs their attention — this app's
  reason to exist that the internal tool explicitly doesn't cover yet
  ("no notification channel yet... a human has to be looking at the fleet
  or device page," `outlet-alerts.md`, "Known limitations").
- Give simple guidance when something's wrong ("check the Mister's water
  reservoir"), not raw diagnostic detail (no "outlet index 2 mismatch
  since 14:32").
- Optionally show a lightweight history (e.g. "temperature over the last
  week") — much lighter than the internal tool's full scrub/reconstruct
  timeline, which is a debugging feature this audience doesn't need.

This is a consumer product: optimize for reassurance and clarity over
completeness. An owner should be able to glance at it and know "is my
animal's enclosure okay right now," not reconstruct exactly what happened
at 3:14pm on Tuesday.

## 2. Data source & the tenancy decision (the central open question)

Same underlying device data as this repo reads (`devices`/`logs`/
`telemetry`, plus this repo's own `outlet_alerts` if reusing that
lifecycle) — but the customer app **cannot** read it the way this repo
does (any authenticated user, whole fleet). Two real options, pick one
before writing any RLS:

**Option A — same Supabase project, new tenant-scoped policies.**
Add a `device_owners` (or similar) table mapping `device_id` →
`auth.users.id`, then write RLS policies on `devices`/`logs`/`telemetry`
scoped to `auth.uid()` owning that `device_id` — separate from (not
replacing) this repo's existing "any authenticated user" policies, since
both apps' Supabase Auth users must keep their current access. Simpler
ops (one project), but means two very different trust models coexisting
on the same tables — audit carefully that a customer-app policy can never
accidentally broaden what an internal-app policy already grants, or vice
versa.

**Option B — separate Supabase project**, with device data mirrored or
proxied in (e.g. a sync job, or a server-side API this app's backend
calls that itself holds the fleet credentials). Cleaner isolation, no risk
of policy interaction with the internal tool, but adds a sync/latency
layer and a second place `outlet_roles`/`profile_config` can drift out of
sync.

Whichever is chosen, **the device-ownership mapping doesn't exist yet
anywhere in this system** — firmware provisioning has no concept of a
customer. Decide where that pairing happens (a claim-code flow in the new
app? something added to firmware provisioning?) before building the
"my enclosure" home screen, since everything else depends on it.

**Known gotcha to carry over, not rediscover:** `devices` is upserted by
firmware via the anon/publishable key (`POST /rest/v1/devices?on_conflict=device_id`,
[`cloudlog-dataflow.md`](cloudlog-dataflow.md)). Postgres's `ON CONFLICT DO
UPDATE` requires genuine table-level `SELECT` to satisfy its internal
conflict check — revoking or column-scoping `anon`'s `SELECT` on `devices`
breaks the heartbeat itself, not just reads, even with `Prefer:
return=minimal`. This was tried live against this exact table and failed
twice (full revoke, then column-scoped grant) before being reverted — see
[`known-issues.md`](known-issues.md). Don't let a new RLS pass for
customer-tenancy re-break firmware's upsert path the same way.

**Auth:** real per-user Supabase Auth accounts (this is non-negotiable
here, unlike the internal tool's single-shared-team model) — self-serve
signup, not invite-only, since these are paying customers. Plan for
password reset, email verification, and (eventually) account/device
transfer if a customer replaces hardware or gives away an enclosure.

## 3. Reusable constants (don't re-tune these)

All from `src/lib/queries.ts`, already validated against real device
incidents (see `outlet-alerts.md` and inline comments for the specific
case each one fixed):

| Constant | Value | What it's for |
|---|---|---|
| `HEARTBEAT_INTERVAL_MS` | 5 min | `devices` row upsert cadence |
| `STALE_AFTER_MS` | 10 min (2× heartbeat) | device considered offline |
| telemetry cadence | ~60s | `telemetry` row cadence |
| `OUTLET_MISMATCH_DEBOUNCE_SAMPLES` | 2 samples | flip-then-log-lag debounce |
| `OUTLET_ACTUATION_GRACE_MS` | 90s | log-then-flip-lag debounce |
| `REBOOT_GRACE_MS` | 3 min | reconnect-flicker suppression after boot |
| `NEW_DEVICE_GRACE_MS` | 15 min | new-device pairing noise suppression |
| `ERROR_WINDOW_MS` / `WARNING_ERROR_COUNT` / `CRITICAL_ERROR_COUNT` | 24h / 1 / 5 | error-count health thresholds |

If the customer app's notification thresholds end up needing to differ
from these (e.g. a customer might tolerate a longer "give it a minute"
window than a staff member watching a live dashboard would), that's a
legitimate product decision — just make it a deliberate divergence, not an
accidental redefinition of the same-sounding constant.

## 4. Alert lifecycle — reuse the model, translate the language

This repo's `outlet_alerts` lifecycle (`outlet-alerts.md`) is a solid
starting model: open → escalated/closed (human) or auto_resolved (system,
only for outlets actually re-checked and found clean — never inferred from
silence). For a customer app:

- **"Escalate" doesn't make sense for an owner** — there's no one to
  escalate *to* inside their own view. Their only actions are more like
  "acknowledge" (I saw this, I'm on it) and whatever remediation guidance
  the app surfaces (§1). Decide whether escalation instead means
  "contact support," and if so, whether that's a real ticket/notification
  to your team.
- **auto_resolved should probably be invisible, not just same-colored.**
  Internally, `closed` and `auto_resolved` intentionally render as the same
  neutral badge, distinguished only by detail text (the previous
  cheatsheet in this project flags this explicitly for staff to notice). A
  customer likely shouldn't even see "auto_resolved" as a concept — if the
  system caught a problem and confirmed it cleared before the owner ever
  needed to act, that's a non-event, not a badge to explain.
- **Notifications are the actual product here.** Decide the channel(s)
  (push, email, SMS) and exactly which transitions notify (probably: a new
  `open` alert past some minimum severity/duration, definitely not every
  auto-resolve). This is net-new — nothing in this repo sends a
  notification anywhere yet.

## 5. Core features (v1)

1. **My enclosure(s)** — home view, one card per owned device: plain-
   language current status (fine / needs a look / needs attention now —
   reuse the internal tool's three-tier health rollup semantics, not its
   labels), current temp/humidity, at-a-glance outlet states with role
   icons (reuse `style-guide.md`'s device-icon visual language — it's
   designed to extend the physical device's own screen).
2. **Alerts, translated** — plain-language version of an open outlet
   mismatch (see §4), with guidance, not raw mismatch detail.
3. **Notifications** — push/email/SMS on the transitions decided in §4.
   Net-new infrastructure; nothing to port from this repo.
4. **Lightweight history** — a day/week temp+humidity chart, no scrubbing/
   reconstruction. If this grows into needing point-in-time state
   reconstruction, `src/lib/timeline.ts`'s reducer is directly reusable.
5. **Device pairing / claim flow** — whatever resolves the ownership
   question in §2. Doesn't exist anywhere in this system yet.
6. **Account & billing** — real signup, subscription/plan management if
   this is paid. Out of this brief's technical scope; flag early as its
   own workstream.

**Explicitly out of scope for v1** (mirrors this repo's own non-functional
notes, `monitoring-webapp-plan.md` §6): remote control of any outlet.
Everything here is read-only against device state, same trust-boundary
reasoning as the internal tool — a command channel to devices doesn't
exist today and is a different project.

## 6. Non-functional notes

- **Production reliability bar, not internal-tool bar.** Real migrations
  tooling (this repo's biggest process gap — every schema change here is
  "run this SQL by hand, once"), error boundaries on every route, and
  monitoring/alerting on the app itself. A customer hitting an unhandled
  crash is a support ticket, not a Slack message to whoever's online.
- **Tenant isolation is the load-bearing requirement.** Get an outside
  review of the RLS policies (or whatever access-control layer Option A/B
  in §2 lands on) before launch — a leak here means one customer seeing
  another's enclosure.
- **Retention windows still apply.** 60-day `logs` / 30-day `telemetry`
  purge is unchanged regardless of which app reads them — don't let a
  customer-facing history view silently promise more than that.
- **`outlet_roles`/`profile_config` are still current-snapshot-only on
  `devices`**, historized via `tag='config'` logs rows (`monitoring-webapp-plan.md`
  §3) — same caveat applies if this app ever reconstructs past state.

## 7. Open questions for whoever builds this

- Option A vs. B in §2 — same Supabase project with new tenant RLS, or a
  separate project/proxy layer? This decides almost everything else's
  shape.
- Where does device-to-owner pairing actually happen — a claim-code flow
  in this new app, or does firmware provisioning need to grow an owner
  concept upstream?
- Notification channel(s) and exact trigger conditions (§4) — and who owns
  that infrastructure (this app, or a shared notification service also
  used by the internal tool later)?
- Does "escalate" become "contact support" with a real ticket/notification
  to the team, or is it dropped entirely from the customer-facing action
  set?
- Multiple enclosures per account — is that a v1 requirement, or single-
  device-per-account to start?
- Any remote-control ambitions beyond v1 (e.g. "nudge the heater on
  early")? Flag now even if deferred — it changes the trust-boundary
  conversation in §5 later rather than being a surprise retrofit.
