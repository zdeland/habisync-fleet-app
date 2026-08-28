-- Schedules the climate-alerts Edge Function (supabase/functions/climate-alerts)
-- to run once a minute. See docs/climate-alerts.md for the full design.
--
-- Run this by hand once against the project's SQL editor, same convention
-- as every other file in this directory — this project has no Supabase
-- CLI/migrations setup.
--
-- Supabase-hosted Postgres has both extensions pre-loaded in
-- shared_preload_libraries — a plain CREATE EXTENSION works here, unlike a
-- self-hosted install. Safe to re-run (idempotent via `if not exists`).
create extension if not exists pg_cron with schema extensions;
create extension if not exists pg_net with schema extensions;

-- Every minute: tight enough that a device isn't allowed to sit meaningfully
-- longer than ~3-4 real minutes out of range before an alert fires, without
-- being wastefully frequent. pg_cron's schedule grammar has no sub-minute
-- granularity anyway.
--
-- The two placeholders below are NOT real secrets — replace both with the
-- real project ref and CRON_SHARED_SECRET value (see the "New secrets"
-- table in docs/climate-alerts.md) only in the SQL editor when actually
-- running this, and never commit the real values back into this file, same
-- spirit as this repo's other hand-applied grants (docs/known-issues.md).
select cron.schedule(
  'climate-alerts-sweep',
  '* * * * *',
  $$
  select net.http_post(
    url := 'https://<project-ref>.supabase.co/functions/v1/climate-alerts',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'X-Cron-Secret', '<CRON_SHARED_SECRET value>'
    ),
    body := '{}'::jsonb
  );
  $$
);

-- To change the schedule or secret later, unschedule and re-run:
-- select cron.unschedule('climate-alerts-sweep');
