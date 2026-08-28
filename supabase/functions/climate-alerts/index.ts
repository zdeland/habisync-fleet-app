// Favorite-device climate alerts — the scheduled sweep. See
// docs/climate-alerts.md for the full design (including why this has to be
// a Deno Edge Function talking to SMTP directly, rather than reusing
// Supabase Auth's SMTP config through some API — there isn't one).
//
// Invoked once a minute by supabase/climate_alerts_cron.sql via pg_cron +
// pg_net's net.http_post. Not part of the firmware repo's schema and never
// touches devices/logs/telemetry writes — read-only against those, like the
// rest of this webapp (docs/monitoring-webapp-plan.md §2).
//
// This is the first Edge Function in this repo — Deno, not Node, so it
// can't import anything under src/lib/ (a Next.js/postgrest-typed module
// tree). Anywhere this duplicates a constant/formula that already exists
// there, the comment says so explicitly — keep both in sync by hand, same
// convention already used for test/fixtures/climate_vectors.json being
// "copied verbatim... re-copy whenever it changes" (docs/known-issues.md).

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';
import { sendEmail } from '../_shared/sendEmail.ts';
import { detectSustainedCondition, outOfRange, SUSTAINED_OUT_OF_RANGE_MS, MAX_SAMPLE_GAP_MS } from '../_shared/climateDetection.ts';

// Mirrors src/lib/queries.ts's STALE_AFTER_MS (HEARTBEAT_INTERVAL_MS * 2,
// 10 min) — a device that hasn't heartbeated in this long is presumed fully
// offline. Its last known telemetry could be arbitrarily old at that point,
// so it's skipped entirely rather than evaluated as "still true now." Keep
// this in sync with src/lib/queries.ts by hand; treat drift as a bug.
const STALE_AFTER_MS = 10 * 60 * 1000;

// Mirrors src/lib/units.ts's celsiusToFahrenheit — for the email body only.
function celsiusToFahrenheit(c: number): number {
  return c * (9 / 5) + 32;
}

// Mirrors src/lib/units.ts's tempRangeC: profile_config's temp target range
// can be under either the current `_c` keys or the legacy `_f` keys (a
// JSONB blob only gets rewritten on a device's next settings-save) — see
// the ProfileConfig comment in src/lib/types.ts. Read via this helper only.
function tempRangeC(profileConfig) {
  if (profileConfig.temp_low_c != null && profileConfig.temp_high_c != null) {
    return { low: profileConfig.temp_low_c, high: profileConfig.temp_high_c };
  }
  if (profileConfig.temp_low_f != null && profileConfig.temp_high_f != null) {
    return { low: ((profileConfig.temp_low_f - 32) * 5) / 9, high: ((profileConfig.temp_high_f - 32) * 5) / 9 };
  }
  return null;
}

const METRICS = [
  {
    key: 'temp',
    label: 'Temperature',
    unit: '°F',
    // telemetry.temp_c is native Celsius (firmware 0.5.0+); display and
    // thresholds are both converted to Fahrenheit here to match the rest of
    // the app's display convention (src/lib/units.ts).
    valueOf: (telemetry) => celsiusToFahrenheit(telemetry.temp_c),
    rangeOf: (profileConfig) => {
      const range = tempRangeC(profileConfig);
      return range ? { low: celsiusToFahrenheit(range.low), high: celsiusToFahrenheit(range.high) } : null;
    },
  },
  {
    key: 'humidity',
    label: 'Humidity',
    unit: '%',
    valueOf: (telemetry) => telemetry.hum,
    rangeOf: (profileConfig) =>
      profileConfig.hum_low != null && profileConfig.hum_high != null
        ? { low: profileConfig.hum_low, high: profileConfig.hum_high }
        : null,
  },
];

function formatValue(value: number, unit: string): string {
  return `${value.toFixed(1)}${unit}`;
}

function emailBodyForOpen(deviceName: string, deviceId: string, metricLabel: string, value: number, unit: string, low: number, high: number, sinceMs: number, appBaseUrl: string): string {
  const minutesAgo = Math.round((Date.now() - sinceMs) / 60_000);
  return [
    `${deviceName} (${deviceId})'s ${metricLabel.toLowerCase()} has been outside its target range for over ${minutesAgo} minute${minutesAgo === 1 ? '' : 's'}.`,
    ``,
    `Current reading: ${formatValue(value, unit)}`,
    `Target range: ${formatValue(low, unit)} – ${formatValue(high, unit)}`,
    ``,
    `${appBaseUrl}/devices/${deviceId}`,
  ].join('\n');
}

function emailBodyForResolved(deviceName: string, deviceId: string, metricLabel: string, value: number, unit: string, low: number, high: number, appBaseUrl: string): string {
  return [
    `${deviceName} (${deviceId})'s ${metricLabel.toLowerCase()} is back in range.`,
    ``,
    `Current reading: ${formatValue(value, unit)}`,
    `Target range: ${formatValue(low, unit)} – ${formatValue(high, unit)}`,
    ``,
    `${appBaseUrl}/devices/${deviceId}`,
  ].join('\n');
}

Deno.serve(async (req: Request) => {
  const cronSecret = Deno.env.get('CRON_SHARED_SECRET');
  if (!cronSecret || req.headers.get('X-Cron-Secret') !== cronSecret) {
    return new Response('unauthorized', { status: 401 });
  }

  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const appBaseUrl = Deno.env.get('APP_BASE_URL') ?? '';

  // 1. Who's favorited what, and who to email for each device — carry the
  // user_id alongside the email, since the per-recipient notification ledger
  // (climate_alert_notifications) is keyed by user, not email.
  const { data: favorites, error: favoritesError } = await supabase
    .from('favorite_devices')
    .select('device_id, user_id');
  if (favoritesError) throw favoritesError;
  if (!favorites || favorites.length === 0) return new Response('no favorites', { status: 200 });

  const deviceIds = Array.from(new Set(favorites.map((f) => f.device_id)));
  const userIds = Array.from(new Set(favorites.map((f) => f.user_id)));

  const { data: profiles, error: profilesError } = await supabase.from('profiles').select('id, email').in('id', userIds);
  if (profilesError) throw profilesError;
  const emailByUserId = new Map((profiles ?? []).map((p) => [p.id, p.email]));

  const favoritersByDevice = new Map<string, { userId: string; email: string }[]>();
  for (const fav of favorites) {
    const email = emailByUserId.get(fav.user_id);
    if (!email) {
      console.warn(`skipping favorite: no email for user ${fav.user_id}`);
      continue;
    }
    const list = favoritersByDevice.get(fav.device_id) ?? [];
    list.push({ userId: fav.user_id, email });
    favoritersByDevice.set(fav.device_id, list);
  }

  // 2. Existing open climate_alerts, keyed by (device_id, metric).
  const { data: openAlerts, error: openAlertsError } = await supabase
    .from('climate_alerts')
    .select('*')
    .eq('status', 'open')
    .in('device_id', deviceIds);
  if (openAlertsError) throw openAlertsError;
  const openAlertByKey = new Map((openAlerts ?? []).map((a) => [`${a.device_id}:${a.metric}`, a]));

  // 3. Who's already been notified, per open alert — the ledger is the
  // source of truth for de-dup (not a per-alert-row flag), so a favoriter
  // who joins mid-alert gets caught up on their next sweep.
  const openedByAlert = new Map<number, Set<string>>();
  const resolvedByAlert = new Map<number, Set<string>>();
  const alertIds = (openAlerts ?? []).map((a) => a.id);
  if (alertIds.length > 0) {
    const { data: notifs, error: notifsError } = await supabase
      .from('climate_alert_notifications')
      .select('alert_id, user_id, kind')
      .in('alert_id', alertIds);
    if (notifsError) throw notifsError;
    for (const n of notifs ?? []) {
      const target = n.kind === 'opened' ? openedByAlert : resolvedByAlert;
      const set = target.get(n.alert_id) ?? new Set<string>();
      set.add(n.user_id);
      target.set(n.alert_id, set);
    }
  }

  // Emails every current favoriter who has no 'opened' ledger row for this
  // alert yet — the initial open, new mid-alert favoriters, and retries of
  // earlier failed sends all funnel through here. A failed send leaves no
  // ledger row, so it's retried next sweep; the row is inserted only after
  // the email actually goes out.
  async function notifyOpen(
    alertId: number,
    subject: string,
    body: string,
    favoriters: { userId: string; email: string }[],
  ) {
    const opened = openedByAlert.get(alertId) ?? new Set<string>();
    for (const f of favoriters) {
      if (opened.has(f.userId)) continue;
      try {
        await sendEmail(f.email, subject, body);
        const { error } = await supabase
          .from('climate_alert_notifications')
          .insert({ alert_id: alertId, user_id: f.userId, kind: 'opened' });
        if (error && error.code !== '23505') console.error(`ledger insert (opened) failed for ${f.userId}/${alertId}:`, error);
        opened.add(f.userId);
      } catch (sendError) {
        console.error(`failed to send open-alert email to ${f.email} for alert ${alertId}:`, sendError);
      }
    }
    openedByAlert.set(alertId, opened);
  }

  // Resolve email goes to exactly the users who were told this alert opened
  // (have an 'opened' row) and are still favoriting the device — no "back in
  // range" for an alert someone was never alerted about, and no duplicate
  // once they have a 'resolved' row.
  async function notifyResolve(
    alertId: number,
    subject: string,
    body: string,
    favoriters: { userId: string; email: string }[],
  ) {
    const opened = openedByAlert.get(alertId) ?? new Set<string>();
    const resolved = resolvedByAlert.get(alertId) ?? new Set<string>();
    for (const f of favoriters) {
      if (!opened.has(f.userId) || resolved.has(f.userId)) continue;
      try {
        await sendEmail(f.email, subject, body);
        const { error } = await supabase
          .from('climate_alert_notifications')
          .insert({ alert_id: alertId, user_id: f.userId, kind: 'resolved' });
        if (error && error.code !== '23505') console.error(`ledger insert (resolved) failed for ${f.userId}/${alertId}:`, error);
      } catch (sendError) {
        console.error(`failed to send resolved-alert email to ${f.email} for alert ${alertId}:`, sendError);
      }
    }
  }

  const now = Date.now();

  for (const deviceId of deviceIds) {
    const favoriters = favoritersByDevice.get(deviceId) ?? [];
    if (favoriters.length === 0) continue;

    const { data: device, error: deviceError } = await supabase
      .from('devices')
      .select('*')
      .eq('device_id', deviceId)
      .maybeSingle();
    if (deviceError) throw deviceError;
    if (!device) continue; // favorited device since deleted — favorite_devices cascades, next sweep won't see it

    // Skip stale devices entirely — see STALE_AFTER_MS comment above.
    if (now - new Date(device.last_seen).getTime() > STALE_AFTER_MS) continue;

    // NOTE: we deliberately do NOT skip devices whose profile is disabled.
    // A disabled profile still has a real target range, and nothing is
    // actively correcting the drift — arguably exactly when a favoriter
    // wants to know. Consistent with the device page (DeviceTimeline.tsx's
    // ReadingCard / the fleet table), which colorizes out-of-range readings
    // even when automation is off. Only a genuinely absent target range
    // (metric.rangeOf === null, below) exempts a metric.

    const { data: telemetryRows, error: telemetryError } = await supabase
      .from('telemetry')
      .select('created_at, temp_c, hum')
      .eq('device_id', deviceId)
      .order('created_at', { ascending: false })
      .limit(60);
    if (telemetryError) throw telemetryError;
    if (!telemetryRows || telemetryRows.length === 0) continue;

    for (const metric of METRICS) {
      const range = metric.rangeOf(device.profile_config);
      if (!range) continue; // no target configured for this metric

      const samples = telemetryRows.map((row) => ({
        createdAtMs: new Date(row.created_at).getTime(),
        value: metric.valueOf(row),
      }));

      const result = detectSustainedCondition(
        samples,
        outOfRange(range.low, range.high),
        SUSTAINED_OUT_OF_RANGE_MS,
        MAX_SAMPLE_GAP_MS,
      );

      const key = `${deviceId}:${metric.key}`;
      const existing = openAlertByKey.get(key);
      const outOfRangeSubject = `${device.name}: ${metric.label} out of range`;

      if (!existing) {
        if (!result.isSustainedViolation) continue; // not out of range long enough yet

        // New sustained episode — open it, then notify all current favoriters
        // (none have a ledger row for this brand-new alert id).
        const { data: inserted, error: insertError } = await supabase
          .from('climate_alerts')
          .insert({
            device_id: deviceId,
            metric: metric.key,
            status: 'open',
            out_of_range_since: new Date(result.violatingSinceMs!).toISOString(),
            observed_value: result.latestValue,
            low_threshold: range.low,
            high_threshold: range.high,
          })
          .select('id')
          .single();
        // 23505 = a concurrent sweep already opened it; skip this pass and
        // let the next one catch up via the existing-alert branch below.
        if (insertError && insertError.code !== '23505') throw insertError;
        if (!inserted) continue;

        const body = emailBodyForOpen(
          device.name, deviceId, metric.label, result.latestValue!, metric.unit,
          range.low, range.high, result.violatingSinceMs!, appBaseUrl,
        );
        await notifyOpen(inserted.id, outOfRangeSubject, body, favoriters);
        continue;
      }

      if (result.isViolatingNow) {
        // Still out of range — catch up any favoriter without an 'opened'
        // row (a new mid-alert favoriter, or an earlier failed send).
        const body = emailBodyForOpen(
          device.name, deviceId, metric.label, Number(existing.observed_value), metric.unit,
          Number(existing.low_threshold), Number(existing.high_threshold),
          new Date(existing.out_of_range_since).getTime(), appBaseUrl,
        );
        await notifyOpen(existing.id, outOfRangeSubject, body, favoriters);
      } else {
        // Back in range — resolve, then notify everyone who got the open.
        const body = emailBodyForResolved(
          device.name, deviceId, metric.label, result.latestValue!, metric.unit,
          Number(existing.low_threshold), Number(existing.high_threshold), appBaseUrl,
        );
        await notifyResolve(existing.id, `${device.name}: ${metric.label} back in range`, body, favoriters);
        await supabase
          .from('climate_alerts')
          .update({ status: 'resolved', resolved_at: new Date().toISOString() })
          .eq('id', existing.id);
      }
    }
  }

  return new Response('ok', { status: 200 });
});
