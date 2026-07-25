import { test } from 'node:test';
import assert from 'node:assert/strict';
import { syncOutletAlerts, type AlertSnapshot } from '../src/lib/alerts';
import type { Database, OutletAlertRow } from '../src/lib/types';
import type { SupabaseClient } from '@supabase/supabase-js';

// Minimal fake covering only the outlet_alerts query shapes syncOutletAlerts
// actually issues (select/eq/in/order, insert, update/eq) — not a general
// postgrest-js mock. Good enough to exercise the auto-resolve logic without
// a real Supabase project.
function makeFakeSupabase(initialRows: Partial<OutletAlertRow>[]) {
  let rows: Partial<OutletAlertRow>[] = initialRows.map((r) => ({ ...r }));
  let nextId = 1 + rows.reduce((max, r) => Math.max(max, (r.id as number) ?? 0), 0);

  function outletAlertsTable() {
    return {
      select(_cols: string) {
        let filtered = rows;
        const builder = {
          eq(col: string, val: unknown) {
            filtered = filtered.filter((r) => (r as Record<string, unknown>)[col] === val);
            return builder;
          },
          in(col: string, vals: unknown[]) {
            filtered = filtered.filter((r) => vals.includes((r as Record<string, unknown>)[col]));
            return builder;
          },
          neq(col: string, val: unknown) {
            filtered = filtered.filter((r) => (r as Record<string, unknown>)[col] !== val);
            return builder;
          },
          order(col: string, opts: { ascending: boolean }) {
            filtered = [...filtered].sort((a, b) => {
              const av = (a as Record<string, unknown>)[col] as number;
              const bv = (b as Record<string, unknown>)[col] as number;
              return opts.ascending ? av - bv : bv - av;
            });
            return builder;
          },
          then(resolve: (result: { data: Partial<OutletAlertRow>[]; error: null }) => void) {
            resolve({ data: filtered, error: null });
          },
        };
        return builder;
      },
      insert(row: Partial<OutletAlertRow>) {
        const withId = { id: nextId++, ...row };
        const conflict = rows.some(
          (r) =>
            r.device_id === withId.device_id &&
            r.outlet_index === withId.outlet_index &&
            r.status !== 'closed' &&
            r.status !== 'auto_resolved',
        );
        if (conflict) return Promise.resolve({ data: null, error: { code: '23505' } });
        rows.push(withId);
        return Promise.resolve({ data: [withId], error: null });
      },
      update(changes: Partial<OutletAlertRow>) {
        return {
          eq(col: string, val: unknown) {
            rows = rows.map((r) => ((r as Record<string, unknown>)[col] === val ? { ...r, ...changes } : r));
            return Promise.resolve({ data: null, error: null });
          },
        };
      },
    };
  }

  const client = {
    from(table: string) {
      if (table !== 'outlet_alerts') throw new Error(`fake supabase: unexpected table ${table}`);
      return outletAlertsTable();
    },
  };

  return { client: client as unknown as SupabaseClient<Database>, rows: () => rows };
}

function makeSnapshot(overrides: Partial<AlertSnapshot> = {}): AlertSnapshot {
  return {
    outletIndex: 0,
    role: 'Mister',
    loggedState: true,
    actualState: false,
    lastLoggedMessage: 'Mister [0] turned ON — humidity below target range',
    lastLoggedAt: '2026-07-21T15:00:00.000Z',
    mismatchSince: '2026-07-21T15:05:00.000Z',
    ...overrides,
  };
}

function makeOpenAlert(overrides: Partial<OutletAlertRow> = {}): Partial<OutletAlertRow> {
  return {
    id: 1,
    device_id: 'hs-2b93f4',
    outlet_index: 0,
    status: 'open',
    role: 'Mister',
    logged_state: true,
    actual_state: false,
    last_logged_message: 'Mister [0] turned ON — humidity below target range',
    last_logged_at: '2026-07-21T15:00:00.000Z',
    mismatch_since: '2026-07-21T15:05:00.000Z',
    detected_at: '2026-07-21T15:05:00.000Z',
    updated_at: '2026-07-21T15:05:00.000Z',
    closed_at: null,
    closed_by: null,
    escalated_at: null,
    escalated_by: null,
    auto_resolved_at: null,
    note: null,
    ...overrides,
  };
}

test('auto-resolves an open alert whose outlet was checked this pass and is no longer mismatching', async () => {
  const { client, rows } = makeFakeSupabase([makeOpenAlert()]);

  await syncOutletAlerts(client, 'hs-2b93f4', [], [0]);

  const row = rows().find((r) => r.outlet_index === 0);
  assert.equal(row?.status, 'auto_resolved');
  assert.notEqual(row?.auto_resolved_at, null);
});

test('leaves an open alert alone if its outlet was not checked this pass', async () => {
  const { client, rows } = makeFakeSupabase([makeOpenAlert({ outlet_index: 1 })]);

  // Only outlet 0 was evaluated this pass — outlet 1's silence isn't evidence.
  await syncOutletAlerts(client, 'hs-2b93f4', [], [0]);

  const row = rows().find((r) => r.outlet_index === 1);
  assert.equal(row?.status, 'open');
  assert.equal(row?.auto_resolved_at, null);
});

test('does not touch an already-closed alert when its outlet stops mismatching', async () => {
  const { client, rows } = makeFakeSupabase([makeOpenAlert({ status: 'closed', closed_at: '2026-07-21T14:00:00.000Z' })]);

  await syncOutletAlerts(client, 'hs-2b93f4', [], [0]);

  const row = rows().find((r) => r.outlet_index === 0);
  assert.equal(row?.status, 'closed');
});

test('a recurring mismatch reopens fresh rather than reusing an auto_resolved row', async () => {
  const { client, rows } = makeFakeSupabase([makeOpenAlert({ status: 'auto_resolved', auto_resolved_at: '2026-07-21T15:10:00.000Z' })]);

  await syncOutletAlerts(client, 'hs-2b93f4', [makeSnapshot()], [0]);

  const forOutlet0 = rows().filter((r) => r.outlet_index === 0);
  assert.equal(forOutlet0.length, 2); // the old auto_resolved row, plus a fresh open one
  assert.ok(forOutlet0.some((r) => r.status === 'auto_resolved'));
  assert.ok(forOutlet0.some((r) => r.status === 'open'));
});

test('a recurring mismatch with the same episode stays closed (human dismissal is sticky)', async () => {
  const { client, rows } = makeFakeSupabase([
    makeOpenAlert({ status: 'closed', closed_at: '2026-07-21T15:20:00.000Z' }),
  ]);

  await syncOutletAlerts(client, 'hs-2b93f4', [makeSnapshot()], [0]);

  const forOutlet0 = rows().filter((r) => r.outlet_index === 0);
  assert.equal(forOutlet0.length, 1);
  assert.equal(forOutlet0[0].status, 'closed');
});

test('does nothing when nothing was checked this pass', async () => {
  const { client, rows } = makeFakeSupabase([makeOpenAlert()]);

  await syncOutletAlerts(client, 'hs-2b93f4', [], []);

  const row = rows().find((r) => r.outlet_index === 0);
  assert.equal(row?.status, 'open');
});
