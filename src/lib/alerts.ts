import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, OutletAlertRow } from '@/lib/types';

export type OutletAlertHistoryEntry = OutletAlertRow & {
  closedByEmail: string | null;
  escalatedByEmail: string | null;
};

// Input shape both getFleetHealth (fleet-wide, cheaper/coarser) and
// getOutletAttention (single-device, richer) can produce — syncOutletAlerts
// doesn't care which computed it, only that it matches the live detection
// in src/lib/queries.ts's computeOutletMismatches.
export type AlertSnapshot = {
  outletIndex: number;
  role: string;
  loggedState: boolean;
  actualState: boolean;
  lastLoggedMessage: string;
  lastLoggedAt: string;
  mismatchSince: string;
};

function newAlertRow(deviceId: string, snapshot: AlertSnapshot): Partial<OutletAlertRow> {
  return {
    device_id: deviceId,
    outlet_index: snapshot.outletIndex,
    status: 'open',
    role: snapshot.role,
    logged_state: snapshot.loggedState,
    actual_state: snapshot.actualState,
    last_logged_message: snapshot.lastLoggedMessage,
    last_logged_at: snapshot.lastLoggedAt,
    mismatch_since: snapshot.mismatchSince,
  };
}

// Reconciles live-detected mismatches against the persisted outlet_alerts
// table (supabase/outlet_alerts.sql), so a mismatch shows up as a
// close/escalate-able alert as soon as it's detected, without a human
// having to open the device page first.
//
// Never touches `status` on an existing open/escalated row for a *human*
// decision — that only ever changes via closeOutletAlert/escalateOutletAlert.
// It does, however, auto-resolve one when `checkedOutletIndexes` (every
// outlet actually evaluated this pass — see computeOutletMismatches) proves
// its outlet is no longer mismatching: e.g. a reconnect-flicker alert from a
// device reboot that settled back to matching within a poll or two. That's
// `status: 'auto_resolved'`, kept distinct from a human 'closed' — see
// docs/outlet-alerts.md for why the two behave differently on recurrence.
// An outlet not present in `checkedOutletIndexes` at all (grace period, not
// enough samples) is left untouched either way — silence isn't evidence.
//
// Closing an alert dismisses that specific episode. If the *same* mismatch
// (same mismatch_since) is detected again later, it stays closed — closing
// is a real dismissal, not a snooze. A genuinely new episode (a different
// mismatch_since — the old one resolved and a new one started) opens a
// fresh alert even if the last one for this outlet was closed. An
// auto-resolved alert has no such stickiness: the system, not a person,
// made that call, so a recurrence just reopens it as fresh evidence.
export async function syncOutletAlerts(
  supabase: SupabaseClient<Database>,
  deviceId: string,
  snapshots: AlertSnapshot[],
  checkedOutletIndexes: number[],
): Promise<void> {
  if (checkedOutletIndexes.length === 0) return;

  const { data: existingRows, error } = await supabase
    .from('outlet_alerts')
    .select('*')
    .eq('device_id', deviceId)
    .in('outlet_index', checkedOutletIndexes)
    .order('id', { ascending: false });

  if (error) throw error;

  const latestByOutlet = new Map<number, OutletAlertRow>();
  for (const row of existingRows ?? []) {
    if (!latestByOutlet.has(row.outlet_index)) {
      latestByOutlet.set(row.outlet_index, row);
    }
  }

  const mismatchingIndexes = new Set(snapshots.map((s) => s.outletIndex));
  const toInsert: Partial<OutletAlertRow>[] = [];
  const toUpdate: { id: number; changes: Partial<OutletAlertRow> }[] = [];
  const now = new Date().toISOString();

  for (const snapshot of snapshots) {
    const existing = latestByOutlet.get(snapshot.outletIndex);

    if (!existing) {
      toInsert.push(newAlertRow(deviceId, snapshot));
      continue;
    }

    if (existing.status === 'closed') {
      // Same episode iff the outlet is still in the same actual state AND
      // the last logged event for it hasn't changed — both are stable
      // snapshot values that only move when something real happens.
      // mismatch_since is NOT used for this: it's a best-effort "at least
      // since here" display estimate derived from a sliding telemetry
      // window, so it drifts forward on every single poll even while the
      // same mismatch continues uninterrupted — comparing it for equality
      // reopened every closed alert within a couple of polls.
      const sameEpisode =
        existing.actual_state === snapshot.actualState && existing.last_logged_at === snapshot.lastLoggedAt;
      if (!sameEpisode) {
        toInsert.push(newAlertRow(deviceId, snapshot));
      }
      continue;
    }

    if (existing.status === 'auto_resolved') {
      // Not sticky like a human close — proof the mismatch is back means
      // the auto-resolve call was wrong, so always reopen fresh rather than
      // checking sameEpisode.
      toInsert.push(newAlertRow(deviceId, snapshot));
      continue;
    }

    // A more accurate (earlier) mismatch_since can arrive later — e.g. the
    // fleet-wide pass only has a shallow 2-sample debounce window to guess
    // from, while the device page's getOutletAttention scans much further
    // back. Only ever refine it earlier, never later — an episode's start
    // doesn't move forward just because a shallower pass ran again.
    const refinedMismatchSince =
      new Date(snapshot.mismatchSince).getTime() < new Date(existing.mismatch_since).getTime()
        ? snapshot.mismatchSince
        : null;

    const changed =
      existing.logged_state !== snapshot.loggedState ||
      existing.actual_state !== snapshot.actualState ||
      existing.last_logged_message !== snapshot.lastLoggedMessage ||
      existing.last_logged_at !== snapshot.lastLoggedAt ||
      refinedMismatchSince != null;
    if (changed) {
      toUpdate.push({
        id: existing.id,
        changes: {
          logged_state: snapshot.loggedState,
          actual_state: snapshot.actualState,
          last_logged_message: snapshot.lastLoggedMessage,
          last_logged_at: snapshot.lastLoggedAt,
          ...(refinedMismatchSince != null ? { mismatch_since: refinedMismatchSince } : {}),
          updated_at: now,
        },
      });
    }
  }

  // Auto-resolve: an outlet we actually checked this pass, that has an
  // open/escalated alert, but is no longer among the mismatching outlets.
  latestByOutlet.forEach((existing, outletIndex) => {
    if (mismatchingIndexes.has(outletIndex)) return;
    if (existing.status !== 'open' && existing.status !== 'escalated') return;
    toUpdate.push({
      id: existing.id,
      changes: { status: 'auto_resolved', auto_resolved_at: now, updated_at: now },
    });
  });

  await Promise.all([
    // One insert per row (not a single batched insert) so a unique-index
    // conflict from a concurrent request (another tab's fleet/device page
    // load racing this one) only drops that one row — the next 20s
    // auto-refresh sees the row the other request created and stops
    // inserting — rather than failing the whole batch atomically.
    ...toInsert.map(async (row) => {
      const { error: insertError } = await supabase.from('outlet_alerts').insert(row);
      if (insertError && insertError.code !== '23505') throw insertError;
    }),
    ...toUpdate.map(({ id, changes }) => supabase.from('outlet_alerts').update(changes).eq('id', id)),
  ]);
}

// Active (open/escalated) alerts for the given devices, grouped by
// device_id — what the fleet table's separate attention column and the
// device page's attention card both render. Excludes both terminal statuses:
// 'closed' (a human dismissal) and 'auto_resolved' (the system found the
// mismatch cleared on its own) — neither needs anyone looking at it.
export async function getActiveOutletAlerts(
  supabase: SupabaseClient<Database>,
  deviceIds: string[],
): Promise<Map<string, OutletAlertRow[]>> {
  if (deviceIds.length === 0) return new Map();

  const { data, error } = await supabase
    .from('outlet_alerts')
    .select('*')
    .in('device_id', deviceIds)
    .neq('status', 'closed')
    .neq('status', 'auto_resolved')
    .order('detected_at', { ascending: true });

  if (error) throw error;

  const byDevice = new Map<string, OutletAlertRow[]>();
  for (const row of data ?? []) {
    const rows = byDevice.get(row.device_id) ?? [];
    rows.push(row);
    byDevice.set(row.device_id, rows);
  }
  return byDevice;
}

// Full history (every status, newest first) for one device — what the
// device page's "Alert history" section renders. Unlike
// getActiveOutletAlerts (fleet-wide, active-only), this includes closed
// rows and resolves closed_by/escalated_by to an email via profiles
// (supabase/profiles.sql) so the list can show who acted, not just a user
// id.
export async function getOutletAlertHistory(
  supabase: SupabaseClient<Database>,
  deviceId: string,
): Promise<OutletAlertHistoryEntry[]> {
  const { data, error } = await supabase
    .from('outlet_alerts')
    .select('*')
    .eq('device_id', deviceId)
    .order('detected_at', { ascending: false });

  if (error) throw error;

  const rows = data ?? [];
  const actorIds = Array.from(
    new Set(rows.flatMap((row) => [row.closed_by, row.escalated_by]).filter((id): id is string => id != null)),
  );

  const emailById = new Map<string, string | null>();
  if (actorIds.length > 0) {
    const { data: actors, error: actorsError } = await supabase
      .from('profiles')
      .select('*')
      .in('id', actorIds);
    if (actorsError) throw actorsError;
    for (const actor of actors ?? []) {
      emailById.set(actor.id, actor.email);
    }
  }

  return rows.map((row) => ({
    ...row,
    closedByEmail: row.closed_by ? emailById.get(row.closed_by) ?? null : null,
    escalatedByEmail: row.escalated_by ? emailById.get(row.escalated_by) ?? null : null,
  }));
}
