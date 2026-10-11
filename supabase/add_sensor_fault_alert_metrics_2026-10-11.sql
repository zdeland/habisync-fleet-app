-- One-off migration for firmware 0.35.0 sensor-fault alert emails (see
-- docs/climate-alerts.md, "Sensor faults"). This repo has no migrations
-- runner, so run it by hand once against the project's SQL editor —
-- BEFORE deploying the climate-alerts Edge Function version that writes
-- these metrics. (If the function goes first, its sensor-fault inserts fail
-- this CHECK; that path is isolated and logs the error, so the range alerts
-- keep working, but no sensor email goes out until this has run.)
-- climate_alerts.sql has already been updated to match, for any future
-- fresh install.
--
-- Two new metric values, one per channel. Each is a latch the device logs
-- itself, not a range check, but the open/resolved lifecycle and the
-- per-recipient notification ledger are exactly the same, so they share the
-- table rather than growing a second one.
--
-- Also run grant_service_role_logs.sql: the sweep now reads `logs`.

begin;

alter table public.climate_alerts
  drop constraint climate_alerts_metric_check;

alter table public.climate_alerts
  add constraint climate_alerts_metric_check
  check (metric in ('temp', 'humidity', 'temp_sensor', 'humidity_sensor'));

commit;
