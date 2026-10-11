# HabiSync Fleet Monitor

A read-only fleet monitoring/debugging tool for a fleet of HabiSync ESP32
reptile-enclosure controllers. It reads from the same Supabase project the
firmware (a separate repo) already writes to (`devices`, `logs`,
`telemetry`) and layers its own workflow tables on top (outlet-mismatch
alerts, climate alerts, user favorites) — see `docs/monitoring-webapp-plan.md`
for the full requirements brief.

## Setup

```bash
cp .env.example .env.local   # fill in your Supabase project's values
npm install
npm run dev
```

Required env vars (`.env.local`, see `.env.example` for where to find each
in your Supabase project):
- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`
- `SUPABASE_SERVICE_ROLE_KEY` (server-only — used by the `/invite` Server
  Action, never sent to the browser)

## Scripts

- `npm run dev` — dev server
- `npm run build` / `npm run start` — production build/serve
- `npm run lint` — ESLint
- `npm test` — runs `test/*.test.ts` via `tsx --test` (no Jest/Vitest)

## Database

This repo has no migration runner — the `.sql` files under `supabase/` are
hand-run, once each, against the project's SQL editor, in roughly the order
they were added (each file's header comment says what it does and what it
depends on).

## Climate alerts — deploy/operate checklist

Emails favoriting users when a device's temp/humidity has been out of
range for 3+ minutes, or when a device on firmware 0.35.0+ stops trusting a
sensor and switches that half of its automation off. See [`docs/climate-alerts.md`](docs/climate-alerts.md)
for the full design (why this needs a Deno Edge Function + `pg_cron`, the
detection algorithm, the reconciliation model). This section is just the
runbook.

**One-time setup:**

1. Run `supabase/favorite_devices.sql`, `supabase/climate_alerts.sql`,
   `supabase/climate_alert_notifications.sql`,
   `supabase/grant_service_role_climate_alerts.sql`, and
   `supabase/grant_service_role_logs.sql` in the Supabase SQL editor.
   (An existing install that predates sensor-fault alerts also needs
   `supabase/add_sensor_fault_alert_metrics_2026-10-11.sql` — run it, and
   the logs grant, before redeploying the function.)
2. `supabase login`, then `supabase link --project-ref <ref>`.
3. `supabase functions deploy climate-alerts`.
4. Set secrets (values below) with `supabase secrets set KEY=value ...`.
5. Run `supabase/climate_alerts_cron.sql` in the SQL editor — but first
   replace its two placeholders (`<project-ref>`, the real
   `CRON_SHARED_SECRET` value) by hand; never commit the real values back
   into that file.

**Secrets** (`supabase secrets set`, separate from this app's own
`.env.local` — Edge Function secrets are a different store):

| Name | Value |
|---|---|
| `POSTMARK_SERVER_TOKEN` | Your Postmark Server API Token (the same value Postmark uses as the SMTP username/password). Email is sent via Postmark's HTTP API, not SMTP — see `docs/climate-alerts.md` for why. |
| `SMTP_FROM` | The verified Postmark sender address (e.g. `noreply@yourdomain.com`) — used as the email's `From`. |
| `CRON_SHARED_SECRET` | A new random value — also pasted into `climate_alerts_cron.sql`'s `X-Cron-Secret` header when you run it |
| `APP_BASE_URL` | e.g. `https://fleet.yourdomain.com` (used for the link in alert emails) |

`SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` are auto-injected into every
Edge Function by Supabase — nothing to set for those.

**Testing a deploy without waiting on real telemetry**: favorite a device
in the app, insert a few synthetic `telemetry` rows outside its
`profile_config` range (timestamped ≥3 min apart), then:

```bash
curl -X POST https://<ref>.supabase.co/functions/v1/climate-alerts \
  -H "X-Cron-Secret: <value>" -H "Content-Type: application/json" -d '{}'
```

Check `supabase functions logs climate-alerts` if no email arrives.

For a sensor-fault alert, insert a `logs` row instead — `tag='sensor'`,
`level=0`, `message` = `Humidity sensor not trusted (no rise while misting)
at 28.4 %RH — mister held off until the reading recovers` — timestamped
after the device's current boot (`last_seen - uptime_ms`), then curl as
above. Insert a matching `Humidity sensor trusted again at 29.5 %RH — ...`
row to see the resolve email. A device with automation off never alerts.
