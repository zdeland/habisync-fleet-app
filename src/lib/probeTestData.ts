// Loads one device's probe cap test sessions, and the rows one session's
// report needs — the same reads as the firmware repo's
// scripts/probe_test_report.py --latest. The analysis is src/lib/probeTest.ts.
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, Device, LogRow } from '@/lib/types';
import { fetchTelemetryPages } from '@/lib/timeline';
import {
  analyzeProbeTest,
  sessionsFromLogs,
  sessionWindow,
  type ProbeTestReport,
  type ProbeTestSession,
} from '@/lib/probeTest';

// The longest test is 24h: 4 probes x 1,440 minutes, with room to spare.
const TELEMETRY_ROW_LIMIT = 8_000;
// The script reads telemetry up to 10 minutes past the window's end, by
// created_at, then trims by sample time — a batch uploads up to ~30s late,
// and a backlog after an outage much later.
const UPLOAD_SLACK_MS = 10 * 60_000;

export type ProbeTestPageData = {
  device: Device;
  sessions: ProbeTestSession[];
  selected: ProbeTestSession | null;
  window: { since: string; until: string } | null;
  report: ProbeTestReport | null;
};

export async function getProbeTestData(
  supabase: SupabaseClient<Database>,
  deviceId: string,
  sessionId: string | undefined,
  nowIso: string,
): Promise<ProbeTestPageData | null> {
  const { data: device, error: deviceError } = await supabase
    .from('devices')
    .select('*')
    .eq('device_id', deviceId)
    .maybeSingle();
  if (deviceError) throw deviceError;
  if (!device) return null;

  const { data: sessionRows, error: sessionError } = await supabase
    .from('logs')
    .select('*')
    .eq('device_id', deviceId)
    .eq('tag', 'probetest')
    .order('created_at', { ascending: false })
    .limit(1000);
  if (sessionError) throw sessionError;

  const sessions = sessionsFromLogs(sessionRows ?? []);
  // Default to the newest session that wasn't abandoned — a `stop` is
  // usually a restart, and its real successor is the one worth reading.
  const selected =
    (sessionId ? sessions.find((s) => s.id === sessionId) : sessions.find((s) => s.status !== 'abandoned')) ??
    sessions[0] ??
    null;
  if (!selected) return { device, sessions, selected: null, window: null, report: null };

  const window = sessionWindow(selected, nowIso);
  const fetchRange = {
    from: window.since,
    to: new Date(new Date(window.until).getTime() + UPLOAD_SLACK_MS).toISOString(),
  };
  const [{ data: telemetry, error: telemetryError }, { data: references, error: referenceError }] = await Promise.all([
    fetchTelemetryPages(supabase, deviceId, fetchRange, TELEMETRY_ROW_LIMIT, { probesOnly: true }),
    supabase
      .from('logs')
      .select('*')
      .eq('device_id', deviceId)
      .eq('tag', 'reference')
      .gte('created_at', fetchRange.from)
      .lte('created_at', fetchRange.to)
      .order('created_at', { ascending: true })
      .limit(1000),
  ]);
  if (telemetryError) throw telemetryError;
  if (referenceError) throw referenceError;

  const report = analyzeProbeTest(telemetry ?? [], (references ?? []) as LogRow[], window, selected.id);
  return { device, sessions, selected, window, report };
}
