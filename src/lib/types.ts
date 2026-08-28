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

// Firmware 0.5.0 switched the wire format from Fahrenheit to Celsius
// (temp_low_f/temp_high_f -> temp_low_c/temp_high_c — see
// docs/known-issues.md). profile_config is a JSONB blob that only gets
// rewritten when a device resaves its settings, so a snapshot saved before
// that firmware update keeps the old _f keys forever, even though the
// underlying logs/telemetry table columns have all been renamed+converted.
// Both shapes are optional here on purpose — read via src/lib/units.ts's
// tempRangeC(), never these fields directly.
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
  opened_email_sent_at: string | null;
  resolved_email_sent_at: string | null;
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
    };
    Views: { [_ in never]: never };
    Functions: { [_ in never]: never };
    Enums: { [_ in never]: never };
    CompositeTypes: { [_ in never]: never };
  };
};
