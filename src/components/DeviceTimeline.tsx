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

// Recharts needs literal colors for SVG stroke/fill — can't take Tailwind
// classes — so these are kept in sync with the device.* tokens in
// tailwind.config.ts by hand. Line colors match docs/style-guide.md §7
// exactly: temp = accent teal, humidity = cool blue (a different pairing
// than the gauge zone colors — don't conflate the two).
const CHART_COLORS = {
  grid: '#1D3A57',
  axis: '#93A8BD',
  temp: '#4FD1C5',
  hum: '#4299E1',
  tempBand: '#4FD1C5',
  tooltipBg: '#1D3A57',
  scrubLine: '#eee',
};

const LEVEL_DOT_CLASSNAMES: Record<LogLevel, string> = {
  0: 'bg-device-alert', // error
  1: 'bg-device-heating', // warn
  2: 'bg-device-accent', // info
  3: 'bg-device-text-tertiary', // debug
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
// normal, per docs/style-guide.md §8), derived from the same reconstructed
// outlet + climate-target data rather than re-implementing the firmware's
// control logic from scratch.
function deriveClimateStatus(state: ReconstructedState): { dotClassName: string; label: string } {
  if (state.automationEnabled === false) {
    return { dotClassName: 'bg-device-disabled', label: 'AUTOMATION DISABLED' };
  }
  if (state.automationEnabled == null) {
    return { dotClassName: 'bg-device-disabled', label: 'AUTOMATION STATUS UNKNOWN' };
  }

  const heater = state.outlets.find((outlet) => outlet.role === 'Heater');
  if (heater?.on) {
    return { dotClassName: 'bg-device-heating', label: 'HEATING — heat outlet ON' };
  }

  const fan = state.outlets.find((outlet) => outlet.role === 'Fan');
  const tempHigh = state.config.profileConfig?.temp_high_f;
  if (fan?.on && tempHigh != null && state.tempF != null && state.tempF > tempHigh) {
    return { dotClassName: 'bg-device-alert', label: 'TOO HOT — fan ON' };
  }

  return { dotClassName: 'bg-device-good', label: 'TEMP NORMAL — no action needed' };
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
      <section className="rounded-2xl bg-device-card p-6 shadow-device">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex gap-2">
            {(Object.keys(PRESET_LABELS) as Preset[]).map((key) => (
              <Link
                key={key}
                href={`?preset=${key}`}
                className={`rounded-full px-3 py-1 text-sm transition ${
                  preset === key
                    ? 'bg-device-accent/15 text-device-accent'
                    : 'bg-device-surface text-device-text-secondary hover:bg-device-surface-hover'
                }`}
              >
                {PRESET_LABELS[key]}
              </Link>
            ))}
          </div>
          <p className="text-xs text-device-text-tertiary">
            {formatTime(fromMs)} – {formatTime(toMs)}
          </p>
        </div>

        {retentionWarning && (
          <p className="mb-4 rounded-lg border border-device-heating/30 bg-device-heating/10 px-3 py-2 text-xs text-device-heating">
            {retentionWarning}
          </p>
        )}

        {chartData.length === 0 ? (
          <div className="rounded-xl bg-device-surface p-8 text-sm text-device-text-secondary">
            No telemetry in this range.
          </div>
        ) : (
          <div className="h-72 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={chartData} margin={{ left: 0, right: 0, top: 8, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={CHART_COLORS.grid} />
                <XAxis
                  dataKey="t"
                  type="number"
                  domain={[fromMs, toMs]}
                  tickFormatter={formatTime}
                  stroke={CHART_COLORS.axis}
                  fontSize={12}
                />
                <YAxis yAxisId="temp" stroke={CHART_COLORS.temp} fontSize={12} width={40} />
                <YAxis yAxisId="hum" orientation="right" stroke={CHART_COLORS.hum} fontSize={12} width={40} />
                <Tooltip
                  labelFormatter={(t) => formatTime(Number(t))}
                  contentStyle={{ background: CHART_COLORS.tooltipBg, border: 'none', fontSize: 12 }}
                  labelStyle={{ color: '#eee' }}
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
                        fill={CHART_COLORS.tempBand}
                        fillOpacity={0.1}
                        stroke="none"
                      />
                    ),
                )}
                <Line
                  yAxisId="temp"
                  type="stepAfter"
                  dataKey="tempF"
                  stroke={CHART_COLORS.temp}
                  dot={false}
                  name="Temp °F"
                  isAnimationActive={false}
                />
                <Line
                  yAxisId="hum"
                  type="stepAfter"
                  dataKey="hum"
                  stroke={CHART_COLORS.hum}
                  dot={false}
                  name="Humidity %"
                  isAnimationActive={false}
                />
                <ReferenceLine yAxisId="temp" x={scrubMs} stroke={CHART_COLORS.scrubLine} strokeDasharray="4 4" />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        )}

        <div className="relative mt-3 h-3 w-full">
          {data.allLogs.map((row) => (
            <span
              key={row.id}
              title={`[${row.tag}] ${row.message}`}
              className={`absolute top-0 h-3 w-1 -translate-x-1/2 rounded-full ${LEVEL_DOT_CLASSNAMES[row.level]}`}
              style={{ left: `${((new Date(row.created_at).getTime() - fromMs) / (toMs - fromMs)) * 100}%` }}
            />
          ))}
        </div>

        <input
          type="range"
          min={fromMs}
          max={toMs}
          value={scrubMs}
          onChange={(event) => setScrubMs(Number(event.target.value))}
          className="mt-2 w-full accent-device-accent"
        />
      </section>

      <ContextPanel state={state} />
    </div>
  );
}

function ContextPanel({ state }: { state: ReconstructedState }) {
  const status = deriveClimateStatus(state);

  return (
    <section className="rounded-2xl bg-device-screen p-6 shadow-device">
      <h2 className="mb-4 text-[1.1em] text-device-text">State at {formatTime(new Date(state.timestamp).getTime())}</h2>

      <div className="mb-4 flex items-center gap-2.5 rounded-lg bg-device-surface px-3 py-3 font-mono text-[0.85em] text-device-text">
        <span className={`h-2.5 w-2.5 flex-shrink-0 rounded-full ${status.dotClassName}`} />
        <span>{status.label}</span>
      </div>

      {state.config.isFallback && (
        <p className="mb-4 rounded-lg border border-device-heating/30 bg-device-heating/10 px-3 py-2 text-xs text-device-heating">
          No historized settings snapshot exists yet for this period — outlet roles/targets shown are the
          device&apos;s current config, which may not match this historical instant.
        </p>
      )}

      <div className="mb-5 flex flex-wrap gap-8">
        <div>
          <p className="text-[0.9em] text-device-text-secondary">Current Temperature</p>
          <p className="text-[1.6em] font-bold text-device-text">
            {state.tempF != null ? `${state.tempF.toFixed(1)} °F` : '—'}
          </p>
        </div>
        <div>
          <p className="text-[0.9em] text-device-text-secondary">Current Humidity</p>
          <p className="text-[1.6em] font-bold text-device-text">
            {state.hum != null ? `${state.hum.toFixed(1)} %` : '—'}
          </p>
        </div>
      </div>

      <div className="flex flex-wrap justify-center gap-5">
        {state.outlets.map((outlet) => (
          <div key={outlet.index} className="flex w-[84px] flex-col items-center gap-2">
            <div
              className={`rounded-[10px] border-2 p-2 ${
                outlet.on ? 'border-device-active-border' : 'border-transparent'
              }`}
            >
              <div className="text-center text-[2em]" style={{ opacity: outlet.on ? 1 : 0.35 }}>
                {iconForRole(outlet.role)}
              </div>
            </div>
            <p className="text-center text-[0.8em] text-device-text-secondary">{outlet.role}</p>
            <p
              className={`text-center text-[0.75em] font-medium ${
                outlet.on ? 'text-device-good' : 'text-device-text-tertiary'
              }`}
            >
              {outlet.on == null ? 'unknown' : outlet.on ? 'ON' : 'OFF'}
            </p>
            {outlet.since && (
              <p className="text-center text-[0.7em] text-device-text-tertiary">
                since {displayTime(outlet.since, outlet.sinceDeviceTime)}
              </p>
            )}
            {outlet.reason && <p className="text-center text-[0.7em] text-device-text-tertiary">{outlet.reason}</p>}
          </div>
        ))}
      </div>

      {state.lastEvent && (
        <p className="mt-5 border-t border-white/10 pt-4 text-xs text-device-text-tertiary">
          Last event ({displayTime(state.lastEvent.created_at, state.lastEvent.device_time)}):{' '}
          {state.lastEvent.message}
        </p>
      )}
    </section>
  );
}
