-- Webapp-owned workflow table backing the favorite-device climate-alert
-- emails — see docs/climate-alerts.md for the full design. Mirrors
-- supabase/outlet_alerts.sql's shape (status lifecycle + partial unique
-- "at most one active row" index), but with a simpler open/resolved-only
-- lifecycle: no human close/escalate workflow here, just "still out of
-- range" vs "cleared."
--
-- Not wired up to a Supabase CLI/migrations setup for its own schema — run
-- this by hand once against the project's SQL editor, same convention as
-- every other file in this directory.
--
-- Scoped to (device_id, metric), NOT to the favoriting user — the alert
-- describes a real physical condition on the device, independent of who's
-- watching it. Sending is per-recipient (every current favoriter gets their
-- own email); the alert lifecycle itself is not per-recipient.
create table public.climate_alerts (
  id bigint generated always as identity primary key,
  device_id text not null references public.devices (device_id) on delete cascade,
  metric text not null check (metric in ('temp', 'humidity')),
  status text not null default 'open' check (status in ('open', 'resolved')),

  -- Lower bound of the contiguous out-of-range streak (walking back from the
  -- latest telemetry sample) that triggered this alert — same "at least
  -- since here" convention as outlet_alerts.mismatch_since. Derived by
  -- supabase/functions/_shared/climateDetection.ts from telemetry
  -- timestamps, not a fixed sample count (see that file for why).
  out_of_range_since timestamptz not null,

  -- Snapshot at detection/last-open time, for the email body only — the
  -- actual open/resolve decision always re-resolves thresholds fresh from
  -- the device's *current* profile_config every sweep, so editing the
  -- species profile mid-alert takes effect immediately rather than being
  -- stuck against a stale snapshot here.
  observed_value numeric not null,
  low_threshold numeric not null,
  high_threshold numeric not null,

  detected_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  resolved_at timestamptz,

  -- Rate-limiting: an email is sent exactly once per state transition, on
  -- the sweep that first observes it. If the send fails (SMTP down), this
  -- column stays null so the *next* sweep retries the send without
  -- inserting a duplicate row (the partial unique index below already
  -- guarantees that).
  opened_email_sent_at timestamptz,
  resolved_email_sent_at timestamptz
);

-- At most one active alert per (device, metric) — the Edge Function upserts
-- against this every sweep. No 'closed'/'escalated' states here (unlike
-- outlet_alerts): this lifecycle has no human workflow, just open/resolved.
create unique index climate_alerts_active_unique
  on public.climate_alerts (device_id, metric)
  where status = 'open';

grant select on public.climate_alerts to authenticated;

alter table public.climate_alerts enable row level security;

-- Same shared-team read model as outlet_alerts — only the Edge Function
-- (service_role, bypasses RLS/grants entirely) ever writes this table, so
-- there is no insert/update policy for `authenticated` at all.
create policy "authenticated read climate_alerts"
  on public.climate_alerts for select
  to authenticated
  using (true);
