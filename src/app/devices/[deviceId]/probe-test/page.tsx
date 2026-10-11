import Link from 'next/link';
import { notFound } from 'next/navigation';
import AutoRefresh from '@/components/AutoRefresh';
import ProbeTestView from '@/components/ProbeTestView';
import { requireUser } from '@/lib/supabase/auth';
import { createClient, isSupabaseConfigured } from '@/lib/supabase/server';
import { getProbeTestData } from '@/lib/probeTestData';

// A HabiSync 1.0 unit's probe cap test sessions and their report — see
// src/lib/probeTest.ts. `?s=<id>` picks a session; the default is the
// newest one that wasn't abandoned.
export default async function ProbeTestPage({
  params,
  searchParams,
}: {
  params: { deviceId: string };
  searchParams: { s?: string };
}) {
  await requireUser();

  const supabase = isSupabaseConfigured ? createClient() : null;
  if (!supabase) notFound();

  const now = Date.now();
  const data = await getProbeTestData(supabase, params.deviceId, searchParams.s, new Date(now).toISOString());
  if (!data) notFound();

  // Results update every minute while a session runs.
  const isRunning = data.selected?.status === 'open';

  return (
    <main className="min-h-screen bg-device-screen p-4 text-device-text sm:p-6">
      <div className="mx-auto flex max-w-5xl flex-col gap-4 sm:gap-6">
        <header className="rounded-2xl bg-device-card p-4 shadow-device sm:p-6">
          <Link href={`/devices/${data.device.device_id}`} className="text-sm text-device-accent hover:underline">
            ← {data.device.name}
          </Link>
          <h1 className="mt-2 text-xl font-semibold sm:text-2xl">Probe cap test</h1>
          <p className="text-sm text-device-text-tertiary">{data.device.device_id}</p>
        </header>
        {isRunning && <AutoRefresh intervalMs={60_000} />}
        <ProbeTestView
          deviceId={data.device.device_id}
          sessions={data.sessions}
          selected={data.selected}
          report={data.report}
          nowMs={now}
        />
      </div>
    </main>
  );
}
