import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerSettings,
} from "@t3tools/contracts";
import { usageLimitPoolLabel } from "@t3tools/shared/usageLimits";
import { expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { providerInstanceEntriesFor } from "../../providerInstances";
import { ProviderModelPicker } from "./ProviderModelPicker";

const cursor = ProviderDriverKind.make("cursor");
const spent = ProviderInstanceId.make("cursor_spent");
const fresh = ProviderInstanceId.make("cursor_fresh");
const model = { slug: "composer-max", name: "Composer Max", isCustom: false, capabilities: null };

const provider = (instanceId: ProviderInstanceId, enabled: boolean): ServerProvider => ({
  instanceId,
  driver: cursor,
  enabled,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-11-02T00:00:00.000Z",
  models: [model],
  slashCommands: [],
  skills: [],
});

const settings: Pick<ServerSettings, "providerInstances" | "projectSettingsOverrides"> = {
  providerInstances: {
    [spent]: {
      driver: cursor,
      enabled: false,
      disableOnUsageLimit: true,
      usageLimitDisabled: { at: "2026-11-02T00:00:00.000Z", message: "Usage limit reached." },
    },
    [fresh]: { driver: cursor, enabled: true, disableOnUsageLimit: true },
  },
  projectSettingsOverrides: {},
};

it("opens on the pool's shown member when the thread's instance was auto-disabled", async () => {
  await using _screen = await render(
    <ProviderModelPicker
      environmentId={null}
      activeInstanceId={spent}
      model={model.slug}
      lockedProvider={null}
      instanceEntries={providerInstanceEntriesFor(
        [provider(spent, false), provider(fresh, true)],
        settings,
        null,
      )}
      modelOptionsByInstance={
        new Map([
          [spent, [model]],
          [fresh, [model]],
        ])
      }
      keybindings={[]}
      open
      onInstanceModelChange={() => {}}
    />,
  );

  await expect
    .element(page.getByRole("button", { name: usageLimitPoolLabel(cursor) }))
    .toHaveAttribute("aria-pressed", "true");
  await expect.element(page.getByRole("option", { name: /Composer Max/ })).toBeVisible();
});
