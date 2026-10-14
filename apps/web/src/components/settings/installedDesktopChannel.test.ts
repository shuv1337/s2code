import { expect, it } from "vite-plus/test";
import { resolveInstalledDesktopChannel } from "./SettingsPanels.logic";

it.each([
  ["1.2.3", "nightly", "Stable"],
  ["1.2.3-nightly.20261014.1", "latest", "Nightly"],
  ["1.2.3-preview.20261014.1", "latest", "Preview"],
  ["1.2.3-pr.275.1", "nightly", "Preview"],
] as const)("shows %s as %s-independent %s", (currentVersion, channel, label) => {
  expect(resolveInstalledDesktopChannel({ currentVersion, channel }, "9.0.0").label).toBe(label);
});
it("uses the built channel while updater state is loading", () => {
  expect(resolveInstalledDesktopChannel(null, "1.2.3-preview.20261014.1").label).toBe("Preview");
});
