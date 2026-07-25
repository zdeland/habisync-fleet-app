-- One-off migration for the new 'auto_resolved' outlet_alerts status (see
-- docs/outlet-alerts.md and src/lib/alerts.ts's syncOutletAlerts) — this
-- repo has no migrations runner, so this needs to be run by hand once
-- against the project's SQL editor. outlet_alerts.sql has already been
-- updated to match, for any future fresh install.
--
-- Adds a third terminal status ('auto_resolved', alongside 'closed') for
-- alerts the app itself determined are no longer mismatching, without a
-- human ever closing/escalating them — e.g. a reconnect-flicker alert from
-- a device reboot that settled back to matching within a poll or two. Kept
-- distinct from 'closed' (a human decision) so the alert history can show
-- which is which, and because the two behave differently if the same
-- mismatch recurs later: 'closed' stays closed (a real dismissal), while
-- 'auto_resolved' reopens as a fresh episode (the system's call, not a
-- person's, so it doesn't get to stick if proven wrong).

begin;

alter table public.outlet_alerts
  drop constraint outlet_alerts_status_check;

alter table public.outlet_alerts
  add constraint outlet_alerts_status_check
  check (status in ('open', 'escalated', 'auto_resolved', 'closed'));

alter table public.outlet_alerts
  add column if not exists auto_resolved_at timestamptz;

drop index if exists outlet_alerts_active_unique;

create unique index outlet_alerts_active_unique
  on public.outlet_alerts (device_id, outlet_index)
  where status not in ('closed', 'auto_resolved');

commit;
