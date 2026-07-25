-- Minimal, synced projection of auth.users (id, email) so the device
-- page's alert history can show *who* closed/escalated an alert without
-- exposing anything else about a teammate's account (password hash, phone,
-- metadata, etc). Same shared-team model as the rest of this app (every
-- authenticated user can already read the whole fleet) — extended here to
-- let them see who else on the team acted on an alert.
--
-- Supersedes outlet_alert_actors.sql's view-over-auth.users approach:
-- Supabase's security advisor flags any view/matview selecting from
-- auth.users as exposing it to anon/authenticated, regardless of how
-- narrow the columns or grant are. A plain table kept in sync via trigger
-- has the identical exposure (id+email, authenticated only — signups are
-- invite-only, see src/app/invite/actions.ts) without tripping that check.
--
-- Not wired up to a Supabase CLI/migrations setup (this repo has none) —
-- run this by hand once against the project's SQL editor, same as
-- supabase/outlet_alerts.sql. If outlet_alert_actors already exists from
-- before this change, run
-- supabase/replace_outlet_alert_actors_with_profiles_2026-07-22.sql instead.

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text
);

alter table public.profiles enable row level security;
grant select on public.profiles to authenticated;
create policy profiles_read on public.profiles for select to authenticated using (true);

insert into public.profiles (id, email)
select id, email from auth.users
on conflict (id) do nothing;

-- Runs as the function owner (postgres), which can read auth.users — the
-- app itself never gets a grant on auth.users directly.
create or replace function public.sync_profile_from_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email)
  values (new.id, new.email)
  on conflict (id) do update set email = excluded.email;
  return new;
end;
$$;

create trigger on_auth_user_upserted
  after insert or update of email on auth.users
  for each row execute procedure public.sync_profile_from_auth_user();
