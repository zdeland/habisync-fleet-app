'use client';

// The device page for a HabiSync 1.0 unit (firmware 1.x) — monitor-only:
// up to four tanks, one probe each, no outlets, no automation. The devkit's
// DeviceTimeline is built around reconstructing outlet state and replaying
// climate automation, none of which exists here, so this is its own view
// rather than a mode of that one. It shares the event log, the time
// formatting and the range presets.
//
// Every series is (device_id, port) — see src/lib/probes.ts. A unit on
// 1.0.0-1.2.0 has one port-less series, its first tank.
import { useMemo } from 'react';
import Link from 'next/link';
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ReferenceArea,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { DeviceTimelineData } from '@/lib/timeline';
import { deriveHealthEvents, mergeTimelineEntries } from '@/lib/health';
import {
  classifyBand,
  portLabel,
  sampleTimeMs,
  seriesLabel,
  splitByPort,
  tankForSeries,
  tanksOf,
  type BandPosition,
  type SeriesPort,
} from '@/lib/probes';
import type { TelemetryRow } from '@/lib/types';
import { celsiusToFahrenheit } from '@/lib/units';
import { GAUGE_COLORS } from '@/lib/gaugeColors';
import { CHART_COLORS, displayTime, EventLog, formatTime, OfflineNotice, PRESET_LABELS } from '@/components/DeviceTimeline';
import type { Preset } from '@/app/devices/[deviceId]/page';

// One color per port, fixed: a probe keeps its color whichever others are
// present. Categorical dark-mode slots 1-4 of the dataviz reference palette,
// validated against the card surface (#1D3A57): all checks pass, worst
// adjacent CVD ΔE 8.4. The port-less series is a 1.0-1.2 unit's first
// tank, which is port 0 — so it takes port 0's color.
const PORT_COLORS = ['#3987e5', '#d95926', '#199e70', '#c98500'];

function colorFor(port: SeriesPort): string {
  return PORT_COLORS[port ?? 0] ?? PORT_COLORS[0];
}

function seriesKey(port: SeriesPort): string {
  return port == null ? 'px' : `p${port}`;
}

const BAND_BADGE: Record<BandPosition, { temp: { className: string; label: string }; hum: { className: string; label: string } }> = {
  low: {
    temp: { className: GAUGE_COLORS.cool.badgeClassName, label: 'TOO COLD' },
    hum: { className: GAUGE_COLORS.dry.badgeClassName, label: 'TOO DRY' },
  },
  in: {
    temp: { className: GAUGE_COLORS.good.badgeClassName, label: 'IN RANGE' },
    hum: { className: GAUGE_COLORS.good.badgeClassName, label: 'IN RANGE' },
  },
  high: {
    temp: { className: GAUGE_COLORS.alert.badgeClassName, label: 'TOO HOT' },
    hum: { className: GAUGE_COLORS.alert.badgeClassName, label: 'TOO HUMID' },
  },
};

const CAP_LABEL: Record<string, string> = { capped: 'Cap on', uncapped: 'Cap off' };

function TankCard({ data, port, latest }: { data: DeviceTimelineData; port: SeriesPort; latest: TelemetryRow | null }) {
  const profileConfig = data.device.profile_config;
  const tank = tankForSeries(profileConfig, port);
  const tempF = latest ? celsiusToFahrenheit(latest.temp_c) : null;
  const tempBand = latest && tank ? classifyBand(latest.temp_c, tank.temp_low_c, tank.temp_high_c) : null;
  const humBand = latest && tank ? classifyBand(latest.hum, tank.hum_low, tank.hum_high) : null;

  return (
    <div className="flex flex-col gap-3 rounded-xl bg-device-surface p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="h-2.5 w-2.5 flex-shrink-0 rounded-full" style={{ background: colorFor(port) }} />
            <span className="truncate font-medium text-device-text">{seriesLabel(profileConfig, port)}</span>
          </div>
          <div className="mt-0.5 text-[0.75em] text-device-text-tertiary">
            {tank ? `${tank.profile} · ` : ''}
            {port == null ? 'first tank (firmware before 1.3.0 reports only this one)' : portLabel(port)}
          </div>
        </div>
        {latest?.probe_cap && CAP_LABEL[latest.probe_cap] && (
          <span
            title="Whether this probe had its cap on — set during a probe cap test"
            className={`flex-shrink-0 rounded px-2 py-0.5 font-mono text-[0.7em] font-semibold ${GAUGE_COLORS.neutral.badgeClassName}`}
          >
            {CAP_LABEL[latest.probe_cap]}
          </span>
        )}
      </div>

      {latest == null ? (
        <p className="text-sm text-device-text-secondary">No reading in this range — probe unplugged or not answering.</p>
      ) : (
        <div className="grid grid-cols-2 gap-3">
          <div>
            <p className="text-[0.7em] uppercase tracking-wider text-device-text-tertiary">Temp</p>
            <p className="text-2xl font-bold text-device-text">{tempF!.toFixed(1)}°F</p>
            {tempBand && (
              <span className={`mt-1 inline-block rounded px-2 py-0.5 font-mono text-[0.7em] font-semibold ${BAND_BADGE[tempBand].temp.className}`}>
                {BAND_BADGE[tempBand].temp.label}
              </span>
            )}
            {tank && (
              <p className="mt-1 text-[0.75em] text-device-text-tertiary">
                {celsiusToFahrenheit(tank.temp_low_c).toFixed(1)}–{celsiusToFahrenheit(tank.temp_high_c).toFixed(1)}°F
              </p>
            )}
          </div>
          <div>
            <p className="text-[0.7em] uppercase tracking-wider text-device-text-tertiary">Humidity</p>
            <p className="text-2xl font-bold text-device-text">{latest.hum.toFixed(1)}%</p>
            {humBand && (
              <span className={`mt-1 inline-block rounded px-2 py-0.5 font-mono text-[0.7em] font-semibold ${BAND_BADGE[humBand].hum.className}`}>
                {BAND_BADGE[humBand].hum.label}
              </span>
            )}
            {tank && (
              <p className="mt-1 text-[0.75em] text-device-text-tertiary">
                {tank.hum_low}–{tank.hum_high}%
              </p>
            )}
          </div>
        </div>
      )}
      {latest && (
        <p className="text-[0.7em] text-device-text-tertiary">Sampled {displayTime(latest.created_at, latest.device_time)}</p>
      )}
      {!tank && port != null && (
        <p className="text-[0.75em] text-device-text-tertiary">Hidden tank — its probe still reports, but it has no target range.</p>
      )}
    </div>
  );
}

const MINUTE_MS = 60_000;
// Long ranges are averaged into buckets so no line carries more than about
// this many points — a week of one-minute rows is 10k per probe, which is
// more than a chart this size can show and slow to draw (fleet-handoff-1.3.0
// §3, "Downsample long ranges").
const MAX_POINTS_PER_SERIES = 1500;

// One chart per measure — never two y-scales on one plot.
function ProbeChart({
  title,
  points,
  ports,
  labels,
  unit,
  band,
  fromMs,
  toMs,
}: {
  title: string;
  points: Record<string, number | null>[];
  ports: SeriesPort[];
  labels: Map<SeriesPort, string>;
  unit: string;
  band: { low: number; high: number } | null;
  fromMs: number;
  toMs: number;
}) {
  return (
    <div>
      <p className="mb-2 text-sm text-device-text-secondary">{title}</p>
      <div className="h-60 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={points} margin={{ left: 0, right: 8, top: 8, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={CHART_COLORS.grid} />
            <XAxis
              dataKey="t"
              type="number"
              domain={[fromMs, toMs]}
              tickFormatter={formatTime}
              stroke={CHART_COLORS.axis}
              fontSize={12}
            />
            <YAxis stroke={CHART_COLORS.axis} fontSize={12} width={40} domain={['auto', 'auto']} />
            <Tooltip
              labelFormatter={(t) => formatTime(Number(t))}
              formatter={(value) => (typeof value === 'number' ? `${value.toFixed(1)}${unit}` : value)}
              contentStyle={{ background: CHART_COLORS.tooltipBg, border: 'none', fontSize: 12 }}
              labelStyle={{ color: '#eee' }}
            />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            {band && (
              <ReferenceArea
                y1={band.low}
                y2={band.high}
                fill={CHART_COLORS.tempBand}
                fillOpacity={0.08}
                stroke="none"
              />
            )}
            {ports.map((port) => (
              <Line
                key={seriesKey(port)}
                type="monotone"
                dataKey={seriesKey(port)}
                name={labels.get(port)}
                stroke={colorFor(port)}
                strokeWidth={2}
                dot={false}
                isAnimationActive={false}
                connectNulls={false}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

export default function MonitorTimeline({
  data,
  range,
  preset,
  retentionWarning,
  isDeviceOffline,
}: {
  data: DeviceTimelineData;
  range: { from: string; to: string };
  preset: Preset | null;
  retentionWarning: string | null;
  isDeviceOffline: boolean;
}) {
  const fromMs = new Date(range.from).getTime();
  const toMs = new Date(range.to).getTime();
  const profileConfig = data.device.profile_config;

  const series = useMemo(() => splitByPort(data.telemetry), [data.telemetry]);

  // Every shown tank gets a card, reading or not; any other series that
  // reported (a hidden tank's probe, or a pre-1.3.0 port-less series) too.
  const cardPorts = useMemo(() => {
    const hasPorted = Array.from(series.keys()).some((port) => port != null);
    const ports = new Set<SeriesPort>(tanksOf(profileConfig).map((tank) => tank.port));
    // A unit still on 1.0-1.2 reports port-less rows standing for its first
    // tank; show that series in the first tank's place rather than as an
    // empty card beside it.
    if (series.has(null) && !hasPorted) {
      ports.clear();
      ports.add(null);
    }
    series.forEach((_, port) => {
      if (port != null || !hasPorted) ports.add(port);
    });
    return Array.from(ports).sort((a, b) => (a ?? -1) - (b ?? -1));
  }, [series, profileConfig]);

  const chartPorts = useMemo(() => Array.from(series.keys()), [series]);
  const labels = useMemo(
    () => new Map(chartPorts.map((port) => [port, seriesLabel(profileConfig, port)])),
    [chartPorts, profileConfig],
  );

  // One point per bucket — a minute, or wider on long ranges — averaging
  // each probe's rows in it, keyed by sample time, not upload time. A 1.3.0
  // unit stamps every probe's row in a minute with the same device_time, and
  // flooring to the bucket also lines up the port-less and per-port rows
  // around an upgrade. A probe with no row in a bucket leaves its key unset,
  // which breaks its line there: it had no reading.
  const bucketMs = Math.max(MINUTE_MS, Math.ceil((toMs - fromMs) / MAX_POINTS_PER_SERIES / MINUTE_MS) * MINUTE_MS);
  const { tempPoints, humPoints } = useMemo(() => {
    type Sums = Map<number, Map<string, { temp: number; hum: number; n: number }>>;
    const sums: Sums = new Map();
    series.forEach((rows, port) => {
      const key = seriesKey(port);
      for (const row of rows) {
        const t = Math.floor(sampleTimeMs(row) / bucketMs) * bucketMs;
        const bucket = sums.get(t) ?? new Map();
        const acc = bucket.get(key) ?? { temp: 0, hum: 0, n: 0 };
        acc.temp += row.temp_c;
        acc.hum += row.hum;
        acc.n += 1;
        bucket.set(key, acc);
        sums.set(t, bucket);
      }
    });
    const times = Array.from(sums.keys()).sort((a, b) => a - b);
    const temp = times.map((t) => {
      const point: Record<string, number | null> = { t };
      sums.get(t)!.forEach((acc, key) => (point[key] = celsiusToFahrenheit(acc.temp / acc.n)));
      return point;
    });
    const hum = times.map((t) => {
      const point: Record<string, number | null> = { t };
      sums.get(t)!.forEach((acc, key) => (point[key] = acc.hum / acc.n));
      return point;
    });
    return { tempPoints: temp, humPoints: hum };
  }, [series, bucketMs]);

  // A target band only means something on a chart with one tank on it.
  const singleTank = chartPorts.length === 1 ? tankForSeries(profileConfig, chartPorts[0]) : null;

  const healthEvents = useMemo(
    () => deriveHealthEvents(data, { from: range.from, to: range.to }),
    [data, range.from, range.to],
  );
  const timelineEntries = useMemo(() => mergeTimelineEntries(data.allLogs, healthEvents), [data.allLogs, healthEvents]);

  return (
    <div className="flex flex-col gap-6">
      {isDeviceOffline && <OfflineNotice lastSeen={data.device.last_seen} />}

      <section className="rounded-2xl bg-device-card p-4 shadow-device sm:p-6">
        <h2 className="mb-4 text-[1.1em] font-medium text-device-text">Tanks</h2>
        {cardPorts.length === 0 ? (
          <p className="text-sm text-device-text-secondary">No tanks configured and no probe readings in this range.</p>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {cardPorts.map((port) => {
              const rows = series.get(port);
              return <TankCard key={seriesKey(port)} data={data} port={port} latest={rows?.[rows.length - 1] ?? null} />;
            })}
          </div>
        )}
      </section>

      <details className="group rounded-2xl bg-device-card shadow-device" open>
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 p-4 text-device-text sm:p-6">
          <span className="text-[1.1em] font-medium">Temperature &amp; humidity history</span>
          <span className="text-device-text-tertiary transition group-open:rotate-180">▾</span>
        </summary>
        <div className="flex flex-col gap-6 px-4 pb-4 sm:px-6 sm:pb-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap gap-2">
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
            <p className="rounded-lg border border-device-heating/30 bg-device-heating/10 px-3 py-2 text-xs text-device-heating">
              {retentionWarning}
            </p>
          )}

          {tempPoints.length === 0 ? (
            <div className="rounded-xl bg-device-surface p-8 text-sm text-device-text-secondary">No telemetry in this range.</div>
          ) : (
            <>
              {bucketMs > MINUTE_MS && (
                <p className="-mb-3 text-xs text-device-text-tertiary">
                  Averaged over {Math.round(bucketMs / MINUTE_MS)}-minute buckets for this range.
                </p>
              )}
              <ProbeChart
                title="Temperature (°F)"
                points={tempPoints}
                ports={chartPorts}
                labels={labels}
                unit="°F"
                band={
                  singleTank
                    ? { low: celsiusToFahrenheit(singleTank.temp_low_c), high: celsiusToFahrenheit(singleTank.temp_high_c) }
                    : null
                }
                fromMs={fromMs}
                toMs={toMs}
              />
              <ProbeChart
                title="Humidity (%RH)"
                points={humPoints}
                ports={chartPorts}
                labels={labels}
                unit="%"
                band={singleTank ? { low: singleTank.hum_low, high: singleTank.hum_high } : null}
                fromMs={fromMs}
                toMs={toMs}
              />
            </>
          )}
        </div>
      </details>

      <EventLog data={data} entries={timelineEntries} />
    </div>
  );
}
