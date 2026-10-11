'use client';

// The probe cap test report for one HabiSync 1.0 unit — fleet-handoff-1.3.0
// §6. The numbers come from src/lib/probeTest.ts, a port of the firmware
// repo's scripts/probe_test_report.py; the tables follow that script's
// report section for section so a view can be checked against it. Values
// stay in °C here, as in the script and the firmware's own Results card:
// they're small differences, and the comparison is the point.
import { useMemo, useState } from 'react';
import Link from 'next/link';
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { ProbeTestReport, ProbeTestSession, ReferenceKind } from '@/lib/probeTest';
import { isOverdue } from '@/lib/probeTest';
import { portLabel } from '@/lib/probes';
import { GAUGE_COLORS } from '@/lib/gaugeColors';
import { CHART_COLORS, formatTime } from '@/components/DeviceTimeline';
import { PORT_COLORS } from '@/components/MonitorTimeline';

const signed = (value: number, digits: number) => `${value >= 0 ? '+' : ''}${value.toFixed(digits)}`;
const meanOf = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

function statusOf(session: ProbeTestSession, nowMs: number): { label: string; className: string } {
  if (session.status === 'finished') return { label: 'FINISHED', className: GAUGE_COLORS.good.badgeClassName };
  if (session.status === 'abandoned') return { label: 'ABANDONED', className: GAUGE_COLORS.neutral.badgeClassName };
  if (isOverdue(session, nowMs)) return { label: 'STOPPED REPORTING', className: GAUGE_COLORS.alert.badgeClassName };
  return { label: 'RUNNING', className: GAUGE_COLORS.cool.badgeClassName };
}

function Badge({ label, className }: { label: string; className: string }) {
  return <span className={`rounded px-2 py-0.5 font-mono text-[0.7em] font-semibold ${className}`}>{label}</span>;
}

function Card({ title, children, note }: { title: string; children: React.ReactNode; note?: React.ReactNode }) {
  return (
    <section className="rounded-2xl bg-device-card p-4 shadow-device sm:p-6">
      <h2 className="text-[1.1em] font-medium text-device-text">{title}</h2>
      {note && <p className="mt-1 text-[0.8em] text-device-text-secondary">{note}</p>}
      <div className="mt-4">{children}</div>
    </section>
  );
}

function SessionList({ deviceId, sessions, selectedId, nowMs }: { deviceId: string; sessions: ProbeTestSession[]; selectedId: string | null; nowMs: number }) {
  const [showAbandoned, setShowAbandoned] = useState(false);
  // Abandoned starts not already on screen as the selected one.
  const abandoned = sessions.filter((s) => s.status === 'abandoned' && s.id !== selectedId).length;
  // Abandoned starts are usually restarts; hidden unless asked for, or
  // unless it's the one being viewed.
  const visible = sessions.filter((s) => showAbandoned || s.status !== 'abandoned' || s.id === selectedId);

  return (
    <Card title="Sessions">
      <div className="flex flex-col gap-2">
        {visible.map((session) => {
          const status = statusOf(session, nowMs);
          const isSelected = session.id === selectedId;
          return (
            <Link
              key={session.id}
              href={`/devices/${deviceId}/probe-test?s=${session.id}`}
              className={`flex flex-wrap items-center justify-between gap-2 rounded-lg px-3 py-2.5 text-sm transition ${
                isSelected ? 'bg-device-accent/15 text-device-text' : 'bg-device-surface text-device-text-secondary hover:bg-device-surface-hover'
              }`}
            >
              <span>
                {formatTime(new Date(session.startedAt).getTime())}
                {session.durationMin != null && ` · ${session.durationMin / 60} h`}
                {` · ${session.ports.map((p) => portLabel(p)).join(', ')}`}
              </span>
              <Badge {...status} />
            </Link>
          );
        })}
      </div>
      {abandoned > 0 && (
        <button
          type="button"
          onClick={() => setShowAbandoned((v) => !v)}
          className="mt-3 text-xs text-device-accent hover:underline"
        >
          {showAbandoned ? 'Hide' : 'Show'} {abandoned} abandoned start{abandoned === 1 ? '' : 's'}
        </button>
      )}
    </Card>
  );
}

function SessionSummary({ session, report, nowMs }: { session: ProbeTestSession; report: ProbeTestReport; nowMs: number }) {
  const status = statusOf(session, nowMs);
  return (
    <Card
      title="This session"
      note={
        <>
          {report.rows} rows, {report.minutes} minutes, {report.comparedMinutes} with two or more probes;{' '}
          {report.settlingDropped} port-minutes left out while settling (10 min after a cap change);{' '}
          {report.referenceValues} reference values.
        </>
      }
    >
      <div className="flex flex-col gap-3 text-sm text-device-text-secondary">
        <div className="flex flex-wrap items-center gap-2">
          <Badge {...status} />
          <span>
            Started {formatTime(new Date(session.startedAt).getTime())}
            {session.endedAt && `, ended ${formatTime(new Date(session.endedAt).getTime())}`}
            {session.durationMin != null && ` · planned ${session.durationMin / 60} h`}
            {session.allCappedPhase && ' · with a final all-capped phase'}
          </span>
        </div>
        <div>
          <p className="mb-1 text-[0.8em] uppercase tracking-wider text-device-text-tertiary">Cap moves confirmed</p>
          {session.caps.length === 0 ? (
            <p>{session.status === 'open' ? 'None yet — still in the uncapped baseline.' : 'None confirmed.'}</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {session.caps.map((change) => (
                <li key={`${change.phase}-${change.at}`}>
                  {formatTime(new Date(change.at).getTime())} · phase {change.phase} ·{' '}
                  {change.capped.length === 0 ? 'no caps' : `capped: ${change.capped.map((p) => portLabel(p)).join(', ')}`}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </Card>
  );
}

function CapEffectCard({ report }: { report: ProbeTestReport }) {
  return (
    <Card
      title="Cap effect"
      note="What putting the cap on changes in each probe's reading, with the probe's own bias taken out. Positive means warmer or more humid. Fitted per minute against the group, as the firmware's report does — exact when every cap has the same effect, pulled toward the group's average when they differ."
    >
      {report.capEffects.length === 0 ? (
        <p className="text-sm text-device-text-secondary">No minutes with two or more probes yet.</p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-[0.8em] text-device-text-tertiary">
              <th className="py-1 font-normal">Probe</th>
              <th className="py-1 text-right font-normal">Temperature</th>
              <th className="py-1 text-right font-normal">Humidity</th>
            </tr>
          </thead>
          <tbody className="font-mono text-device-text">
            {report.capEffects.map((effect) => (
              <tr key={effect.port} className="border-t border-white/5">
                <td className="py-1.5 font-sans">
                  <PortName port={effect.port} />
                </td>
                {effect.tempC == null ? (
                  <td colSpan={2} className="py-1.5 text-right font-sans text-device-text-tertiary">
                    needs minutes both capped and uncapped
                  </td>
                ) : (
                  <>
                    <td className="py-1.5 text-right">{signed(effect.tempC, 2)} °C</td>
                    <td className="py-1.5 text-right">{signed(effect.hum!, 1)} %RH</td>
                  </>
                )}
              </tr>
            ))}
            {report.pooledCapEffect && (
              <tr className="border-t border-white/10">
                <td className="py-1.5 font-sans font-medium">All probes</td>
                <td className="py-1.5 text-right">{signed(report.pooledCapEffect.tempC, 2)} °C</td>
                <td className="py-1.5 text-right">{signed(report.pooledCapEffect.hum, 1)} %RH</td>
              </tr>
            )}
          </tbody>
        </table>
      )}
    </Card>
  );
}

function PortName({ port }: { port: number }) {
  return (
    <span className="inline-flex items-center gap-2">
      <span className="h-2.5 w-2.5 rounded-full" style={{ background: PORT_COLORS[port] ?? PORT_COLORS[0] }} />
      {portLabel(port)}
    </span>
  );
}

function OffsetCard({ report }: { report: ProbeTestReport }) {
  return (
    <Card
      title="Offset from the group"
      note="Each minute, how a probe reads against the mean of every probe read that minute — the room's swings cancel out. Mean ± standard deviation."
    >
      <div className="overflow-x-auto">
        <table className="w-full min-w-[520px] text-sm">
          <thead>
            <tr className="text-left text-[0.8em] text-device-text-tertiary">
              <th className="py-1 font-normal">Probe</th>
              <th className="py-1 font-normal">Cap</th>
              <th className="py-1 text-right font-normal">Minutes</th>
              <th className="py-1 text-right font-normal">Mean</th>
              <th className="py-1 text-right font-normal">Temp offset</th>
              <th className="py-1 text-right font-normal">Hum offset</th>
            </tr>
          </thead>
          <tbody className="font-mono text-device-text">
            {report.offsets.map((o) => (
              <tr key={`${o.port}-${o.cap}`} className="border-t border-white/5">
                <td className="py-1.5 font-sans">
                  <PortName port={o.port} />
                </td>
                <td className="py-1.5 font-sans">{o.cap}</td>
                <td className="py-1.5 text-right">{o.minutes}</td>
                <td className="py-1.5 text-right">
                  {o.meanTempC.toFixed(2)} °C · {o.meanHum.toFixed(1)}%
                </td>
                <td className="py-1.5 text-right">
                  {signed(o.tempOffset.mean, 2)} ± {o.tempOffset.sd.toFixed(2)} °C
                </td>
                <td className="py-1.5 text-right">
                  {signed(o.humOffset.mean, 1)} ± {o.humOffset.sd.toFixed(1)} %RH
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

const REFERENCE_LABELS: Record<ReferenceKind, { label: string; unit: string; digits: number }> = {
  tip: { label: 'its tip (IR)', unit: '°C', digits: 2 },
  target: { label: 'target (IR)', unit: '°C', digits: 2 },
  room: { label: 'thermostat', unit: '°C', digits: 2 },
  roomH: { label: 'thermostat RH', unit: '%RH', digits: 1 },
};

function ReferenceCell({ values, kind }: { values: number[]; kind: ReferenceKind }) {
  if (values.length === 0) return <td className="py-1.5 text-right text-device-text-tertiary">—</td>;
  const { unit, digits } = REFERENCE_LABELS[kind];
  return (
    <td className="py-1.5 text-right">
      {signed(meanOf(values), digits)} {unit} <span className="text-device-text-tertiary">(n={values.length})</span>
    </td>
  );
}

const toF = (c: number) => (c * 9) / 5 + 32;

// °C as logged, with the °F the person actually typed in alongside.
function Temp({ c }: { c: number | null }) {
  if (c == null || !Number.isFinite(c)) return <span className="text-device-text-tertiary">—</span>;
  return (
    <>
      {c.toFixed(2)} °C <span className="text-device-text-tertiary">({toF(c).toFixed(1)} °F)</span>
    </>
  );
}

function RoundsCard({ report }: { report: ProbeTestReport }) {
  if (report.rounds.length === 0) return null;
  return (
    <Card
      title="Reference rounds"
      note="The readings as entered on the unit, one round per row: the thermostat, the IR thermometer on the neutral target, and on each probe's tip (with the probe's own reading at that moment)."
    >
      <div className="flex flex-col gap-3">
        {report.rounds.map((round) => (
          <div key={`${round.at}-${round.phase}`} className="rounded-lg bg-device-surface px-3 py-2.5 text-sm">
            <div className="text-device-text-secondary">
              {formatTime(new Date(round.at).getTime())}
              {round.phase != null && ` · phase ${round.phase}`}
            </div>
            <div className="mt-2 grid grid-cols-1 gap-x-6 gap-y-1 font-mono text-device-text sm:grid-cols-2">
              <div>
                <span className="font-sans text-device-text-tertiary">Thermostat </span>
                <Temp c={round.roomC} />
                {round.roomHum != null && ` · ${round.roomHum.toFixed(0)} %RH`}
              </div>
              <div>
                <span className="font-sans text-device-text-tertiary">Target (IR) </span>
                <Temp c={round.targetIrC} />
              </div>
              {round.probes.map((probe) => (
                <div key={probe.port}>
                  <span className="font-sans text-device-text-tertiary">
                    {portLabel(probe.port)} tip (IR, {probe.cap}){' '}
                  </span>
                  <Temp c={probe.irC} />
                  {probe.readingC != null && (
                    <span className="text-device-text-tertiary"> · probe read {probe.readingC.toFixed(2)} °C</span>
                  )}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}

function ReferenceCard({ report }: { report: ProbeTestReport }) {
  if (report.references.length === 0) {
    return (
      <Card title="Probe minus reference">
        <p className="text-sm text-device-text-secondary">No reference rounds entered yet.</p>
      </Card>
    );
  }
  return (
    <Card
      title="Probe minus reference"
      note="Averaged over the reference rounds. IR reads a surface — the cap's outside when capped, the housing when not — so compare between probes and phases rather than trusting absolutes. The thermostat usually shows whole °F: use it for trend and humidity."
    >
      <div className="overflow-x-auto">
        <table className="w-full min-w-[480px] text-sm">
          <thead>
            <tr className="text-left text-[0.8em] text-device-text-tertiary">
              <th className="py-1 font-normal">Probe</th>
              <th className="py-1 font-normal">vs</th>
              <th className="py-1 text-right font-normal">Uncapped</th>
              <th className="py-1 text-right font-normal">Capped</th>
            </tr>
          </thead>
          <tbody className="font-mono text-device-text">
            {report.references.map((r) => (
              <tr key={`${r.port}-${r.kind}`} className="border-t border-white/5">
                <td className="py-1.5 font-sans">
                  <PortName port={r.port} />
                </td>
                <td className="py-1.5 font-sans">{REFERENCE_LABELS[r.kind].label}</td>
                <ReferenceCell values={r.uncapped} kind={r.kind} />
                <ReferenceCell values={r.capped} kind={r.kind} />
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

// Each probe's offset over the session, one line per probe in its port
// color; capped stretches dashed, settling minutes left out — so the
// phases, and what moving the cap did, are visible at a glance.
function OffsetChart({ report, metric }: { report: ProbeTestReport; metric: 'temp' | 'hum' }) {
  const { points, ports } = useMemo(() => {
    const byMinute = new Map<number, Record<string, number>>();
    const portSet = new Set<number>();
    for (const s of report.series) {
      if (s.settling) continue;
      portSet.add(s.port);
      const point = byMinute.get(s.minute) ?? { t: s.minute };
      point[`p${s.port}${s.cap === 'capped' ? 'c' : ''}`] = metric === 'temp' ? s.tempOffset : s.humOffset;
      byMinute.set(s.minute, point);
    }
    return {
      points: Array.from(byMinute.values()).sort((a, b) => a.t - b.t),
      ports: Array.from(portSet).sort((a, b) => a - b),
    };
  }, [report.series, metric]);

  if (points.length === 0) return null;
  const unit = metric === 'temp' ? '°C' : '%RH';
  return (
    <div>
      <p className="mb-2 text-sm text-device-text-secondary">
        {metric === 'temp' ? 'Temperature' : 'Humidity'} offset from the group ({unit}) — dashed while capped
      </p>
      <div className="h-56 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={points} margin={{ left: 0, right: 8, top: 8, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={CHART_COLORS.grid} />
            <XAxis dataKey="t" type="number" domain={['dataMin', 'dataMax']} tickFormatter={formatTime} stroke={CHART_COLORS.axis} fontSize={12} />
            <YAxis stroke={CHART_COLORS.axis} fontSize={12} width={44} domain={['auto', 'auto']} />
            <Tooltip
              labelFormatter={(t) => formatTime(Number(t))}
              formatter={(value) => (typeof value === 'number' ? `${signed(value, metric === 'temp' ? 2 : 1)} ${unit}` : value)}
              contentStyle={{ background: CHART_COLORS.tooltipBg, border: 'none', fontSize: 12 }}
              labelStyle={{ color: '#eee' }}
            />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            {ports.flatMap((port) => [
              <Line
                key={`p${port}`}
                dataKey={`p${port}`}
                name={`${portLabel(port)} uncapped`}
                stroke={PORT_COLORS[port] ?? PORT_COLORS[0]}
                strokeWidth={2}
                dot={false}
                isAnimationActive={false}
                connectNulls={false}
              />,
              <Line
                key={`p${port}c`}
                dataKey={`p${port}c`}
                name={`${portLabel(port)} capped`}
                stroke={PORT_COLORS[port] ?? PORT_COLORS[0]}
                strokeWidth={2}
                strokeDasharray="5 3"
                dot={false}
                isAnimationActive={false}
                connectNulls={false}
                legendType="plainline"
              />,
            ])}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

export default function ProbeTestView({
  deviceId,
  sessions,
  selected,
  report,
  nowMs,
}: {
  deviceId: string;
  sessions: ProbeTestSession[];
  selected: ProbeTestSession | null;
  report: ProbeTestReport | null;
  nowMs: number;
}) {
  if (sessions.length === 0) {
    return (
      <Card title="No probe cap tests">
        <p className="text-sm text-device-text-secondary">
          This unit hasn&apos;t logged a probe cap test. Start one from <span className="font-mono">/probe-test</span> on the
          unit, with Remote Monitoring on so its rows reach the cloud.
        </p>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <SessionList deviceId={deviceId} sessions={sessions} selectedId={selected?.id ?? null} nowMs={nowMs} />
      {selected && report && (
        <>
          <SessionSummary session={selected} report={report} nowMs={nowMs} />
          <CapEffectCard report={report} />
          <Card title="Offsets over the session">
            <div className="flex flex-col gap-6">
              <OffsetChart report={report} metric="temp" />
              <OffsetChart report={report} metric="hum" />
            </div>
          </Card>
          <OffsetCard report={report} />
          <ReferenceCard report={report} />
          <RoundsCard report={report} />
        </>
      )}
    </div>
  );
}
