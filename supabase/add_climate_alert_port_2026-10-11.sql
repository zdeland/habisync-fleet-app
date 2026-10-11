-- One-off migration for HabiSync 1.0 per-tank climate alerts (firmware
-- 1.3.0+, docs/climate-alerts.md "HabiSync 1.0 tanks"). This repo has no
-- migrations runner, so run it by hand once against the project's SQL
-- editor — before deploying the climate-alerts version that writes `port`.
-- (If the function goes first, devkit alerts are unaffected — it only sends
-- `port` for a 1.x tank — and each tank's sweep logs an error until this
-- has run.) climate_alerts.sql has already been updated to match, for any
-- future fresh install.
--
-- A 1.3.0 unit writes one telemetry row per probe per minute, each tank
-- with its own target band, so an alert is now per (device, metric, port).
-- `port` is null for a devkit unit and for a 1.x unit before 1.3.0 (one
-- series, the device's reading) — so the "at most one open alert" index
-- has to treat null as a value, which a plain unique index doesn't.

begin;

alter table public.climate_alerts
  add column if not exists port int2;

drop index if exists climate_alerts_active_unique;

create unique index climate_alerts_active_unique
  on public.climate_alerts (device_id, metric, coalesce(port, -1))
  where status = 'open';

commit;
