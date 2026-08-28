-- Webapp-owned workflow table — NOT part of the firmware repo's
-- scripts/supabase_schema.sql, and firmware never reads or writes it. See
-- docs/monitoring-webapp-plan.md §6 ("The app can still support
-- authenticated writes for notes and remediation actions in its own
-- workflow tables") and docs/climate-alerts.md for the feature this backs.
--
-- Not wired up to a Supabase CLI/migrations setup for its own schema — run
-- this by hand once against the project's SQL editor, then keep it in sync
-- with this file for any future change (same convention as
-- supabase/outlet_alerts.sql/supabase/profiles.sql).
--
-- The first genuinely per-user-scoped table in this app — every other RLS
-- policy in this schema is `using (true)` for the whole authenticated team
-- (docs/monitoring-webapp-plan.md §6: "no per-tenant isolation... every
-- authenticated user can read the whole fleet"). A favorite is inherently
-- personal, not fleet-shared, so this one is scoped to auth.uid() instead.
create table public.favorite_devices (
  user_id uuid not null references auth.users (id) on delete cascade,
  device_id text not null references public.devices (device_id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, device_id)
);

-- Same GRANT gotcha as outlet_alerts.sql/devices (docs/known-issues.md):
-- RLS policies alone are not enough without a base table-level GRANT first.
grant select, insert, delete on public.favorite_devices to authenticated;

alter table public.favorite_devices enable row level security;

create policy "users read own favorites"
  on public.favorite_devices for select
  to authenticated
  using (auth.uid() = user_id);

create policy "users insert own favorites"
  on public.favorite_devices for insert
  to authenticated
  with check (auth.uid() = user_id);

create policy "users delete own favorites"
  on public.favorite_devices for delete
  to authenticated
  using (auth.uid() = user_id);

-- No update policy/grant: toggling a favorite is insert-or-delete only,
-- never an update.
--
-- on delete cascade on both FKs (unlike outlet_alerts' stricter, no-cascade
-- FK to devices, which guards an audit trail): a favorite is disposable
-- metadata with no audit value, so deleting a user or a device should just
-- make their/its favorites vanish, not block the delete or leave orphans.
