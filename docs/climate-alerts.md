# Climate alerts: emailing favorited-device owners when temp/humidity strays

## What this is

A user can mark a device as a favorite (star icon on the fleet page). When a
favorited device's temperature or humidity has been outside its
species-profile target range for more than `SUSTAINED_OUT_OF_RANGE_MS`
(3 minutes), every user who favorited it gets an email. When the reading
returns to range, they get a second "back in range" email.

Unlike everything else in this app, this genuinely needed new
infrastructure: the rest of the app is purely request-driven (every
computation runs fresh on SSR page load, refreshed only by
`src/components/AutoRefresh.tsx`'s client-side 20s timer). An email that
fires even when nobody has the app open needs something running
independent of any page view — a scheduled sweep, not a page read.

## Architecture

- **Scheduler**: Supabase `pg_cron` (`supabase/climate_alerts_cron.sql`),
  once a minute, calling `net.http_post` against the deployed Edge Function.
- **Detection + email**: `supabase/functions/climate-alerts/index.ts`, a
  Deno Edge Function — the first one in this repo.
- **Pure detection logic**: `supabase/functions/_shared/climateDetection.ts`
  — deliberately dependency-free (no Deno-only or Node-only APIs) so the
  exact same file is imported by the Edge Function (Deno) and by
  `test/climateDetection.test.ts` (Node, via this repo's existing
  `tsx --test` runner).
- **Data model**: `supabase/favorite_devices.sql` (who favorited what) and
  `supabase/climate_alerts.sql` (the open/resolved alert lifecycle, mirrors
  `outlet_alerts.sql`'s shape).
- **Favoriting UI**: the ★/☆ toggle in `src/components/FleetTable.tsx`,
  backed by `src/app/actions/favorites.ts`'s `toggleFavoriteDevice` Server
  Action and `src/lib/favorites.ts`'s `getFavoriteDeviceIds`.

## Why an Edge Function has to talk to SMTP directly

Supabase's Auth SMTP config (Dashboard → Auth → SMTP Settings) is wired
*only* into Supabase Auth's own templated emails (magic link, invite,
password reset — the same call this app already makes via
`admin.auth.admin.inviteUserByEmail` in `src/app/invite/actions.ts`). There
is no API that lets other code send an arbitrary custom email "through"
that same configured SMTP connection, and Supabase doesn't expose those
credentials for reading back out either.

So the Edge Function opens its own SMTP connection directly (via
`denomailer`, a Deno SMTP client), authenticating with the same
host/port/username/password already entered into the Auth SMTP settings —
re-entered as Edge Function secrets via `supabase secrets set`. The
password ends up living in two places (Auth settings + Edge Function
secret store); that's unavoidable given the platform, not a shortcut.

## Detection: time-window based, not sample-count based

Telemetry normally flushes every ~30–60s but can back off to every 5
minutes on a network hiccup (`docs/cloudlog-dataflow.md`). A fixed
sample-count debounce (like `computeOutletMismatches`' 2-sample window)
would give a wildly different real duration depending on cadence, so
`detectSustainedCondition` instead walks backward from the latest sample,
requiring both:
- every intervening sample to still violate the condition, and
- no gap between two *consecutive* samples wider than `MAX_SAMPLE_GAP_MS`
  (6 min — a bit past the documented worst-case backoff).

A gap wider than that breaks the streak rather than bridging across it — a
real disconnect isn't "sustained out of range," it's unknown; the device
could have swung back into range and out again during the gap.

## Two-layer defense against a disconnected device

A device that's actually offline must never generate a false alert off its
last known (now stale) reading. Two independent checks catch different
failure windows:

1. **Device-level stale skip** (Edge Function, mirrors
   `src/lib/queries.ts`'s `STALE_AFTER_MS`, 10 min since `last_seen`): a
   coarse, whole-device gate checked before looking at telemetry at all. If
   the device hasn't heartbeated in 10+ minutes it's presumed fully
   offline and skipped entirely this sweep.
2. **`MAX_SAMPLE_GAP_MS` inside the detector** (6 min, between consecutive
   telemetry samples): a finer-grained check for a device that's still
   heartbeating fine (so it never trips the stale skip) but whose
   *telemetry* stream had a shorter gap from a network backoff.

Neither alone is sufficient: a device can have a ~5.5-minute telemetry gap
(long enough to create a false streak) while comfortably under the
10-minute stale threshold, since heartbeat and telemetry are pushed on
separate cadences — the stale check alone wouldn't catch that. Conversely a
device dark for an hour needs excluding outright before any per-sample gap
math runs.

## Reconciliation model (mirrors `src/lib/alerts.ts`'s `syncOutletAlerts`)

Per `(device_id, metric)`, each sweep:
- No open row + sustained violation → insert `status: 'open'`, email every
  current favoriter individually (not one CC'd message), record
  `opened_email_sent_at` on success.
- Open row but the send previously failed (`opened_email_sent_at` still
  null) → retry the send without inserting a duplicate row (the partial
  unique index on `(device_id, metric) where status = 'open'` already
  prevents that).
- Open row + still violating → no resend; already notified.
- Open row + latest reading back in range → resolve, email the "back in
  range" notice, mark `status: 'resolved'`. Non-sticky: a later fresh
  episode opens a brand-new row, same spirit as `outlet_alerts`'
  `auto_resolved`.

Thresholds are re-resolved fresh from the device's *current*
`profile_config` every sweep — the `low_threshold`/`high_threshold` columns
on `climate_alerts` are a point-in-time snapshot for the email body only,
so widening a species profile's range correctly resolves an open alert on
the very next pass with no special-casing needed.

## Extensibility — adding a new alert type later

**A new range-based metric** (e.g. RSSI signal strength or free heap memory
dropping out of a healthy band): widen `climate_alerts`' `metric` CHECK
constraint via a short dated migration file (this repo already has this
exact precedent — `supabase/add_auto_resolved_status_2026-07-21.sql` added
a new `outlet_alerts.status` value the same way), add one more
resolve-thresholds-and-detect block in `climate-alerts/index.ts` mirroring
the existing temp/humidity ones, add an email-copy case. No table redesign,
no change to favorites/cron/reconciliation/email-sending.

**A non-range condition** (e.g. "device went offline," "outlet alert
escalated"): `detectSustainedCondition` takes an
`isViolating: (value) => boolean` predicate rather than hardcoded
low/high, specifically so a boolean-flag condition reuses the identical
walk-backward/gap engine with a different one-line predicate — only the
Edge Function's per-metric block and the email copy change.

## Edge cases

- **Device deleted while favorited/alerted**: both `favorite_devices` and
  `climate_alerts` use `on delete cascade` (looser than `outlet_alerts`'
  no-cascade FK — no audit-trail value here).
- **Null `profiles.email`**: skipped at send time with a `console.warn`;
  doesn't block other favoriters of the same device.
- **Multiple favoriters**: each gets their own individually-addressed
  email, never one shared CC.
- **Favoriting mid-open-alert**: no email until that alert resolves and a
  fresh one opens later — `opened_email_sent_at` is alert-row-scoped, not
  per-recipient. Accepted simplification; a per-recipient notification
  ledger would fix it but isn't justified by the requirements as given.

## Operating it

See the README's "Climate alerts" section for the deploy/secrets/cron
runbook.
