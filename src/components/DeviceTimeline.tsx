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

// Palette + component shapes lifted verbatim from the on-device dashboard
// (src/main.cpp's handleDashboard(), per the HabiSync UI style guide) so the
// reconstructed state reads as the device's own screen, not an approximation.
// Fixed, not theme-reactive — matches the guide's ".device" treatment.
const DEVICE = {
  screen: '#122333',
  text: '#eee',
  textSecondary: '#B8C4D0',
  textTertiary: '#93A8BD',
  surface: '#141414',
  good: '#48BB78',
  alert: '#F56565',
  heating: '#F6AD55',
  disabledDot: '#888',
  activeBorder: '#6EC9E6',
};

const ROLE_ICONS: Record<string, string> = {
  'Day Light': '☀️',
  Heater: '🔥',
  Mister: '💧',
  Fan: '🌀',
  'UVB Light': '🔆',
};

// Unassigned/custom outlet roles (a raw Kasa alias) fall back to a plug icon.
function iconForRole(role: string) {
  return ROLE_ICONS[role] ?? '🔌';
}

// Mirrors the on-device status-box's four states (disabled/heating/too hot/
// normal), derived from the same reconstructed outlet + climate-target data
// rather than re-implementing the firmware's control logic from scratch.
function deriveClimateStatus(state: ReconstructedState): { dot: string; label: string } {
  if (state.automationEnabled === false) {
    return { dot: DEVICE.disabledDot, label: 'AUTOMATION DISABLED' };
  }
  if (state.automationEnabled == null) {
    return { dot: DEVICE.disabledDot, label: 'AUTOMATION STATUS UNKNOWN' };
  }

  const heater = state.outlets.find((outlet) => outlet.role === 'Heater');
  if (heater?.on) {
    return { dot: DEVICE.heating, label: 'HEATING — heat outlet ON' };
  }

  const fan = state.outlets.find((outlet) => outlet.role === 'Fan');
  const tempHigh = state.config.profileConfig?.temp_high_f;
  if (fan?.on && tempHigh != null && state.tempF != null && state.tempF > tempHigh) {
    return { dot: DEVICE.alert, label: 'TOO HOT — fan ON' };
  }

  return { dot: DEVICE.good, label: 'TEMP NORMAL — no action needed' };
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
  const status = deriveClimateStatus(state);

  return (
    <section className="rounded-2xl p-6 shadow-xl shadow-black/40" style={{ background: DEVICE.screen }}>
      <h2 className="mb-4 text-[1.1em]" style={{ color: DEVICE.text }}>
        State at {formatTime(new Date(state.timestamp).getTime())}
      </h2>

      <div
        className="mb-4 flex items-center gap-2.5 rounded-lg px-3 py-3 font-mono text-[0.85em]"
        style={{ background: DEVICE.surface, color: DEVICE.text }}
      >
        <span className="h-2.5 w-2.5 flex-shrink-0 rounded-full" style={{ background: status.dot }} />
        <span>{status.label}</span>
      </div>

      {state.config.isFallback && (
        <p className="mb-4 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
          No historized settings snapshot exists yet for this period — outlet roles/targets shown are the
          device&apos;s current config, which may not match this historical instant.
        </p>
      )}

      <div className="mb-5 flex flex-wrap gap-8">
        <div>
          <p className="text-[0.9em]" style={{ color: DEVICE.textSecondary }}>
            Current Temperature
          </p>
          <p className="text-[1.6em] font-bold" style={{ color: DEVICE.text }}>
            {state.tempF != null ? `${state.tempF.toFixed(1)} °F` : '—'}
          </p>
        </div>
        <div>
          <p className="text-[0.9em]" style={{ color: DEVICE.textSecondary }}>
            Current Humidity
          </p>
          <p className="text-[1.6em] font-bold" style={{ color: DEVICE.text }}>
            {state.hum != null ? `${state.hum.toFixed(1)} %` : '—'}
          </p>
        </div>
      </div>

      <div className="flex flex-wrap justify-center gap-5">
        {state.outlets.map((outlet) => (
          <div key={outlet.index} className="flex w-[84px] flex-col items-center gap-2">
            <div
              className="rounded-[10px] border-2 p-2"
              style={{ borderColor: outlet.on ? DEVICE.activeBorder : 'transparent' }}
            >
              <div className="text-center text-[2em]" style={{ opacity: outlet.on ? 1 : 0.35 }}>
                {iconForRole(outlet.role)}
              </div>
            </div>
            <p className="text-center text-[0.8em]" style={{ color: DEVICE.textSecondary }}>
              {outlet.role}
            </p>
            <p
              className="text-center text-[0.75em] font-medium"
              style={{ color: outlet.on ? DEVICE.good : DEVICE.textTertiary }}
            >
              {outlet.on == null ? 'unknown' : outlet.on ? 'ON' : 'OFF'}
            </p>
            {outlet.since && (
              <p className="text-center text-[0.7em]" style={{ color: DEVICE.textTertiary }}>
                since {displayTime(outlet.since, outlet.sinceDeviceTime)}
              </p>
            )}
            {outlet.reason && (
              <p className="text-center text-[0.7em]" style={{ color: DEVICE.textTertiary }}>
                {outlet.reason}
              </p>
            )}
          </div>
        ))}
      </div>

      {state.lastEvent && (
        <p
          className="mt-5 pt-4 text-xs"
          style={{ borderTop: '1px solid rgba(255,255,255,0.1)', color: DEVICE.textTertiary }}
        >
          Last event ({displayTime(state.lastEvent.created_at, state.lastEvent.device_time)}):{' '}
          {state.lastEvent.message}
        </p>
      )}
    </section>
  );
}
