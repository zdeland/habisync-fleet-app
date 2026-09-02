// Shapes mirror docs/cloudlog-dataflow.md and docs/monitoring-webapp-plan.md
// (the firmware repo's scripts/supabase_schema.sql is the ground truth —
// keep these in sync if that schema changes).
//
// These are `type` aliases rather than `interface`s on purpose: postgrest-js
// requires each table's `Row` to structurally satisfy `Record<string,
// unknown>`, and an `interface` (unlike an object-literal `type`) is never
// assignable to an index-signature type in TypeScript, even with identical
// properties — using `interface` here makes every query resolve to `never`.

export type LogLevel = 0 | 1 | 2 | 3; // 0 ERR · 1 WARN · 2 INFO · 3 DBG

export type LogTag =
  | 'boot'
  | 'wifi'
  | 'kasa'
  | 'ota'
  | 'sensor'
  | 'event'
  | 'cloudlog'
  | 'config';

// One scheduled on/off window for a light, as it appears inside
// profile_config's `*_ranges` arrays (firmware 0.26.0+). Times are "HH:MM"
// in the device's local timezone; on == off means "never on", and a window
// may wrap past midnight (docs/automation-rules.md §6).
//
// `fan` is fan assist, added in 0.27.0 (§5a): a ticked window runs the Fan
// outlet for its duration, venting a bulb's heat while it's lit instead of
// waiting for the temperature ceiling. Optional because 0.26.0 — a
// published, deployed release — writes the arrays with no `fan` key on any
// window at all, so absent-means-false is load-bearing for a real firmware
// generation, not just defensive. That shape outlives the version: every
// historized tag='config' row a 0.26.0 device wrote keeps it, including on
// devices that have since upgraded to 0.27.0.
//
// Firmware defaults it true on basking windows and false elsewhere, but
// that default is applied at write time and is not a rule to re-apply when
// reading: inferring true from the role would override a window a keeper
// deliberately unticked.
export type LightWindow = {
  on: string;
  off: string;
  fan?: boolean;
};

// One scheduled mist window from `mister_ranges` (firmware 0.28.0+,
// docs/automation-rules.md §4a): a fixed-time-of-day spike of the Mister
// outlet on top of the reactive humidistat.
//
// TWO wire shapes, and this is permanent rather than transitional — see
// §4a. Discriminate on key presence (`'duration_s' in w`), never on
// `fw_version`; src/lib/schedule.ts's isMisterDurationWindow() is the one
// place that decides.
//
// 0.28.0 reused the lighting windows' writer verbatim, which was the wrong
// shape for a mister: a pair of minute-resolution clock times cannot
// express anything shorter than 60 seconds of water, far more than a
// humidity spike wants. 0.29.0 — published the very next day — replaced it
// with a start plus an explicit duration.
export type MisterSpanWindow = {
  on: string;
  // 0.28.0 ONLY. That release lived one day, and its windows ship unused by
  // default, so the population emitting this is small — but historized
  // tag='config' rows keep whatever shape they were written under, so it
  // never ages out of the history.
  off: string;
};

export type MisterDurationWindow = {
  on: string;
  // 0.29.0+. SECONDS — always a multiple of 5, between 5 and 300. Reading
  // it as minutes turns a 15-second spike into a 15-minute one.
  //
  // Because the shortest legal value is 5s and the resolution is 1s, a
  // duration window's span can only be evaluated against a
  // SECONDS-resolution local clock. Every other rule in automation-rules.md
  // compares at minute resolution; do that here and a 5s spike computes as
  // either never on or a full minute on.
  duration_s: number;
};

// The `fan` key is deliberately unrepresentable on either shape. On 0.28.0
// windows it IS on the wire and always false (the device never offers that
// checkbox for the mister, and venting mid-spike would fight the thing the
// window exists to do); 0.29.0 dropped it from the array entirely. Either
// way it must never reach fan assist, which folds over the three lighting
// arrays only (§5a) — leaving the field out means `w.fan` fails to compile
// rather than silently contributing a term that is only false for as long
// as firmware keeps writing it that way.
export type MisterWindow = MisterSpanWindow | MisterDurationWindow;

// Firmware 0.5.0 switched the wire format from Fahrenheit to Celsius
// (temp_low_f/temp_high_f -> temp_low_c/temp_high_c — see
// docs/known-issues.md). profile_config is a JSONB blob that only gets
// rewritten when a device resaves its settings, so a snapshot saved before
// that firmware update keeps the old _f keys forever, even though the
// underlying logs/telemetry table columns have all been renamed+converted.
// Both shapes are optional here on purpose — read via src/lib/units.ts's
// tempRangeC(), never these fields directly.
//
// Firmware 0.26.0 did the same thing to the lighting schedule: each light
// went from one on/off pair to several independent windows, and a sixth
// role (Basking Spot) joined. (How many per light is not uniform and moves
// between releases — see src/lib/schedule.ts; nothing should encode a
// count.) The scalar pairs still ship, but they now
// carry *only the first window* — reading them alone silently loses every
// later window, so read via src/lib/schedule.ts's lightWindows(), never
// these fields directly. Both the arrays and basking_on/basking_off are
// optional because pre-0.26.0 devices (and every historized tag='config'
// row written before their upgrade) don't have them at all.
export type ProfileConfig = {
  profile: string;
  enabled: boolean;
  temp_low_c?: number;
  temp_high_c?: number;
  temp_low_f?: number;
  temp_high_f?: number;
  hum_low: number;
  hum_high: number;
  day_light_on: string;
  day_light_off: string;
  uvb_on: string;
  uvb_off: string;
  basking_on?: string;
  basking_off?: string;
  day_light_ranges?: LightWindow[];
  uvb_ranges?: LightWindow[];
  basking_ranges?: LightWindow[];
  // Firmware 0.28.0+ (§4a). No scalar first-window companion exists — and
  // shouldn't be invented: the other three arrays' scalars are back-compat
  // for pre-multi-window validators, and nothing ever read a mister
  // schedule. Absent (every pre-0.28.0 device, and every historized
  // tag='config' row written before its upgrade) means the same thing as
  // `[]` in the formula: humidistat only. Read via
  // src/lib/schedule.ts's misterWindows().
  mister_ranges?: MisterWindow[];
  timezone: string;
  ota_url: string;
  kasa_ip?: string;
};

export type Device = {
  device_id: string;
  name: string;
  fw_version: string;
  ip: string;
  rssi: number;
  free_heap: number;
  uptime_ms: number;
  active_backend: string;
  reset_reason: string;
  outlet_roles: string[];
  profile_config: ProfileConfig;
  first_seen: string;
  last_seen: string;
};

export type LogRow = {
  id: number;
  device_id: string;
  level: LogLevel;
  tag: LogTag;
  message: string;
  uptime_ms: number;
  device_time: string | null;
  created_at: string;
  temp_c: number | null; // renamed from temp_f in firmware 0.5.0 — native Celsius
  hum: number | null;
  outlet_index: number | null;
  outlet_state: boolean | null;
  outlet_roles: string[] | null;
  profile_config: ProfileConfig | null;
};

export type TelemetryRow = {
  id: number;
  device_id: string;
  created_at: string;
  temp_c: number; // renamed from temp_f in firmware 0.5.0 — native Celsius
  hum: number;
  outlet_mask: number;
  free_heap: number;
  rssi: number;
};

export type OutletAlertStatus = 'open' | 'escalated' | 'auto_resolved' | 'closed';

// Webapp-owned workflow table — NOT part of the device-reported schema above
// (devices/logs/telemetry are firmware ground truth; this app never writes
// to those). See supabase/outlet_alerts.sql for the migration and
// docs/outlet-alerts.md for the feature this backs, per
// docs/monitoring-webapp-plan.md §6's allowance for "authenticated writes
// for notes and remediation actions in its own workflow tables."
export type OutletAlertRow = {
  id: number;
  device_id: string;
  outlet_index: number;
  status: OutletAlertStatus;
  // Snapshot of the detected mismatch as of this alert's creation/last
  // re-open — kept even if the logs/telemetry it was computed from later
  // age out of retention.
  role: string;
  logged_state: boolean;
  actual_state: boolean;
  last_logged_message: string;
  last_logged_at: string;
  mismatch_since: string;
  detected_at: string;
  updated_at: string;
  closed_at: string | null;
  closed_by: string | null;
  escalated_at: string | null;
  escalated_by: string | null;
  // Set when syncOutletAlerts, not a human, transitions this alert out of
  // open/escalated because the live mismatch it was tracking stopped
  // reproducing — see src/lib/alerts.ts. Distinct from closed_by (always
  // null here): no auth.users id to attribute this to.
  auto_resolved_at: string | null;
  note: string | null;
};

// Minimal projection of auth.users (id, email), synced via trigger — see
// supabase/profiles.sql — so the alert history can show who
// closed/escalated an alert. Never anything beyond these two columns.
export type ProfileRow = {
  id: string;
  email: string | null;
};

// Webapp-owned per-user preference table — see supabase/favorite_devices.sql
// and docs/climate-alerts.md. The first genuinely per-user-scoped table in
// this app (RLS restricts rows to auth.uid() = user_id, unlike every other
// table's shared-team `using (true)` policy).
export type FavoriteDeviceRow = {
  user_id: string;
  device_id: string;
  created_at: string;
};

export type ClimateAlertMetric = 'temp' | 'humidity';
export type ClimateAlertStatus = 'open' | 'resolved';

// Webapp-owned workflow table backing the favorite-device climate-alert
// emails — see supabase/climate_alerts.sql and docs/climate-alerts.md.
// Written only by the supabase/functions/climate-alerts Edge Function
// (service-role); this app never writes it directly.
export type ClimateAlertRow = {
  id: number;
  device_id: string;
  metric: ClimateAlertMetric;
  status: ClimateAlertStatus;
  out_of_range_since: string;
  observed_value: number;
  low_threshold: number;
  high_threshold: number;
  detected_at: string;
  updated_at: string;
  resolved_at: string | null;
};

// Per-recipient notification ledger for climate_alerts — see
// supabase/climate_alert_notifications.sql and docs/climate-alerts.md.
// Written only by the climate-alerts Edge Function (service-role).
export type ClimateAlertNotificationKind = 'opened' | 'resolved';
export type ClimateAlertNotificationRow = {
  alert_id: number;
  user_id: string;
  kind: ClimateAlertNotificationKind;
  sent_at: string;
};

// devices/logs/telemetry: this app only ever reads these tables (writes come
// from the on-device anon key, never the browser — see
// docs/monitoring-webapp-plan.md §2), so Insert/Update are placeholders to
// satisfy postgrest-js's generic shape rather than types this app actually
// uses. outlet_alerts is the one exception — a table this webapp owns
// end-to-end, including writes (see src/lib/alerts.ts).
export type Database = {
  public: {
    Tables: {
      devices: { Row: Device; Insert: Partial<Device>; Update: Partial<Device>; Relationships: [] };
      logs: { Row: LogRow; Insert: Partial<LogRow>; Update: Partial<LogRow>; Relationships: [] };
      telemetry: {
        Row: TelemetryRow;
        Insert: Partial<TelemetryRow>;
        Update: Partial<TelemetryRow>;
        Relationships: [];
      };
      outlet_alerts: {
        Row: OutletAlertRow;
        Insert: Partial<OutletAlertRow>;
        Update: Partial<OutletAlertRow>;
        Relationships: [];
      };
      profiles: { Row: ProfileRow; Insert: Partial<ProfileRow>; Update: Partial<ProfileRow>; Relationships: [] };
      favorite_devices: {
        Row: FavoriteDeviceRow;
        Insert: Partial<FavoriteDeviceRow>;
        Update: Partial<FavoriteDeviceRow>;
        Relationships: [];
      };
      // Read-only from this app's perspective (see comment on ClimateAlertRow
      // above) — Insert/Update are still declared as placeholders to satisfy
      // postgrest-js's generic shape, same convention as devices/logs/telemetry.
      climate_alerts: {
        Row: ClimateAlertRow;
        Insert: Partial<ClimateAlertRow>;
        Update: Partial<ClimateAlertRow>;
        Relationships: [];
      };
      climate_alert_notifications: {
        Row: ClimateAlertNotificationRow;
        Insert: Partial<ClimateAlertNotificationRow>;
        Update: Partial<ClimateAlertNotificationRow>;
        Relationships: [];
      };
    };
    Views: { [_ in never]: never };
    Functions: { [_ in never]: never };
    Enums: { [_ in never]: never };
    CompositeTypes: { [_ in never]: never };
  };
};
