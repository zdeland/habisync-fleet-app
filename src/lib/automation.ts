// Mirrors ClimateController::evaluate() (firmware src/Reptile.cpp) exactly —
// see docs/automation-rules.md §1-5. This is the validator's reimplementation
// of the real automation decision logic, kept correct by testing it against
// the same fixture the firmware repo tests its own C++ against
// (test/fixtures/climate_vectors.json — see test/automation.test.ts).
//
// The scheduled lights — Day Light/UVB/Basking Spot (automation-rules.md
// §6-8) — are NOT implemented here yet: they need the device's resolved
// local time, which depends on the NAMED_TIMEZONES label list
// (src/main.cpp:154-163 in the firmware repo, not available here) and
// climate_vectors.json covers Heater/Mister/Fan only, so there'd be no
// fixture pinning them. Don't guess at the timezone resolution; get that
// list before implementing §6-8. When they do land, read the windows via
// src/lib/schedule.ts's lightWindows() and OR in_window across all of
// them — testing only the first window is the §6 trap that produces
// confident-looking false anomalies.
//
// That same missing clock is why two of the rules below are incomplete:
// the Fan has gained two clock-driven terms — fan assist (§5a) in 0.27.0
// and a fan schedule (§5b) in 0.33.0 — and the Mister one, scheduled mist
// windows (§4a) in 0.28.0. All are long since released; the fleet is on
// 0.30.0-0.33.0. So `decision.fan` and `decision.mist` are each the climate
// half alone. See their comments.
//
// The mister's clock requirement is strictly harder than the lights': a
// 0.29.0+ spike is a start plus a duration in seconds, as short as 5, so
// its term needs SECONDS-resolution local time where every other rule here
// compares at the minute (§4a). Whatever resolves the timezone must not
// round to the minute on the way.

export const TEMP_HYSTERESIS_C = 1.0;
export const HUMIDITY_HYSTERESIS_PCT = 3.0;

export type ClimateProfile = {
  tempLow: number;
  tempHigh: number;
  humidityLow: number;
  humidityHigh: number;
};

// Carried forward between evaluations — the ON->OFF and OFF->ON thresholds
// differ (hysteresis), so a single reading can't be judged in isolation.
export type ClimateState = {
  heat: boolean;
  mist: boolean;
  tempTrigger: boolean; // Fan's temperature-driven half (independent of humTrigger)
  humTrigger: boolean; // Fan's humidity-driven half
};

export const INITIAL_CLIMATE_STATE: ClimateState = {
  heat: false,
  mist: false,
  tempTrigger: false,
  humTrigger: false,
};

export type ClimateDecision = {
  heat: boolean;
  // The HUMIDISTAT half of the Mister rule only (automation-rules.md §4).
  // Firmware 0.28.0 added a second term, a scheduled mist window (§4a): a
  // window in `mister_ranges` spikes the Mister at a fixed time of day
  // regardless of humidity, on top of the reactive humidistat —
  // `humidistat OR (mist_window AND NOT hum_trigger)`. Computing it needs
  // the device's local time, the same thing blocking §6-8, so this field is
  // a LOWER BOUND on the mister's real state.
  //
  // It's exact wherever the snapshot's `mister_ranges` is absent or empty
  // (misterWindows() reads both as []) — `mist_window` is false at every
  // instant then, and it needs no clock to check. That, not a version
  // comparison, is the gate for the §11 mister anomaly check, and it holds
  // identically across both of §4a's window shapes — an empty array has no
  // windows of either kind, so the gate never has to know which shape a
  // device writes. Unlike fan assist's gate it still covers most of the
  // fleet, because mister windows ship unused. Against a snapshot that does
  // carry one, though, this field reports a stuck relay on a
  // correctly-behaving device.
  //
  // Note the suppression term is `hum_trigger` — the §5 latch computed
  // below, with its 3.0 %RH release band — not a fresh `hum >= hum_high`
  // comparison. The latch's band is wider, so re-deriving the ceiling
  // instantaneously would re-open a scheduled spike partway down the fan's
  // dead band while the real device keeps it shut.
  mist: boolean;
  // The CLIMATE half of the Fan rule only — `temp_trigger OR hum_trigger`.
  // The real fan is a four-term OR, and the other two terms are both clock
  // windows this module cannot yet evaluate (automation-rules.md §5):
  //
  //   - fan assist (§5a, firmware 0.27.0) — a lighting window with `fan`
  //     ticked runs the Fan for that window's duration, and basking windows
  //     are ticked by default.
  //   - a scheduled fan window (§5b, firmware 0.33.0) — a window in
  //     `fan_ranges`, airflow on a clock rather than on a bulb or a ceiling.
  //
  // Computing either needs the device's local time, the same thing blocking
  // §6-8 below, so this field is a LOWER BOUND on the fan's real state.
  // Both missing terms are purely additive and nothing suppresses either,
  // so the bound only ever errs one way: the real fan may be on when this
  // says off, never the reverse.
  //
  // The §11 fan anomaly check gates on the SNAPSHOT, not on a version, and
  // it now has to clear both terms — this field is exact only where the
  // snapshot has no `fan`-ticked lighting window AND no `fan_ranges`
  // window, because that is when both missing terms are false at every
  // instant. Neither half needs a clock to determine: read the lighting
  // windows through lightWindows() and the fan schedule through
  // fanWindows() (src/lib/schedule.ts), and skip the check where either is
  // non-empty rather than reporting a mismatch you know to be spurious.
  //
  // In practice the two halves of that gate have opposite reach. The
  // fan-assist half excludes most of the current fleet, since basking
  // windows ship ticked; the `fan_ranges` half excludes almost none, since
  // 0.33.0 ships the array empty until a keeper fills it. Checking only the
  // half that usually bites is how the §5b term gets forgotten.
  //
  // It stays named `fan` because climate_vectors.json's own vectors use that
  // key and test/automation.test.ts deep-equals the whole decision against
  // them; the fixture has no lighting scenarios, so it can't pin the term.
  fan: boolean;
  tooHot: boolean; // = tempTrigger, exposed under climate_vectors.json's naming
  tooHumid: boolean; // = humTrigger
};

// automation-rules.md §9: when disabled, evaluate() doesn't run at all —
// outlets are whatever a human last set, and the previous computed state
// isn't advanced. Call this every step regardless of `enabled`; it handles
// the gate itself so callers don't have to remember to skip disabled ones.
export function evaluateClimateStep(
  state: ClimateState,
  profile: ClimateProfile,
  enabled: boolean,
  tempC: number,
  hum: number,
): { state: ClimateState; decision: ClimateDecision } {
  if (!enabled) {
    return {
      state,
      decision: {
        heat: state.heat,
        mist: state.mist,
        fan: state.tempTrigger || state.humTrigger,
        tooHot: state.tempTrigger,
        tooHumid: state.humTrigger,
      },
    };
  }

  // Heater (§3): ceiling has no hysteresis; the OFF->ON and ON->OFF
  // thresholds differ (temp_low_c vs temp_low_c + hysteresis).
  let heat = state.heat;
  if (tempC >= profile.tempHigh) {
    heat = false;
  } else if (!heat && tempC < profile.tempLow) {
    heat = true;
  } else if (heat && tempC >= profile.tempLow + TEMP_HYSTERESIS_C) {
    heat = false;
  }

  // Mister (§4): same shape, humidity-flavored. This is §4a's `humidistat`
  // boolean — the whole rule through 0.27.0, and one of two terms since
  // 0.28.0 (see `mist` on ClimateDecision). Its ceiling here is
  // instantaneous; the schedule term's is the `humTrigger` latch computed
  // further down.
  let mist = state.mist;
  if (hum >= profile.humidityHigh) {
    mist = false;
  } else if (!mist && hum < profile.humidityLow) {
    mist = true;
  } else if (mist && hum >= profile.humidityLow + HUMIDITY_HYSTERESIS_PCT) {
    mist = false;
  }

  // Fan (§5): two independent ceiling-only triggers, OR'd — two of the
  // three terms the rule has as of 0.27.0, the missing one being fan
  // assist (§5a).
  // The hysteresis band sits BELOW the ceiling here (tempHigh -
  // hysteresis), a different location than the Heater's own band (tempLow
  // + hysteresis) — don't reuse one dead-band calculation for both.
  let tempTrigger = state.tempTrigger;
  if (tempC >= profile.tempHigh) {
    tempTrigger = true;
  } else if (tempTrigger && tempC < profile.tempHigh - TEMP_HYSTERESIS_C) {
    tempTrigger = false;
  }

  let humTrigger = state.humTrigger;
  if (hum >= profile.humidityHigh) {
    humTrigger = true;
  } else if (humTrigger && hum < profile.humidityHigh - HUMIDITY_HYSTERESIS_PCT) {
    humTrigger = false;
  }

  return {
    state: { heat, mist, tempTrigger, humTrigger },
    decision: { heat, mist, fan: tempTrigger || humTrigger, tooHot: tempTrigger, tooHumid: humTrigger },
  };
}
