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

// This app only ever reads these tables (writes come from the on-device anon
// key, never the browser — see docs/monitoring-webapp-plan.md §2), so
// Insert/Update are placeholders to satisfy postgrest-js's generic shape
// rather than types this app actually uses.
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
    };
    Views: { [_ in never]: never };
    Functions: { [_ in never]: never };
    Enums: { [_ in never]: never };
    CompositeTypes: { [_ in never]: never };
  };
};
