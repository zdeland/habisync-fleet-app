'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
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
import { deriveHealthEvents, findTelemetryGaps, mergeTimelineEntries, type TimelineEntry } from '@/lib/health';
import type { Device, LogLevel, LogRow, LogTag, ProfileConfig } from '@/lib/types';
import { celsiusDeltaToFahrenheit, celsiusToFahrenheit, tempRangeC } from '@/lib/units';
import { HUMIDITY_HYSTERESIS_PCT, TEMP_HYSTERESIS_C } from '@/lib/automation';
import { GAUGE_COLORS } from '@/lib/gaugeColors';
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
  humBand: '#4299E1',
  tooltipBg: '#1D3A57',
  scrubLine: '#eee',
  offlineGap: '#F56565', // matches device-alert — a gap in reporting, not real continuous data
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

// A fixed 0-100 (or Recharts' own auto-scaled) domain wastes most of the
// chart's height when real readings only ever move within a narrow band —
// a temp that hovers at 75-90°F barely moves on a 0-100 axis. Size the axis
// so the target range itself fills TARGET_RANGE_FRACTION of the visible
// height instead, expanding further (asymmetrically if needed) only when
// real data actually falls outside that — never clip real readings just to
// hit the fraction exactly.
const TARGET_RANGE_FRACTION = 0.75;

function computeChartDomain(
  targetLow: number,
  targetHigh: number,
  dataMin: number,
  dataMax: number,
): [number, number] {
  const targetSpan = targetHigh - targetLow;
  const totalSpan = targetSpan / TARGET_RANGE_FRACTION;
  const pad = (totalSpan - targetSpan) / 2;

  let domainMin = targetLow - pad;
  let domainMax = targetHigh + pad;

  if (dataMin < domainMin) domainMin = dataMin - pad * 0.1;
  if (dataMax > domainMax) domainMax = dataMax + pad * 0.1;

  return [domainMin, domainMax];
}

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

// Outlet transition messages read "Heater [1] turned ON — temperature below
// target range" — keep only the reason after the dash for the compact
// per-outlet display, drop the "what turned on/off" part (already shown by
// the icon + ON/OFF label right above it).
function reasonOnly(message: string) {
  const match = message.match(/[-—]\s*(.*)$/);
  return match ? match[1] : message;
}

// The device dashboard's /climate-test page drives the real
// ClimateController and real outlets — it's not a sandbox — so a
// test-triggered transition logs through the exact same tag='event' path
// as a real one. The only distinguishing signal is this "test: " prefix
// on the reason (see docs/known-issues.md); render it distinctly so it's
// never mistaken for a real climate-triggered decision.
function isTestReason(reason: string) {
  return reasonOnly(reason).trim().toLowerCase().startsWith('test:');
}

// Colors the reason badge by what triggered the transition — reuses the
// same cool/alert/good palette as the gauges so "temperature below target
// range" reads as the same blue as a TOO COLD badge, not an unrelated hue.
function reasonBadgeColor(reason: string): typeof GAUGE_COLORS.good {
  const text = reason.toLowerCase();
  if (text.includes('below') || text.includes('low') || text.includes('under')) return GAUGE_COLORS.cool;
  if (text.includes('above') || text.includes('high') || text.includes('ceiling') || text.includes('over')) {
    return GAUGE_COLORS.alert;
  }
  return GAUGE_COLORS.good;
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

// Non-outlet tags per docs/style-guide.md's nav-tile icons where they exist
// (ota -> Firmware Update, sensor -> Climate Setup, cloudlog -> Cloud
// Logging); the rest are reasonable extensions of the same language.
const TAG_ICONS: Partial<Record<LogTag, string>> = {
  boot: '🔁',
  wifi: '📶',
  kasa: '🔌',
  ota: '⬆️',
  sensor: '🌡️',
  cloudlog: '☁️',
  config: '⚙️',
};

// tag='event' rows carry outlet_index for outlet transitions (use the
// role's own icon, resolved against whatever config was active at that
// row's own timestamp) but day/night and automation toggles don't
// correspond to one outlet, so fall back to a simple keyword match.
function iconForLog(row: LogRow, device: Device, configLogs: LogRow[]) {
  if (isTestReason(row.message)) return '🧪';
  if (row.tag === 'event') {
    if (row.outlet_index != null) {
      const { outletRoles } = resolveConfigAt(configLogs, device, row.created_at);
      return iconForRole(outletRoles[row.outlet_index] ?? '');
    }
    const message = row.message.toLowerCase();
    if (message.includes('night')) return '🌙';
    if (message.includes('day')) return '☀️';
    if (message.includes('automation')) return '⚙️';
    return '🔔';
  }
  return TAG_ICONS[row.tag] ?? '🔔';
}

// docs/style-guide.md §6 — hand-drawn semicircle gauge, viewBox 0 0 200 120,
// center (100,100), radius 80, 16px zone arcs, needle + center dot. Domain
// is always 0-100 (matches the on-device gauge exactly, including for
// temperature — zone breakpoints come from the live climate targets).
function polarToCartesian(cx: number, cy: number, r: number, angleDeg: number) {
  const a = ((angleDeg - 180) * Math.PI) / 180;
  return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
}

function arcPath(cx: number, cy: number, r: number, a0: number, a1: number) {
  const p0 = polarToCartesian(cx, cy, r, a0);
  const p1 = polarToCartesian(cx, cy, r, a1);
  const largeArc = a1 - a0 > 180 ? 1 : 0;
  return `M ${p0.x} ${p0.y} A ${r} ${r} 0 ${largeArc} 1 ${p1.x} ${p1.y}`;
}

type GaugeZone = { from: number; to: number; color: string };

function Gauge({ value, min, max, zones }: { value: number | null; min: number; max: number; zones: GaugeZone[] }) {
  const cx = 100;
  const cy = 100;
  const r = 80;
  const clamped = value == null ? null : Math.max(min, Math.min(max, value));
  const needle = clamped == null ? null : polarToCartesian(cx, cy, r - 14, ((clamped - min) / (max - min)) * 180);

  return (
    <svg viewBox="0 0 200 120" className="block w-full">
      {zones.map((zone, i) => {
        const from = Math.max(min, Math.min(max, zone.from));
        const to = Math.max(min, Math.min(max, zone.to));
        if (to <= from) return null;
        const a0 = ((from - min) / (max - min)) * 180;
        const a1 = ((to - min) / (max - min)) * 180;
        return <path key={i} d={arcPath(cx, cy, r, a0, a1)} stroke={zone.color} strokeWidth={16} fill="none" />;
      })}
      {needle && (
        <>
          <line x1={cx} y1={cy} x2={needle.x} y2={needle.y} stroke="#eee" strokeWidth={4} strokeLinecap="round" />
          <circle cx={cx} cy={cy} r={6} fill="#eee" />
        </>
      )}
      <text x={16} y={114} fill="#93A8BD" fontSize={12}>
        {min}
      </text>
      <text x={184} y={114} fill="#93A8BD" fontSize={12} textAnchor="end">
        {max}
      </text>
    </svg>
  );
}

// The real automation (docs/automation-rules.md §3-5) has different
// ON->OFF and OFF->ON thresholds — the "low"/"high" gauge zone lines are
// where a trigger *starts*, not where it releases. Passing the real
// outlet's reported on/off state lets these agree with what the device
// is actually doing while latched in that band, instead of the badge
// flipping to "IN RANGE" the instant the raw reading crosses the
// trigger line while the outlet (correctly) hasn't released yet.
function isBelowActive(value: number, low: number, hysteresis: number, outletOn: boolean | null): boolean {
  if (value < low) return true;
  return Boolean(outletOn) && value < low + hysteresis;
}

// One gauge + value readout + in-range badge, for either temp or humidity.
function GaugeColumn({
  label,
  value,
  unit,
  low,
  high,
  lowLabel,
  highLabel,
  lowColor,
  hysteresis,
  belowOutletOn,
  aboveActive,
  automationEnabled,
  controlStatus,
}: {
  label: string;
  value: number | null;
  unit: string;
  low: number | undefined;
  high: number | undefined;
  lowLabel: string;
  highLabel: string;
  lowColor: typeof GAUGE_COLORS.cool;
  hysteresis: number;
  belowOutletOn: boolean | null;
  // Real recomputed Fan trigger (state.tooHot/tooHumid from the reducer),
  // not derived from raw value vs. threshold here — Fan is shared between
  // temp and humidity, so "value is in the hysteresis band" alone can't
  // tell you which cause is actually active (see the tooHot/tooHumid doc
  // comment on ReconstructedState).
  aboveActive: boolean | null;
  automationEnabled: boolean | null;
  controlStatus: { dotClassName: string; label: string };
}) {
  const hasTarget = automationEnabled === true && low != null && high != null;

  const zones: GaugeZone[] = hasTarget
    ? [
        { from: 0, to: low, color: lowColor.hex },
        { from: low, to: high, color: GAUGE_COLORS.good.hex },
        { from: high, to: 100, color: GAUGE_COLORS.alert.hex },
      ]
    : [{ from: 0, to: 100, color: GAUGE_COLORS.neutral.hex }];

  let badge: { className: string; label: string };
  if (!hasTarget) {
    badge = { className: GAUGE_COLORS.neutral.badgeClassName, label: automationEnabled === false ? 'AUTOMATION DISABLED' : 'NO TARGET' };
  } else if (value == null) {
    badge = { className: GAUGE_COLORS.neutral.badgeClassName, label: 'NO DATA' };
  } else if (isBelowActive(value, low, hysteresis, belowOutletOn)) {
    badge = { className: lowColor.badgeClassName, label: lowLabel };
  } else if (aboveActive) {
    badge = { className: GAUGE_COLORS.alert.badgeClassName, label: highLabel };
  } else {
    badge = { className: GAUGE_COLORS.good.badgeClassName, label: 'IN RANGE' };
  }

  return (
    <div className="flex flex-1 flex-col items-center">
      <div className="relative w-full max-w-[220px]">
        <Gauge value={value} min={0} max={100} zones={zones} />
        <div className="absolute inset-x-0 top-[58%] -translate-y-1/2 text-center text-[1.6em] font-bold text-device-text">
          {value != null ? `${value.toFixed(1)}${unit}` : '—'}
        </div>
      </div>
      <p className="mt-1 text-[0.9em] text-device-text-secondary">{label}</p>
      <div className={`mt-2 rounded-full px-3 py-1 font-mono text-[0.75em] font-semibold ${badge.className}`}>
        {badge.label}
      </div>
      {hasTarget && (
        <p className="mt-1.5 text-[0.8em] text-device-text-tertiary">
          User Defined Optimal Range: {low.toFixed(1)} – {high.toFixed(1)}
          {unit}
        </p>
      )}
      <div className="mt-3 flex w-full items-center gap-2.5 rounded-lg bg-device-surface px-3 py-2.5 font-mono text-[0.8em] text-device-text">
        <span className={`h-2.5 w-2.5 flex-shrink-0 rounded-full ${controlStatus.dotClassName}`} />
        <span>{controlStatus.label}</span>
      </div>
    </div>
  );
}

// Everything in profile_config that isn't a temp/humidity target — the
// species profile itself and its light/UVB schedule — shown once to the
// left of the gauges rather than repeated per-gauge.
function ProfileSummary({ profileConfig }: { profileConfig: ProfileConfig | null }) {
  if (!profileConfig) {
    return (
      <div className="flex w-full max-w-[200px] flex-1 items-center justify-center rounded-xl bg-device-surface p-4 text-center text-[0.85em] text-device-text-tertiary">
        No profile configured
      </div>
    );
  }

  return (
    <div className="flex w-full max-w-[200px] flex-1 flex-col justify-center gap-3 rounded-xl bg-device-surface p-4">
      <div>
        <p className="text-[0.75em] text-device-text-tertiary">Species Profile</p>
        <p className="text-[1.1em] font-semibold text-device-text">{profileConfig.profile}</p>
      </div>
      <div className="border-t border-white/10 pt-3">
        <p className="text-[0.75em] text-device-text-tertiary">Day Light</p>
        <p className="text-[0.85em] text-device-text">
          {profileConfig.day_light_on} – {profileConfig.day_light_off}
        </p>
      </div>
      <div>
        <p className="text-[0.75em] text-device-text-tertiary">UVB</p>
        <p className="text-[0.85em] text-device-text">
          {profileConfig.uvb_on} – {profileConfig.uvb_off}
        </p>
      </div>
      <div>
        <p className="text-[0.75em] text-device-text-tertiary">Timezone</p>
        <p className="text-[0.85em] text-device-text">{profileConfig.timezone}</p>
      </div>
    </div>
  );
}

// Mirrors the on-device dashboard's two separate "Temperature Control
// Check" / "Humidity Control Check" status-boxes (docs/style-guide.md §8:
// "temperature side shown; humidity side mirrors it with misting/
// too-humid wording") — derived from the same reconstructed outlet +
// climate-target data rather than re-implementing the firmware's control
// logic from scratch.
function deriveTempStatus(state: ReconstructedState): { dotClassName: string; label: string } {
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

  if (state.tooHot) {
    return { dotClassName: 'bg-device-alert', label: 'TOO HOT — fan ON' };
  }

  return { dotClassName: 'bg-device-good', label: 'TEMP NORMAL — no action needed' };
}

function deriveHumidityStatus(state: ReconstructedState): { dotClassName: string; label: string } {
  if (state.automationEnabled === false) {
    return { dotClassName: 'bg-device-disabled', label: 'AUTOMATION DISABLED' };
  }
  if (state.automationEnabled == null) {
    return { dotClassName: 'bg-device-disabled', label: 'AUTOMATION STATUS UNKNOWN' };
  }

  const mister = state.outlets.find((outlet) => outlet.role === 'Mister');
  if (mister?.on) {
    return { dotClassName: 'bg-device-heating', label: 'MISTING — mister ON' };
  }

  if (state.tooHumid) {
    return { dotClassName: 'bg-device-alert', label: 'TOO HUMID — fan ON' };
  }

  return { dotClassName: 'bg-device-good', label: 'HUMIDITY NORMAL — no action needed' };
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

  // AutoRefresh (see the device timeline page) re-fetches fresh server data
  // every 20s on a rolling preset, which advances `toMs` to a later "now" —
  // but scrubMs only gets set once at mount, so without this the panel
  // would keep showing whatever instant it opened on forever, even though
  // the chart/event log behind it are genuinely live. Only follow `toMs`
  // forward when the scrubber was sitting at the previous live edge; once
  // the user drags it elsewhere, respect that and stop auto-advancing.
  const prevToMsRef = useRef(toMs);
  useEffect(() => {
    if (toMs !== prevToMsRef.current) {
      // Capture as a primitive before mutating the ref below — the updater
      // callback runs later, during React's commit, by which point the ref
      // itself would already read the NEW toMs if referenced directly
      // inside the closure, making this comparison always false and the
      // scrubber never actually advance.
      const previousToMs = prevToMsRef.current;
      setScrubMs((current) => (current === previousToMs ? toMs : current));
      prevToMsRef.current = toMs;
    }
  }, [toMs]);

  // Offline/reconnect + health-severity-change markers, computed purely
  // from data already fetched for this range — nothing persisted, nothing
  // written back to the device's own logs table (see src/lib/health.ts).
  const healthEvents = useMemo(
    () => deriveHealthEvents(data, { from: range.from, to: range.to }),
    [data, range.from, range.to],
  );
  const timelineEntries = useMemo(
    () => mergeTimelineEntries(data.allLogs, healthEvents),
    [data.allLogs, healthEvents],
  );

  // Same entries as the marker strip below (real logs + synthetic health
  // events) so the prev/next buttons step between exactly what's plotted.
  const eventTimestamps = useMemo(
    () => timelineEntries.map((entry) => new Date(entry.createdAt).getTime()),
    [timelineEntries],
  );

  // Last marker at/before the scrub position, for the "x/total" readout —
  // uses <=, unlike prev/next below, so it counts a marker the scrubber is
  // sitting exactly on as "reached."
  const eventsReached = useMemo(() => {
    let count = 0;
    for (const t of eventTimestamps) {
      if (t <= scrubMs) count++;
      else break;
    }
    return count;
  }, [eventTimestamps, scrubMs]);

  // Strictly-before/strictly-after so stepping from a position between two
  // markers always lands on the nearest one in that direction, and
  // stepping from a position exactly on a marker moves to its neighbor.
  const prevEventIndex = useMemo(() => {
    let idx = -1;
    for (let i = 0; i < eventTimestamps.length; i++) {
      if (eventTimestamps[i] < scrubMs) idx = i;
      else break;
    }
    return idx;
  }, [eventTimestamps, scrubMs]);

  const nextEventIndex = useMemo(() => {
    for (let i = 0; i < eventTimestamps.length; i++) {
      if (eventTimestamps[i] > scrubMs) return i;
    }
    return -1;
  }, [eventTimestamps, scrubMs]);

  // A red dashed line across each detected offline gap — otherwise Recharts
  // just draws a straight line through it in the normal data color, making
  // an hours-long outage look like continuous readings. Rendered as
  // separate two-point Line overlays (own `data`/dataKey, not the main
  // series) so only the gap itself is red, not the real data either side.
  const offlineGaps = useMemo(() => findTelemetryGaps(data.telemetry), [data.telemetry]);

  const chartData = useMemo(() => {
    const points = data.telemetry.map((row) => ({
      t: new Date(row.created_at).getTime(),
      tempF: celsiusToFahrenheit(row.temp_c) as number | null,
      hum: row.hum as number | null,
    }));
    // Real data has no marker for "nothing was reported here" — a null
    // point at the midpoint of each gap makes Recharts actually break the
    // main line there (connectNulls={false} below) instead of silently
    // connecting straight across it in the normal color, which would
    // otherwise render on top of / indistinguishable from the red overlay.
    const gapBreaks = offlineGaps.map((gap) => ({
      t: (new Date(gap.prev.created_at).getTime() + new Date(gap.curr.created_at).getTime()) / 2,
      tempF: null,
      hum: null,
    }));
    return [...points, ...gapBreaks].sort((a, b) => a.t - b.t);
  }, [data.telemetry, offlineGaps]);
  const tempGapSegments = useMemo(
    () =>
      offlineGaps.map((gap) => [
        { t: new Date(gap.prev.created_at).getTime(), gapTempF: celsiusToFahrenheit(gap.prev.temp_c) },
        { t: new Date(gap.curr.created_at).getTime(), gapTempF: celsiusToFahrenheit(gap.curr.temp_c) },
      ]),
    [offlineGaps],
  );
  const humGapSegments = useMemo(
    () =>
      offlineGaps.map((gap) => [
        { t: new Date(gap.prev.created_at).getTime(), gapHum: gap.prev.hum },
        { t: new Date(gap.curr.created_at).getTime(), gapHum: gap.curr.hum },
      ]),
    [offlineGaps],
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

  // Union across every segment's target range (not just the latest one),
  // so an older, wider band earlier in the window never gets clipped by a
  // domain sized only for the current config.
  const tempDomain = useMemo((): [number, number] | undefined => {
    const ranges = segments
      .map((s) => tempRangeC(s.config.profileConfig))
      .filter((r): r is { low: number; high: number } => r != null)
      .map((r) => ({ low: celsiusToFahrenheit(r.low), high: celsiusToFahrenheit(r.high) }));
    if (ranges.length === 0) return undefined;

    const values = chartData.map((d) => d.tempF).filter((v): v is number => v != null);
    if (values.length === 0) return undefined;

    return computeChartDomain(
      Math.min(...ranges.map((r) => r.low)),
      Math.max(...ranges.map((r) => r.high)),
      Math.min(...values),
      Math.max(...values),
    );
  }, [segments, chartData]);

  const humDomain = useMemo((): [number, number] | undefined => {
    const ranges = segments
      .map((s) => s.config.profileConfig)
      .filter((c): c is NonNullable<typeof c> => c?.hum_low != null && c?.hum_high != null);
    if (ranges.length === 0) return undefined;

    const values = chartData.map((d) => d.hum).filter((v): v is number => v != null);
    if (values.length === 0) return undefined;

    return computeChartDomain(
      Math.min(...ranges.map((c) => c.hum_low)),
      Math.max(...ranges.map((c) => c.hum_high)),
      Math.min(...values),
      Math.max(...values),
    );
  }, [segments, chartData]);

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
                <YAxis
                  yAxisId="temp"
                  stroke={CHART_COLORS.temp}
                  fontSize={12}
                  width={40}
                  domain={tempDomain ?? ['auto', 'auto']}
                />
                <YAxis
                  yAxisId="hum"
                  orientation="right"
                  stroke={CHART_COLORS.hum}
                  fontSize={12}
                  width={40}
                  domain={humDomain ?? ['auto', 'auto']}
                />
                <Tooltip
                  labelFormatter={(t) => formatTime(Number(t))}
                  contentStyle={{ background: CHART_COLORS.tooltipBg, border: 'none', fontSize: 12 }}
                  labelStyle={{ color: '#eee' }}
                />
                {segments.map((segment, i) => {
                  const range = tempRangeC(segment.config.profileConfig);
                  if (!range) return null;
                  return (
                    <ReferenceArea
                      key={`temp-band-${i}`}
                      yAxisId="temp"
                      x1={segment.start}
                      x2={segment.end}
                      y1={celsiusToFahrenheit(range.low)}
                      y2={celsiusToFahrenheit(range.high)}
                      fill={CHART_COLORS.tempBand}
                      fillOpacity={0.1}
                      stroke="none"
                    />
                  );
                })}
                {segments.map((segment, i) => {
                  const config = segment.config.profileConfig;
                  if (config?.hum_low == null || config?.hum_high == null) return null;
                  return (
                    <ReferenceArea
                      key={`hum-band-${i}`}
                      yAxisId="hum"
                      x1={segment.start}
                      x2={segment.end}
                      y1={config.hum_low}
                      y2={config.hum_high}
                      fill={CHART_COLORS.humBand}
                      fillOpacity={0.1}
                      stroke="none"
                    />
                  );
                })}
                <Line
                  yAxisId="temp"
                  type="stepAfter"
                  dataKey="tempF"
                  stroke={CHART_COLORS.temp}
                  strokeWidth={2}
                  dot={false}
                  name="Temp °F"
                  isAnimationActive={false}
                  connectNulls={false}
                />
                <Line
                  yAxisId="hum"
                  type="stepAfter"
                  dataKey="hum"
                  stroke={CHART_COLORS.hum}
                  strokeWidth={2}
                  dot={false}
                  name="Humidity %"
                  isAnimationActive={false}
                  connectNulls={false}
                />
                {tempGapSegments.map((segment, i) => (
                  <Line
                    key={`temp-gap-${i}`}
                    yAxisId="temp"
                    data={segment}
                    dataKey="gapTempF"
                    stroke={CHART_COLORS.offlineGap}
                    strokeWidth={3}
                    strokeDasharray="4 3"
                    dot={false}
                    legendType="none"
                    isAnimationActive={false}
                  />
                ))}
                {humGapSegments.map((segment, i) => (
                  <Line
                    key={`hum-gap-${i}`}
                    yAxisId="hum"
                    data={segment}
                    dataKey="gapHum"
                    stroke={CHART_COLORS.offlineGap}
                    strokeWidth={3}
                    strokeDasharray="4 3"
                    dot={false}
                    legendType="none"
                    isAnimationActive={false}
                  />
                ))}
                <ReferenceLine yAxisId="temp" x={scrubMs} stroke={CHART_COLORS.scrubLine} strokeDasharray="4 4" />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        )}

        <div className="relative mt-3 h-3 w-full">
          {timelineEntries.map((entry) => (
            <span
              key={entry.id}
              title={entry.kind === 'log' ? `[${entry.row.tag}] ${entry.row.message}` : entry.message}
              className={`absolute top-0 h-3 w-1 -translate-x-1/2 rounded-full ${LEVEL_DOT_CLASSNAMES[entry.level]}`}
              style={{ left: `${((new Date(entry.createdAt).getTime() - fromMs) / (toMs - fromMs)) * 100}%` }}
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

        <div className="mt-3 flex items-center justify-center gap-4">
          <button
            type="button"
            onClick={() => prevEventIndex !== -1 && setScrubMs(eventTimestamps[prevEventIndex])}
            disabled={prevEventIndex === -1}
            className="rounded bg-device-surface px-3 py-1 text-sm text-device-text-secondary transition hover:bg-device-surface-hover disabled:cursor-not-allowed disabled:opacity-30"
          >
            ◀ Prev
          </button>
          <p className="text-xs text-device-text-tertiary">
            {eventsReached}/{eventTimestamps.length} events
          </p>
          <button
            type="button"
            onClick={() => nextEventIndex !== -1 && setScrubMs(eventTimestamps[nextEventIndex])}
            disabled={nextEventIndex === -1}
            className="rounded bg-device-surface px-3 py-1 text-sm text-device-text-secondary transition hover:bg-device-surface-hover disabled:cursor-not-allowed disabled:opacity-30"
          >
            Next ▶
          </button>
        </div>
      </section>

      <ContextPanel state={state} />
      <EventLog data={data} entries={timelineEntries} />
    </div>
  );
}

function ContextPanel({ state }: { state: ReconstructedState }) {
  const tempRange = tempRangeC(state.config.profileConfig);
  const heater = state.outlets.find((outlet) => outlet.role === 'Heater');
  const mister = state.outlets.find((outlet) => outlet.role === 'Mister');

  return (
    <section className="rounded-2xl bg-device-screen p-6 shadow-device">
      <h2 className="mb-4 text-[1.1em] text-device-text">State at {formatTime(new Date(state.timestamp).getTime())}</h2>

      {state.config.isFallback && (
        <p className="mb-4 rounded-lg border border-device-heating/30 bg-device-heating/10 px-3 py-2 text-xs text-device-heating">
          No historized settings snapshot exists yet for this period — outlet roles/targets shown are the
          device&apos;s current config, which may not match this historical instant.
        </p>
      )}

      <div className="mb-6 flex flex-wrap gap-8">
        <ProfileSummary profileConfig={state.config.profileConfig} />
        <GaugeColumn
          label="Current Temperature"
          value={state.tempC != null ? celsiusToFahrenheit(state.tempC) : null}
          unit="°F"
          low={tempRange ? celsiusToFahrenheit(tempRange.low) : undefined}
          high={tempRange ? celsiusToFahrenheit(tempRange.high) : undefined}
          lowLabel="TOO COLD"
          highLabel="TOO HOT"
          lowColor={GAUGE_COLORS.cool}
          hysteresis={celsiusDeltaToFahrenheit(TEMP_HYSTERESIS_C)}
          belowOutletOn={heater?.on ?? null}
          aboveActive={state.tooHot}
          automationEnabled={state.automationEnabled}
          controlStatus={deriveTempStatus(state)}
        />
        <GaugeColumn
          label="Current Humidity"
          value={state.hum}
          unit="%"
          low={state.config.profileConfig?.hum_low}
          high={state.config.profileConfig?.hum_high}
          lowLabel="TOO DRY"
          highLabel="TOO HUMID"
          lowColor={GAUGE_COLORS.dry}
          hysteresis={HUMIDITY_HYSTERESIS_PCT}
          belowOutletOn={mister?.on ?? null}
          aboveActive={state.tooHumid}
          automationEnabled={state.automationEnabled}
          controlStatus={deriveHumidityStatus(state)}
        />
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
            {outlet.reason &&
              (isTestReason(outlet.reason) ? (
                <div
                  title="Triggered by the device's /climate-test page, not a real sensor reading"
                  className={`rounded px-2 py-0.5 text-center text-[0.7em] font-mono font-semibold ${GAUGE_COLORS.neutral.badgeClassName}`}
                >
                  🧪 TEST
                </div>
              ) : (
                <div
                  className={`rounded px-2 py-0.5 text-center text-[0.7em] font-mono font-semibold ${
                    reasonBadgeColor(outlet.reason).badgeClassName
                  }`}
                >
                  {reasonOnly(outlet.reason)}
                </div>
              ))}
            {outlet.since && (
              <p className="text-center text-[0.7em] text-device-text-tertiary">
                since {displayTime(outlet.since, outlet.sinceDeviceTime)}
              </p>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

// docs/style-guide.md §9 — event-row list, newest first for the whole
// selected range (not just up to the scrub position, unlike ContextPanel).
// Merges real logs with the synthetic offline/health-change markers from
// src/lib/health.ts — both render the same row shape, just with a
// different icon/message source (see TimelineEntry's discriminated kind).
function EventLog({ data, entries }: { data: DeviceTimelineData; entries: TimelineEntry[] }) {
  const newestFirst = useMemo(() => [...entries].reverse(), [entries]);

  return (
    <section className="rounded-2xl bg-device-card p-6 shadow-device">
      <h2 className="mb-4 text-[1.1em] text-device-text">Event log</h2>

      {newestFirst.length === 0 ? (
        <div className="rounded-xl bg-device-surface p-8 text-sm text-device-text-secondary">
          No events in this range.
        </div>
      ) : (
        <div className="flex max-h-[420px] flex-col gap-2.5 overflow-y-auto">
          {newestFirst.map((entry) => {
            if (entry.kind === 'health') {
              return (
                <div key={entry.id} className="flex items-center gap-3 rounded-lg bg-device-surface px-3 py-2.5">
                  <div className="w-[26px] flex-shrink-0 text-center text-[1.3em]">{entry.icon}</div>
                  <div className="w-[130px] flex-shrink-0 text-[0.8em] text-device-text-tertiary">
                    {formatTime(new Date(entry.createdAt).getTime())}
                  </div>
                  <div className="flex-1 text-[0.92em] text-device-text">{entry.message}</div>
                </div>
              );
            }

            const row = entry.row;
            const isTest = isTestReason(row.message);
            return (
              <div key={entry.id} className="flex items-center gap-3 rounded-lg bg-device-surface px-3 py-2.5">
                <div className="w-[26px] flex-shrink-0 text-center text-[1.3em]">
                  {iconForLog(row, data.device, data.configLogs)}
                </div>
                <div className="w-[130px] flex-shrink-0 text-[0.8em] text-device-text-tertiary">
                  {displayTime(row.created_at, row.device_time)}
                </div>
                <div className="flex-1 text-[0.92em] text-device-text">
                  <div className="flex flex-wrap items-center gap-2">
                    <span>{row.message}</span>
                    {isTest && (
                      <span
                        title="Triggered by the device's /climate-test page — a real outlet change, but not driven by an actual sensor reading"
                        className={`rounded px-1.5 py-0.5 text-[0.7em] font-mono font-semibold ${GAUGE_COLORS.neutral.badgeClassName}`}
                      >
                        TEST
                      </span>
                    )}
                  </div>
                  {row.temp_c != null && row.hum != null && (
                    <div className="mt-0.5 text-[0.75em] text-device-text-tertiary">
                      {celsiusToFahrenheit(row.temp_c).toFixed(1)}°F / {row.hum.toFixed(1)}% RH
                      {isTest && ' (real reading — not what drove this test)'}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
