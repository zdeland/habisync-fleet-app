-- Per-recipient notification ledger for climate_alerts — records which user
-- was emailed for which alert, and which kind (the "out of range" open email
-- vs the "back in range" resolve email). See docs/climate-alerts.md.
--
-- Why this exists: without it, de-dup was per-alert-row (climate_alerts'
-- opened_email_sent_at), so once an alert's open email had been sent, nobody
-- else was ever emailed for that episode — a user who favorited the device
-- mid-alert never got caught up. This ledger makes the sweep notify any
-- current favoriter who is missing an 'opened' row, so new favoriters are
-- alerted on their next cycle. It also lets the resolve email go to exactly
-- the users who got the open email (no more "back in range" for an alert you
-- were never told about).
--
-- Run this by hand once against the project's SQL editor, same convention as
-- every other file in this directory. Only the climate-alerts Edge Function
-- (service_role) ever touches this table.
create table public.climate_alert_notifications (
  alert_id bigint not null references public.climate_alerts (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  kind text not null check (kind in ('opened', 'resolved')),
  sent_at timestamptz not null default now(),
  -- One row per (alert, user, kind): the presence of a row IS the "already
  -- notified" fact the sweep checks, and the PK makes a concurrent double
  -- send a harmless 23505 rather than a duplicate email record.
  primary key (alert_id, user_id, kind)
);

-- service_role only (the Edge Function). The browser-facing app never reads
-- this table, so no `authenticated` grant. service_role bypasses RLS, so
-- table GRANTs alone suffice; RLS is enabled (no policies) to keep the table
-- from being exposed should a grant ever be widened by mistake.
grant select, insert on public.climate_alert_notifications to service_role;
alter table public.climate_alert_notifications enable row level security;
