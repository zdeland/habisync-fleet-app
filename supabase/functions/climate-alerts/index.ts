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

  // 1. Who's favorited what, and who to email for each device.
  const { data: favorites, error: favoritesError } = await supabase
    .from('favorite_devices')
    .select('device_id, user_id');
  if (favoritesError) throw favoritesError;
  if (!favorites || favorites.length === 0) return new Response('no favorites', { status: 200 });

    const deviceIds = Array.from(new Set(favorites.map((f) => f.device_id)));
    const userIds = Array.from(new Set(favorites.map((f) => f.user_id)));

    const { data: profiles, error: profilesError } = await supabase
      .from('profiles')
      .select('id, email')
      .in('id', userIds);
    if (profilesError) throw profilesError;
    const emailByUserId = new Map((profiles ?? []).map((p) => [p.id, p.email]));

    const recipientsByDevice = new Map<string, string[]>();
    for (const fav of favorites) {
      const email = emailByUserId.get(fav.user_id);
      if (!email) {
        console.warn(`skipping favorite: no email for user ${fav.user_id}`);
        continue;
      }
      const list = recipientsByDevice.get(fav.device_id) ?? [];
      list.push(email);
      recipientsByDevice.set(fav.device_id, list);
    }

    // 2. Existing open climate_alerts, keyed by (device_id, metric).
    const { data: openAlerts, error: openAlertsError } = await supabase
      .from('climate_alerts')
      .select('*')
      .eq('status', 'open')
      .in('device_id', deviceIds);
    if (openAlertsError) throw openAlertsError;
    const openAlertByKey = new Map((openAlerts ?? []).map((a) => [`${a.device_id}:${a.metric}`, a]));

    const now = Date.now();

    for (const deviceId of deviceIds) {
      const recipients = recipientsByDevice.get(deviceId) ?? [];
      if (recipients.length === 0) continue;

      const { data: device, error: deviceError } = await supabase
        .from('devices')
        .select('*')
        .eq('device_id', deviceId)
        .maybeSingle();
      if (deviceError) throw deviceError;
      if (!device) continue; // favorited device since deleted — favorite_devices cascades, next sweep won't see it

      // Skip stale devices entirely — see STALE_AFTER_MS comment above.
      if (now - new Date(device.last_seen).getTime() > STALE_AFTER_MS) continue;

      // Skip devices with automation disabled — an intentionally-disabled
      // target isn't an alarming reading (mirrors the same reasoning in
      // src/components/DeviceTimeline.tsx's ReadingCard).
      if (device.profile_config?.enabled === false) continue;

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

        if (!existing && result.isSustainedViolation) {
          // New sustained episode — open it and notify.
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
          // 23505 = another concurrent sweep already inserted this — the
          // partial unique index already prevents a real duplicate, so
          // just skip sending in that race rather than treating it as fatal.
          if (insertError && insertError.code !== '23505') throw insertError;

          if (inserted) {
            const body = emailBodyForOpen(
              device.name, deviceId, metric.label, result.latestValue!, metric.unit,
              range.low, range.high, result.violatingSinceMs!, appBaseUrl,
            );
            let sentOk = true;
            for (const to of recipients) {
              try {
                await sendEmail(to, `${device.name}: ${metric.label} out of range`, body);
              } catch (sendError) {
                sentOk = false;
                console.error(`failed to send open-alert email to ${to} for ${deviceId}/${metric.key}:`, sendError);
              }
            }
            if (sentOk) {
              await supabase.from('climate_alerts').update({ opened_email_sent_at: new Date().toISOString() }).eq('id', inserted.id);
            }
          }
          continue;
        }

        if (existing && !existing.opened_email_sent_at) {
          // Insert succeeded on a prior sweep but the send failed — retry
          // the send without inserting a new row.
          const body = emailBodyForOpen(
            device.name, deviceId, metric.label, Number(existing.observed_value), metric.unit,
            Number(existing.low_threshold), Number(existing.high_threshold),
            new Date(existing.out_of_range_since).getTime(), appBaseUrl,
          );
          let sentOk = true;
          for (const to of recipients) {
            try {
              await sendEmail(to, `${device.name}: ${metric.label} out of range`, body);
            } catch (sendError) {
              sentOk = false;
              console.error(`retry: failed to send open-alert email to ${to} for ${deviceId}/${metric.key}:`, sendError);
            }
          }
          if (sentOk) {
            await supabase.from('climate_alerts').update({ opened_email_sent_at: new Date().toISOString() }).eq('id', existing.id);
          }
          continue;
        }

        if (existing && !result.isViolatingNow) {
          // Back in range — resolve and notify.
          const body = emailBodyForResolved(
            device.name, deviceId, metric.label, result.latestValue!, metric.unit,
            Number(existing.low_threshold), Number(existing.high_threshold), appBaseUrl,
          );
          let sentOk = true;
          for (const to of recipients) {
            try {
              await sendEmail(to, `${device.name}: ${metric.label} back in range`, body);
            } catch (sendError) {
              sentOk = false;
              console.error(`failed to send resolved-alert email to ${to} for ${deviceId}/${metric.key}:`, sendError);
            }
          }
          await supabase
            .from('climate_alerts')
            .update({
              status: 'resolved',
              resolved_at: new Date().toISOString(),
              ...(sentOk ? { resolved_email_sent_at: new Date().toISOString() } : {}),
            })
            .eq('id', existing.id);
          continue;
        }

        // Otherwise: no open alert and not sustained yet, or an open alert
        // still ongoing (already notified) — nothing to do this sweep.
      }
    }

  return new Response('ok', { status: 200 });
});
