import { assert, it } from "@effect/vitest";
import {
  WINDOWS_POLICY_GROUPS,
  WINDOWS_POLICY_LISTS,
  WINDOWS_POLICY_VALUES,
} from "@t3tools/shared/managedPolicyFile";

import { macosProfile, windowsAdml, windowsAdmx } from "./policyTemplates.ts";

it("gives every registry value the Windows reader accepts a Group Policy control", () => {
  const admx = windowsAdmx();
  for (const name of Object.keys(WINDOWS_POLICY_VALUES)) {
    assert.include(admx, `valueName="${name}"`);
  }
  for (const key of Object.keys(WINDOWS_POLICY_LISTS)) {
    assert.include(admx, `key="SOFTWARE\\Policies\\T3Tools\\T3Code\\${key}"`);
  }
  for (const name of Object.keys(WINDOWS_POLICY_GROUPS)) {
    assert.include(admx, `valueName="${name}"`);
  }
});

it("refuses a profile for a policy with a null value, which a plist cannot hold", () => {
  const profile = macosProfile(
    {
      schemaVersion: 1,
      organization: "Example Corp",
      settings: { defaultModelSelection: { value: null, locked: true } },
    },
    { profile: "profile-uuid", payload: "payload-uuid" },
  );
  assert.deepStrictEqual(profile, {
    _tag: "Invalid",
    reason:
      "settings.defaultModelSelection is null, which a configuration profile cannot hold; deploy this policy as a file.",
  });
});

it("describes the Telemetry Group Policy control as agent feedback delivery while keeping the Telemetry registry value", () => {
  const admx = windowsAdmx();
  const adml = windowsAdml();
  assert.include(admx, '<policy name="Telemetry"');
  assert.include(admx, 'valueName="Telemetry"');
  assert.include(adml, '<string id="Telemetry">Allow agent feedback delivery</string>');
  assert.include(
    adml,
    '<string id="Telemetry_Help">Disabled stops opt-in agent feedback reports from leaving this machine. Background usage data and relay traces are always off.</string>',
  );
});
