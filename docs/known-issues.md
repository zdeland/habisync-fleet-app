# Known issues / accepted trade-offs

## `devices` table is readable by the unauthenticated anon/publishable key

**Status as of 2026-07-18: accepted trade-off, fix planned but not yet built.**

### What

Anyone holding the Supabase publishable key (`NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`
— safe-to-ship-to-clients by design, and effectively public since it's bundled
into this webapp's browser JS) can currently read the full `devices` row for
every device: `name`, `ip`, `rssi`, `free_heap`, `reset_reason`, `outlet_roles`,
and the full `profile_config` (climate targets, day/night schedule, `kasa_ip`,
`ota_url`) — without signing in.

`logs` and `telemetry` correctly reject anon reads (`42501 permission denied`).
Only `devices` has this gap.

### Why it's like this (read before trying to "just fix" it)

The firmware's heartbeat does `POST /rest/v1/devices?on_conflict=device_id`
(an upsert) using the anon/publishable key — see
[`cloudlog-dataflow.md`](cloudlog-dataflow.md). Postgres requires the role
performing an `INSERT ... ON CONFLICT DO UPDATE` to satisfy the target
table's SELECT check on the proposed row, even though the client never reads
the response. This is documented Postgres behavior, not a Supabase quirk:
> "SELECT permissions are required on the relation, and the rows proposed
> for insertion are checked using the relation's SELECT policies. If a row
> proposed for insertion does not satisfy the relation's SELECT policies,
> an error is thrown."

This was tried and confirmed **not to work**, in order, against the live
prototype device — don't repeat these:

1. `revoke select on public.devices from anon` — closes the read, but the
   next heartbeat immediately fails with
   `42501: permission denied for table devices`. The device stops reporting
   entirely until reverted.
2. `grant select (device_id) on public.devices to anon` (column-scoped, keeping
   only the `on_conflict` target column readable) — still fails the same way.
   Postgres's internal check needs table-level SELECT, not just the
   conflict-target column.

There is no GRANT/RLS-only configuration that lets the same `anon` role both
upsert into `devices` and be blocked from reading it — the capability that
satisfies the upsert's internal check is the same capability that serves a
plain `GET`.

### Current state (deliberate, temporary)

`grant select on public.devices to anon;` — full table readable by anon, so
the device keeps reporting. Re-verify with:

```bash
curl "$SUPABASE_URL/rest/v1/devices?select=*&limit=1" \
  -H "apikey: $PUBLISHABLE_KEY" -H "Authorization: Bearer $PUBLISHABLE_KEY"
# expect 200 with a full row
```

### Risk assessment (why this was accepted rather than rushed)

- `profile_config.ota_url` is already a public GitHub releases URL — not a
  secret.
- The genuinely sensitive fields are LAN IPs (`ip`, `profile_config.kasa_ip`)
  and the climate schedule — useful to someone already on the local network,
  not remotely exploitable just from holding this key over the internet.
- Real risk, but narrower than "full device compromise" — worth fixing
  properly rather than rushing another SQL-only patch that's already failed
  twice live.

### Planned real fix: `SECURITY DEFINER` RPC function

Replace the direct table upsert with a Postgres function the device calls
instead:

- `POST /rest/v1/rpc/upsert_device_heartbeat` (or similar name), with a
  narrowly-typed, parameterized function body — no dynamic SQL, explicit
  `search_path` pinned inside the function (classic `SECURITY DEFINER`
  injection footgun otherwise).
- `anon` gets `EXECUTE` on the function only — no `SELECT`/`INSERT` grant on
  `devices` directly. The function itself runs with elevated privileges to
  perform the upsert.
- Then `revoke select on public.devices from anon` becomes safe, since anon
  no longer touches the table directly at all.

**This requires a firmware change** — the heartbeat call becomes an RPC call
with an args-shaped JSON body instead of a flat row POST — plus:
- `NOTIFY pgrst, 'reload schema';` after creating the function (PostgREST
  won't see it otherwise).
- Confirming the function isn't executable by `PUBLIC` by default before
  granting it to `anon` specifically.

There's one prototype device available to validate the new firmware against
before any customer-facing rollout, so this should be tested there first —
this is a real, multi-step piece of work, not a quick SQL follow-up, and
shouldn't be improvised live against a customer-facing device the way the
two failed attempts above were tried against the prototype.

**Explicitly ruled out**: giving the device a `service_role`/secret key
instead of the publishable key. That would fix this specific read gap but
creates a much worse one — a secret key has full, RLS-bypassing database
access, and firmware is far easier to physically extract from a device than
a Supabase project URL is to find. Never ship a secret key to a device.

**Update, same day**: this grant regressed a second time when the firmware
repo's Celsius migration SQL was run against the live project — that
migration script re-applies `scripts/supabase_schema.sql`'s baseline
grants, which don't yet include this fix (it was only ever applied ad hoc
via the SQL editor, never captured back into the tracked schema file).
Re-ran `grant select on public.devices to anon;` to unblock the device
again. **Whoever owns `scripts/supabase_schema.sql` should add this grant
into that file directly** so the next unrelated schema change doesn't
silently revert it a third time.

## The `/climate-test` page ships real automation data, not sandboxed test data

**Status as of 2026-07-18: known, handled in the UI, no further action planned.**

### What

The on-device dashboard's `/climate-test` page (gauge-drag UI) isn't a
simulation — `handleClimateTestRun()` in the firmware's `src/main.cpp`
feeds a fake temp/humidity reading straight into the live
`ClimateController` and the real `applyOutletState()`, the same code path
a real sensor reading takes. Using it on a device actually flips that
device's real Heat/Mister/Fan outlets, and logs a normal `tag='event'` row
through the same path any real automation decision would use.

The only distinguishing signal is the logged `message` being prefixed
`"test: "` (e.g. `"Heater [1] turned ON — test: temperature below target
range"`). The row's `temp_c`/`hum` columns are the device's **real**
sensor reading at that instant — `logEvent()` always logs live globals,
not the fake value that actually drove the decision — so recomputing
"should heat be on" from `temp_c` for one of these rows can legitimately
disagree with what `outlet_index`/`outlet_state` shows. That's expected
for a test-driven row, not a bug or a webapp/firmware drift.

**Telemetry has no marker at all.** A `telemetry.outlet_mask` sample taken
within ~60s after a `"test: "`-tagged `logs` row may reflect the
test-driven outlet state with no way to distinguish it from a real one.

### What the webapp does about it

- `DeviceTimeline.tsx`'s outlet-reason badge and the event log both check
  for the `"test: "` prefix (`isTestReason()`) and render a distinct
  neutral "TEST" tag instead of the normal color-coded reason, so a
  test-triggered transition is never mistaken for a real climate decision
  while debugging.
- **Not yet needed, but will matter once built**: any future
  hysteresis/anomaly-detection feature (plan doc item 8) must exclude
  `"test: "`-prefixed `logs` rows before comparing actual vs. expected
  outlet state, and should treat `telemetry` samples in the ~60s window
  after one as suspect rather than trying to filter them precisely, since
  there's no marker on the telemetry row itself.
