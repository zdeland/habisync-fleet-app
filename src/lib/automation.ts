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
// Firmware 0.35.0 added a sensor trust gate per channel (§3a, §4b), which
// IS implemented below and pinned by the fixture's fault scenarios — with
// one caveat for anything replaying real telemetry, explained above
// temperaturePlausible().
//
// The mister's clock requirement is strictly harder than the lights': a
// 0.29.0+ spike is a start plus a duration in seconds, as short as 5, so
// its term needs SECONDS-resolution local time where every other rule here
// compares at the minute (§4a). Whatever resolves the timezone must not
// round to the minute on the way.

export const TEMP_HYSTERESIS_C = 1.0;
export const HUMIDITY_HYSTERESIS_PCT = 3.0;

// Sensor trust gates, firmware 0.35.0+ (automation-rules.md §3a, §4b) —
// mirrors ClimateController::updateTemperatureTrust()/updateHumidityTrust()
// and the constants in the firmware's src/Reptile.h. The two channels'
// constants deliberately differ; don't copy one set across to the other:
// 0.0 °C is a real reading where 0.0 %RH is a dead channel, and air
// temperature answers a heater over minutes where %RH answers a mister in
// seconds.
export const TEMP_PLAUSIBLE_MIN_C = -40.0;
export const TEMP_PLAUSIBLE_MAX_C = 125.0;
export const HEAT_NO_RISE_EVAL_LIMIT = 20;
export const TEMP_RISE_EPSILON_C = 0.3;
export const HUMIDITY_PLAUSIBLE_MIN_PCT = 1.0;
export const HUMIDITY_PLAUSIBLE_MAX_PCT = 100.0;
export const MIST_NO_RISE_EVAL_LIMIT = 2;
export const HUMIDITY_RISE_EPSILON_PCT = 1.0;

// The watchdog limits above count the device's evaluations, which run every
// 30s — not telemetry rows, which arrive every 60s. Fed telemetry, the
// simulated watchdogs fire at twice the device's real window (and the
// mist one has no rows to measure across at all, §4b), so only the fixture
// replay should let them run. Everything replaying real telemetry passes
// the fault state it read from the device's own tag='sensor' log rows
// instead — see FaultOverride and src/lib/sensorFaults.ts.
export function temperaturePlausible(tempC: number | null): boolean {
  return tempC != null && tempC >= TEMP_PLAUSIBLE_MIN_C && tempC <= TEMP_PLAUSIBLE_MAX_C;
}

export function humidityPlausible(hum: number | null): boolean {
  return hum != null && hum >= HUMIDITY_PLAUSIBLE_MIN_PCT && hum <= HUMIDITY_PLAUSIBLE_MAX_PCT;
}

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
  // §3a/§4b latches. A fault is device state that clears only on a rise
  // past where it latched, a reboot, or automation going off -> on.
  tempFaulted: boolean;
  tempAtFault: number;
  heatNoRiseEvals: number;
  tempAtHeatStart: number;
  humFaulted: boolean;
  humAtFault: number;
  mistNoRiseEvals: number;
  humAtMistStart: number;
  // The previous step's `enabled`, so an off -> on toggle can clear both
  // faults the way the firmware's setEnabled() does.
  enabled: boolean;
};

export const INITIAL_CLIMATE_STATE: ClimateState = {
  heat: false,
  mist: false,
  tempTrigger: false,
  humTrigger: false,
  tempFaulted: false,
  tempAtFault: 0,
  heatNoRiseEvals: 0,
  tempAtHeatStart: 0,
  humFaulted: false,
  humAtFault: 0,
  mistNoRiseEvals: 0,
  humAtMistStart: 0,
  enabled: false,
};

// Fault state read from the device's own log rows rather than simulated —
// see the note above temperaturePlausible(). On firmware < 0.35.0 the gates
// don't exist and nothing writes the rows, so both are simply false.
export type FaultOverride = { temp: boolean; hum: boolean };

function updateTemperatureTrust(s: ClimateState, tempC: number): void {
  const plausible = temperaturePlausible(tempC);
  if (s.tempFaulted) {
    if (plausible && tempC >= s.tempAtFault + TEMP_RISE_EPSILON_C) {
      s.tempFaulted = false;
      s.tempAtFault = 0;
      s.heatNoRiseEvals = 0;
    }
    return;
  }
  if (!plausible) {
    s.tempFaulted = true;
    s.tempAtFault = TEMP_PLAUSIBLE_MIN_C;
    s.heatNoRiseEvals = 0;
    return;
  }
  // s.heat is still the previous evaluation's decision here.
  if (!s.heat) {
    s.heatNoRiseEvals = 0;
  } else if (s.heatNoRiseEvals === 0) {
    s.tempAtHeatStart = tempC;
    s.heatNoRiseEvals = 1;
  } else if (tempC >= s.tempAtHeatStart + TEMP_RISE_EPSILON_C) {
    s.tempAtHeatStart = tempC;
    s.heatNoRiseEvals = 1;
  } else if (++s.heatNoRiseEvals > HEAT_NO_RISE_EVAL_LIMIT) {
    s.tempFaulted = true;
    s.tempAtFault = tempC;
    s.heatNoRiseEvals = 0;
  }
}

function updateHumidityTrust(s: ClimateState, hum: number): void {
  const plausible = humidityPlausible(hum);
  if (s.humFaulted) {
    if (plausible && hum >= s.humAtFault + HUMIDITY_RISE_EPSILON_PCT) {
      s.humFaulted = false;
      s.humAtFault = 0;
      s.mistNoRiseEvals = 0;
    }
    return;
  }
  if (!plausible) {
    s.humFaulted = true;
    s.humAtFault = 0;
    s.mistNoRiseEvals = 0;
    return;
  }
  if (!s.mist) {
    s.mistNoRiseEvals = 0;
  } else if (s.mistNoRiseEvals === 0) {
    s.humAtMistStart = hum;
    s.mistNoRiseEvals = 1;
  } else if (hum >= s.humAtMistStart + HUMIDITY_RISE_EPSILON_PCT) {
    s.humAtMistStart = hum;
    s.mistNoRiseEvals = 1;
  } else if (++s.mistNoRiseEvals > MIST_NO_RISE_EVAL_LIMIT) {
    s.humFaulted = true;
    s.humAtFault = hum;
    s.mistNoRiseEvals = 0;
  }
}

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
  // Omit only when replaying climate_vectors.json; see FaultOverride.
  faults?: FaultOverride,
): { state: ClimateState; decision: ClimateDecision } {
  if (!enabled) {
    return {
      state: { ...state, enabled: false },
      decision: {
        heat: state.heat,
        mist: state.mist,
        fan: state.tempTrigger || state.humTrigger,
        tooHot: state.tempTrigger,
        tooHumid: state.humTrigger,
      },
    };
  }

  // Trust gates (§3a/§4b), ahead of everything that reads either channel.
  // Re-enabling automation is the keeper's manual reset for both latches.
  const trust: ClimateState = { ...state, enabled: true };
  if (!state.enabled) {
    Object.assign(trust, {
      tempFaulted: false, tempAtFault: 0, heatNoRiseEvals: 0,
      humFaulted: false, humAtFault: 0, mistNoRiseEvals: 0,
    });
  }
  if (faults) {
    trust.tempFaulted = faults.temp;
    trust.humFaulted = faults.hum;
  } else {
    updateTemperatureTrust(trust, tempC);
    updateHumidityTrust(trust, hum);
  }

  // Heater (§3): ceiling has no hysteresis; the OFF->ON and ON->OFF
  // thresholds differ (temp_low_c vs temp_low_c + hysteresis). A
  // temperature fault overrides all of it, the ceiling included — the
  // ceiling reads the same broken value.
  let heat = state.heat;
  if (trust.tempFaulted) {
    heat = false;
  } else if (tempC >= profile.tempHigh) {
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
  if (trust.humFaulted) {
    mist = false;
  } else if (hum >= profile.humidityHigh) {
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
  // Each trigger is also dropped while its own channel is distrusted —
  // which, for temp_trigger, releases §7's UVB cutout too.
  let tempTrigger = state.tempTrigger;
  if (trust.tempFaulted) {
    tempTrigger = false;
  } else if (tempC >= profile.tempHigh) {
    tempTrigger = true;
  } else if (tempTrigger && tempC < profile.tempHigh - TEMP_HYSTERESIS_C) {
    tempTrigger = false;
  }

  let humTrigger = state.humTrigger;
  if (trust.humFaulted) {
    humTrigger = false;
  } else if (hum >= profile.humidityHigh) {
    humTrigger = true;
  } else if (humTrigger && hum < profile.humidityHigh - HUMIDITY_HYSTERESIS_PCT) {
    humTrigger = false;
  }

  return {
    state: { ...trust, heat, mist, tempTrigger, humTrigger },
    decision: { heat, mist, fan: tempTrigger || humTrigger, tooHot: tempTrigger, tooHumid: humTrigger },
  };
}
