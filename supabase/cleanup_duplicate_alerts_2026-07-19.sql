-- One-off cleanup for the mismatch_since-drift reopen bug (fixed in
-- src/lib/alerts.ts's syncOutletAlerts) — before the fix, every closed
-- alert reopened as a "new" row within a couple of polls even when nothing
-- had actually changed, leaving a run of duplicate closed rows per
-- (device_id, outlet_index) for what was really one continuous episode.
--
-- A "duplicate" here = same device_id, outlet_index, actual_state, and
-- last_logged_at among status='closed' rows — those three staying
-- identical is exactly what the bug produced; a genuinely different
-- episode always changes at least one of them. Currently open/escalated
-- rows are never touched (the `status = 'closed'` filter throughout, plus
-- the app's own partial unique index, guarantees at most one non-closed
-- row per outlet already).
--
-- Within each duplicate group, keeps whichever row has escalated_at set
-- (so an escalation that happened partway through the churn isn't lost),
-- breaking ties by the earliest id (first time this episode was ever
-- closed) — deletes the rest of the group.
--
-- Run the SELECT first to see exactly what would be deleted. Optionally
-- add `and device_id = 'hs-2b93f4'` to either query to scope this to one
-- device instead of the whole fleet.

-- Preview — what this would delete:
select *
from public.outlet_alerts oa
where oa.status = 'closed'
  and oa.id <> (
    select keep.id
    from public.outlet_alerts keep
    where keep.status = 'closed'
      and keep.device_id = oa.device_id
      and keep.outlet_index = oa.outlet_index
      and keep.actual_state = oa.actual_state
      and keep.last_logged_at = oa.last_logged_at
    order by (keep.escalated_at is not null) desc, keep.id asc
    limit 1
  )
order by oa.device_id, oa.outlet_index, oa.detected_at;

-- Once the preview above looks right, run this:
-- delete from public.outlet_alerts oa
-- where oa.status = 'closed'
--   and oa.id <> (
--     select keep.id
--     from public.outlet_alerts keep
--     where keep.status = 'closed'
--       and keep.device_id = oa.device_id
--       and keep.outlet_index = oa.outlet_index
--       and keep.actual_state = oa.actual_state
--       and keep.last_logged_at = oa.last_logged_at
--     order by (keep.escalated_at is not null) desc, keep.id asc
--     limit 1
--   );
