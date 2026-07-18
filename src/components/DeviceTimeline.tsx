'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import {
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { reconstructStateAt, resolveConfigAt, type DeviceTimelineData, type ReconstructedState } from '@/lib/timeline';
import type { LogLevel } from '@/lib/types';
import type { Preset } from '@/app/devices/[deviceId]/page';

const LEVEL_COLORS: Record<LogLevel, string> = {
  0: '#fb7185', // rose-400 · error
  1: '#fbbf24', // amber-400 · warn
  2: '#38bdf8', // sky-400 · info
  3: '#94a3b8', // slate-400 · debug
};

const PRESET_LABELS: Record<Preset, string> = {
  '1h': 'Last hour',
  '24h': 'Last day',
  '7d': 'Last week',
};

function formatTime(ms: number) {
  return new Date(ms).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

// Prefer the device's own NTP-synced clock for display when present, per
// docs/monitoring-webapp-plan.md §5 — created_at is what we sort/query by,
// device_time is what a user would've seen on-device at the time.
function displayTime(iso: string, deviceTime: string | null) {
  return formatTime(new Date(deviceTime ?? iso).getTime());
}

export default function DeviceTimeline({
  data,
  range,
  preset,
  retentionWarning,
}: {
  data: DeviceTimelineData;
  range: { from: string; to: string };
  preset: Preset | null;
  retentionWarning: string | null;
}) {
  const fromMs = new Date(range.from).getTime();
  const toMs = new Date(range.to).getTime();
  const [scrubMs, setScrubMs] = useState(toMs);

  const chartData = useMemo(
    () => data.telemetry.map((row) => ({ t: new Date(row.created_at).getTime(), tempF: row.temp_f, hum: row.hum })),
    [data.telemetry],
  );

  // Config rarely changes mid-window, but when it does the target band
  // should reflect whichever config was active at each point (§5 step 3),
  // not just the config in effect at the end of the range.
  const segments = useMemo(() => {
    const breakpoints = new Set<string>([range.from]);
    data.configLogs.forEach((row) => {
      if (row.created_at > range.from && row.created_at < range.to) breakpoints.add(row.created_at);
    });
    const sorted = Array.from(breakpoints).sort();
    return sorted.map((start, i) => {
      const end = sorted[i + 1] ?? range.to;
      const config = resolveConfigAt(data.configLogs, data.device, start);
      return { start: new Date(start).getTime(), end: new Date(end).getTime(), config };
    });
  }, [data.configLogs, data.device, range.from, range.to]);

  const scrubTimestamp = new Date(scrubMs).toISOString();
  const state = useMemo(() => reconstructStateAt(data, scrubTimestamp), [data, scrubTimestamp]);

  return (
    <div className="flex flex-col gap-6">
      <section className="rounded-2xl border border-slate-800 bg-slate-900/80 p-6 shadow-xl shadow-black/20">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex gap-2">
            {(Object.keys(PRESET_LABELS) as Preset[]).map((key) => (
              <Link
                key={key}
                href={`?preset=${key}`}
                className={`rounded-full border px-3 py-1 text-sm transition ${
                  preset === key
                    ? 'border-cyan-500 bg-cyan-500/10 text-cyan-300'
                    : 'border-slate-700 bg-slate-800 text-slate-300 hover:bg-slate-700'
                }`}
              >
                {PRESET_LABELS[key]}
              </Link>
            ))}
          </div>
          <p className="text-xs text-slate-500">
            {formatTime(fromMs)} – {formatTime(toMs)}
          </p>
        </div>

        {retentionWarning && (
          <p className="mb-4 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
            {retentionWarning}
          </p>
        )}

        {chartData.length === 0 ? (
          <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-8 text-sm text-slate-400">
            No telemetry in this range.
          </div>
        ) : (
          <div className="h-72 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={chartData} margin={{ left: 0, right: 0, top: 8, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                <XAxis
                  dataKey="t"
                  type="number"
                  domain={[fromMs, toMs]}
                  tickFormatter={formatTime}
                  stroke="#64748b"
                  fontSize={12}
                />
                <YAxis yAxisId="temp" stroke="#38bdf8" fontSize={12} width={40} />
                <YAxis yAxisId="hum" orientation="right" stroke="#a78bfa" fontSize={12} width={40} />
                <Tooltip
                  labelFormatter={(t) => formatTime(Number(t))}
                  contentStyle={{ background: '#0f172a', border: '1px solid #1e293b', fontSize: 12 }}
                />
                {segments.map(
                  (segment, i) =>
                    segment.config.profileConfig && (
                      <ReferenceArea
                        key={`temp-band-${i}`}
                        yAxisId="temp"
                        x1={segment.start}
                        x2={segment.end}
                        y1={segment.config.profileConfig.temp_low_f}
                        y2={segment.config.profileConfig.temp_high_f}
                        fill="#38bdf8"
                        fillOpacity={0.08}
                        stroke="none"
                      />
                    ),
                )}
                <Line
                  yAxisId="temp"
                  type="stepAfter"
                  dataKey="tempF"
                  stroke="#38bdf8"
                  dot={false}
                  name="Temp °F"
                  isAnimationActive={false}
                />
                <Line
                  yAxisId="hum"
                  type="stepAfter"
                  dataKey="hum"
                  stroke="#a78bfa"
                  dot={false}
                  name="Humidity %"
                  isAnimationActive={false}
                />
                <ReferenceLine yAxisId="temp" x={scrubMs} stroke="#f8fafc" strokeDasharray="4 4" />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        )}

        <div className="relative mt-3 h-3 w-full">
          {data.allLogs.map((row) => (
            <span
              key={row.id}
              title={`[${row.tag}] ${row.message}`}
              className="absolute top-0 h-3 w-1 -translate-x-1/2 rounded-full"
              style={{
                left: `${((new Date(row.created_at).getTime() - fromMs) / (toMs - fromMs)) * 100}%`,
                backgroundColor: LEVEL_COLORS[row.level],
              }}
            />
          ))}
        </div>

        <input
          type="range"
          min={fromMs}
          max={toMs}
          value={scrubMs}
          onChange={(event) => setScrubMs(Number(event.target.value))}
          className="mt-2 w-full accent-cyan-500"
        />
      </section>

      <ContextPanel state={state} />
    </div>
  );
}

function ContextPanel({ state }: { state: ReconstructedState }) {
  return (
    <section className="rounded-2xl border border-slate-800 bg-slate-900/80 p-6 shadow-xl shadow-black/20">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">State at {formatTime(new Date(state.timestamp).getTime())}</h2>
        <div
          className={`rounded-full border px-3 py-1 text-xs font-medium ${
            state.automationEnabled
              ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
              : 'border-slate-700 bg-slate-800 text-slate-400'
          }`}
        >
          Automation: {state.automationEnabled == null ? 'unknown' : state.automationEnabled ? 'enabled' : 'disabled'}
        </div>
      </div>

      {state.config.isFallback && (
        <p className="mb-4 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
          No historized settings snapshot exists yet for this period — outlet roles/targets shown are the
          device&apos;s current config, which may not match this historical instant.
        </p>
      )}

      <div className="mb-4 flex flex-wrap gap-6 text-sm">
        <div>
          <p className="text-slate-500">Temperature</p>
          <p className="text-2xl font-semibold text-sky-300">{state.tempF != null ? `${state.tempF.toFixed(1)}°F` : '—'}</p>
        </div>
        <div>
          <p className="text-slate-500">Humidity</p>
          <p className="text-2xl font-semibold text-violet-300">{state.hum != null ? `${state.hum}%` : '—'}</p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        {state.outlets.map((outlet) => (
          <div key={outlet.index} className="rounded-xl border border-slate-800 bg-slate-900/70 p-3">
            <p className="text-sm font-medium text-slate-200">{outlet.role}</p>
            <p
              className={`mt-1 text-xs font-medium ${
                outlet.on == null ? 'text-slate-500' : outlet.on ? 'text-emerald-300' : 'text-slate-500'
              }`}
            >
              {outlet.on == null ? 'unknown' : outlet.on ? 'ON' : 'OFF'}
              {outlet.since && ` since ${displayTime(outlet.since, outlet.sinceDeviceTime)}`}
            </p>
            {outlet.reason && <p className="mt-1 text-xs text-slate-500">{outlet.reason}</p>}
          </div>
        ))}
      </div>

      {state.lastEvent && (
        <p className="mt-4 border-t border-slate-800 pt-4 text-xs text-slate-400">
          Last event ({displayTime(state.lastEvent.created_at, state.lastEvent.device_time)}):{' '}
          {state.lastEvent.message}
        </p>
      )}
    </section>
  );
}
