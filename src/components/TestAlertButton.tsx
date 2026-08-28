'use client';

import { useState, useTransition } from 'react';
import { sendTestAlertEmail } from '@/app/actions/testAlert';

// Lets a signed-in user confirm the climate-alerts SMTP setup works without
// waiting on real telemetry or the 3-minute sustained-out-of-range window —
// see docs/climate-alerts.md. Sends to the caller's own address only.
export default function TestAlertButton() {
  const [isPending, startTransition] = useTransition();
  const [result, setResult] = useState<{ ok: boolean; error?: string } | null>(null);

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        disabled={isPending}
        onClick={() => {
          setResult(null);
          startTransition(async () => {
            setResult(await sendTestAlertEmail());
          });
        }}
        className="rounded-full bg-device-surface px-4 py-2 text-sm text-device-text-secondary transition hover:bg-device-surface-hover disabled:opacity-50"
      >
        {isPending ? 'Sending…' : 'Send test alert'}
      </button>
      {result && (
        <span className={`text-xs ${result.ok ? 'text-device-good' : 'text-device-alert'}`}>
          {result.ok ? 'Sent — check your inbox.' : result.error}
        </span>
      )}
    </div>
  );
}
