import Link from 'next/link';
import { notFound } from 'next/navigation';
import AutoRefresh from '@/components/AutoRefresh';
import { requireUser } from '@/lib/supabase/auth';
import { createClient, isSupabaseConfigured } from '@/lib/supabase/server';
import { getDeviceTimelineData } from '@/lib/timeline';
import DeviceTimeline from '@/components/DeviceTimeline';

const PRESETS = {
  '1h': 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
} as const;

export type Preset = keyof typeof PRESETS;

function isPreset(value: string | undefined): value is Preset {
  return value != null && Object.prototype.hasOwnProperty.call(PRESETS, value);
}

// telemetry: 30-day retention · logs: 60-day retention (docs/monitoring-webapp-plan.md §2)
const TELEMETRY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export default async function DeviceTimelinePage({
  params,
  searchParams,
}: {
  params: { deviceId: string };
  searchParams: { preset?: string; from?: string; to?: string };
}) {
  await requireUser();

  if (!isSupabaseConfigured) {
    return (
      <main className="min-h-screen bg-slate-950 p-6 text-slate-100">
        <div className="mx-auto max-w-7xl rounded-2xl border border-slate-800 bg-slate-900/80 p-8 text-sm text-slate-400">
          Set <code>NEXT_PUBLIC_SUPABASE_URL</code> and <code>NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY</code> to load
          device data.
        </div>
      </main>
    );
  }

  const now = Date.now();
  const preset: Preset = isPreset(searchParams.preset) ? searchParams.preset : '24h';
  const to = searchParams.to ?? new Date(now).toISOString();
  const from = searchParams.from ?? new Date(now - PRESETS[preset]).toISOString();
  const activePreset = searchParams.from || searchParams.to ? null : preset;

  const supabase = createClient();
  const data = supabase ? await getDeviceTimelineData(supabase, params.deviceId, { from, to }) : null;

  if (!data) notFound();

  const retentionWarning =
    new Date(from).getTime() < now - TELEMETRY_RETENTION_MS
      ? 'Part of this range predates the 30-day telemetry retention window — temperature/humidity data before then is already purged.'
      : null;

  return (
    <main className="min-h-screen bg-slate-950 p-6 text-slate-100">
      <div className="mx-auto flex max-w-7xl flex-col gap-6">
        <header className="rounded-2xl border border-slate-800 bg-slate-900/80 p-6 shadow-xl shadow-black/20">
          <Link href="/" className="text-sm text-cyan-400 hover:underline">
            ← Fleet overview
          </Link>
          <h1 className="mt-2 text-2xl font-semibold">{data.device.name}</h1>
          <p className="text-sm text-slate-500">{data.device.device_id}</p>
        </header>

        {/* Only auto-refresh a rolling preset window — a custom from/to range is a
            fixed historical query the user is studying, not a "keep watching" view. */}
        {activePreset && <AutoRefresh intervalMs={20_000} />}
        <DeviceTimeline data={data} range={{ from, to }} preset={activePreset} retentionWarning={retentionWarning} />
      </div>
    </main>
  );
}
