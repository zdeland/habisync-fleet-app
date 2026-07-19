-- Webapp-owned workflow table — NOT part of the firmware repo's
-- scripts/supabase_schema.sql, and firmware never reads or writes it. See
-- docs/monitoring-webapp-plan.md §6 ("The app can still support
-- authenticated writes for notes and remediation actions in its own
-- workflow tables") and docs/outlet-alerts.md for the feature this backs.
--
-- Not wired up to a Supabase CLI/migrations setup (this repo has none) —
-- run this by hand once against the project's SQL editor, then keep it in
-- sync with this file for any future change.
--
-- Tracks the lifecycle of an outlet-mismatch "needs attention" alert (see
-- src/lib/queries.ts's computeOutletMismatches / getOutletAttention) from
-- detection through a human closing or escalating it.
create table public.outlet_alerts (
  id bigint generated always as identity primary key,
  device_id text not null references public.devices (device_id),
  outlet_index smallint not null,

  status text not null default 'open' check (status in ('open', 'escalated', 'closed')),

  -- Snapshot of the detected mismatch, taken when this alert (or its most
  -- recent re-open after a prior episode was closed) was created — kept
  -- even if the logs/telemetry this was computed from later age out of
  -- their own retention windows.
  role text not null,
  logged_state boolean not null,
  actual_state boolean not null,
  last_logged_message text not null,
  last_logged_at timestamptz not null,
  mismatch_since timestamptz not null,

  detected_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  closed_at timestamptz,
  closed_by uuid references auth.users (id),
  escalated_at timestamptz,
  escalated_by uuid references auth.users (id),
  note text
);

-- At most one *active* (non-closed) alert per outlet at a time — the app
-- upserts against this to stay idempotent across repeated detections
-- (every fleet/device page load, every 20s auto-refresh) instead of
-- creating a duplicate row each time the same ongoing mismatch is seen.
create unique index outlet_alerts_active_unique
  on public.outlet_alerts (device_id, outlet_index)
  where status <> 'closed';

-- RLS policies alone are NOT enough — they only restrict rows on top of a
-- base table-level GRANT that must exist first. This project's schema does
-- not auto-apply default privileges to new tables (see
-- docs/known-issues.md's devices/anon grant saga for the exact same
-- gotcha) — confirmed live: querying this table returned `42501 permission
-- denied` even after the policies below existed, until this GRANT was
-- added. `authenticated` only (never `anon` — this table isn't meant to be
-- publicly readable the way devices currently, reluctantly, is).
grant select, insert, update on public.outlet_alerts to authenticated;

alter table public.outlet_alerts enable row level security;

-- Same shared-team model as the rest of this app (monitoring-webapp-plan.md
-- §6: "no per-tenant isolation... every authenticated user can read the
-- whole fleet") — extended here to read/write on this table too.
create policy "authenticated read outlet_alerts"
  on public.outlet_alerts for select
  to authenticated
  using (true);

create policy "authenticated insert outlet_alerts"
  on public.outlet_alerts for insert
  to authenticated
  with check (true);

create policy "authenticated update outlet_alerts"
  on public.outlet_alerts for update
  to authenticated
  using (true)
  with check (true);
