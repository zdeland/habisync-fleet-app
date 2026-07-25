-- Run this by hand, once, against a project that already ran the old
-- supabase/outlet_alert_actors.sql (a view directly over auth.users,
-- flagged by Supabase's security advisor). See supabase/profiles.sql for
-- the fresh-install version of the schema this migrates to — this file
-- exists only because `create table`/the trigger aren't idempotent against
-- a project that already has the old view in place.

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

drop view if exists public.outlet_alert_actors;
