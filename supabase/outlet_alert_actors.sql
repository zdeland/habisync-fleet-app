-- Minimal, read-only projection of auth.users so the device page's alert
-- history can show *who* closed/escalated an alert without exposing
-- anything else about a teammate's account (password hash, phone,
-- metadata, etc). Same shared-team model as the rest of this app (every
-- authenticated user can already read the whole fleet) — extended here to
-- let them see who else on the team acted on an alert.
--
-- Views execute with the *owner's* privileges by default in Postgres (not
-- the invoker's) — that's what lets `authenticated` query this despite
-- having no direct grant on auth.users itself. Not wired up to a Supabase
-- CLI/migrations setup (this repo has none) — run this by hand once
-- against the project's SQL editor, same as supabase/outlet_alerts.sql.
create view public.outlet_alert_actors as
select id, email from auth.users;

-- Same gotcha as outlet_alerts.sql: RLS/policies don't apply to views the
-- same way, but the base GRANT is still required — confirmed necessary
-- last time, not assumed this time.
grant select on public.outlet_alert_actors to authenticated;
