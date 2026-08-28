-- Grants the climate-alerts Edge Function (which connects as `service_role`,
-- via the auto-injected SUPABASE_SERVICE_ROLE_KEY) the table privileges it
-- needs. See docs/climate-alerts.md.
--
-- Why this is needed: this Supabase project does NOT auto-apply default
-- privileges to `service_role` on tables (the same "grants aren't automatic
-- here" gotcha documented in docs/known-issues.md for the devices/anon
-- saga). Our other RLS policies grant `authenticated`, which covers the
-- browser-facing app, but the Edge Function runs as `service_role` — and
-- without these grants every sweep failed with
-- `42501 permission denied for table favorite_devices`. `service_role`
-- bypasses RLS (rolbypassrls), so table GRANTs alone are sufficient; no
-- policies are needed for it.
--
-- Run this by hand once against the project's SQL editor, same convention
-- as every other file in this directory. Idempotent — safe to re-run.

-- Read the two webapp-owned tables and the favorites/alert data.
grant select on public.favorite_devices to service_role;
grant select, insert, update on public.climate_alerts to service_role;

-- Read the recipient email projection (supabase/profiles.sql).
grant select on public.profiles to service_role;

-- Read firmware-owned tables (defined in the firmware repo's schema, not
-- here) — the function needs each favorited device's profile_config /
-- last_seen and its recent telemetry. service_role only, never exposed to
-- the browser.
grant select on public.devices to service_role;
grant select on public.telemetry to service_role;
