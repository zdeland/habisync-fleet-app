// Replays test/fixtures/climate_vectors.json — the same fixture the
// firmware repo's native test (pio test -e native) checks its C++
// ClimateController against — through src/lib/automation.ts. See
// docs/automation-rules.md and known-issues.md's fixture-sync note:
// re-copy the fixture whenever the firmware repo's version changes, and
// treat a red test after that copy as the reducer needing an update, not
// the fixture being wrong.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { evaluateClimateStep, INITIAL_CLIMATE_STATE, type ClimateProfile } from '../src/lib/automation';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(join(here, 'fixtures/climate_vectors.json'), 'utf-8'));

type Step = {
  temp: number;
  hum: number;
  expect: { heat: boolean; mist: boolean; fan: boolean; tooHot: boolean; tooHumid: boolean };
  note?: string;
};

type Scenario = {
  name: string;
  profile: ClimateProfile;
  enabled: boolean;
  steps: Step[];
};

for (const scenario of fixture.scenarios as Scenario[]) {
  test(scenario.name, () => {
    let state = INITIAL_CLIMATE_STATE;

    scenario.steps.forEach((step, i) => {
      const result = evaluateClimateStep(state, scenario.profile, scenario.enabled, step.temp, step.hum);
      state = result.state;

      const label = `${scenario.name} — step ${i + 1}${step.note ? ` (${step.note})` : ''}`;
      assert.deepEqual(result.decision, step.expect, label);
    });
  });
}
