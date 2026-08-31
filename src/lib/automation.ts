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
// That same missing clock is why the Fan rule below is incomplete as of
// firmware 0.26.0: fan assist (§5a) adds a third term driven by those same
// windows, so `decision.fan` is the climate half alone. See its comment.

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
  mist: boolean;
  // The CLIMATE half of the Fan rule only — `temp_trigger OR hum_trigger`.
  // Firmware 0.26.0 added a third term, fan assist (automation-rules.md
  // §5a): a lighting window with `fan` ticked runs the Fan for its
  // duration, and basking windows are ticked by default. Computing it needs
  // the device's local time, the same thing blocking §6-8 below, so this
  // field is a LOWER BOUND on the fan's real state.
  //
  // It's still exact wherever no window in the snapshot has `fan` ticked —
  // fan_assist is false at every instant then — which covers the whole
  // un-upgraded fleet, since no *_ranges at all means no ticked window, and
  // needs no clock to check. That, not a version comparison, is the gate
  // for the §11 fan anomaly check; against a snapshot that does have a
  // ticked window, this field will report a stuck relay on an ordinary,
  // correctly-behaving device.
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

  // Mister (§4): same shape, humidity-flavored.
  let mist = state.mist;
  if (hum >= profile.humidityHigh) {
    mist = false;
  } else if (!mist && hum < profile.humidityLow) {
    mist = true;
  } else if (mist && hum >= profile.humidityLow + HUMIDITY_HYSTERESIS_PCT) {
    mist = false;
  }

  // Fan (§5): two independent ceiling-only triggers, OR'd — two of the
  // three terms the rule has as of 0.26.0, the missing one being fan
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
