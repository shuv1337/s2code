import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { describe, expect, it, vi } from "vite-plus/test";
import { act, render } from "../../../test/render";
import { refreshTheme, useTheme } from "../../hooks/useTheme";
import {
  THEME_APPEARANCE_MODE_STORAGE_KEY,
  THEME_FOLLOW_SYSTEM_STORAGE_KEY,
  THEME_HALVES_STORAGE_KEY,
} from "../../themePalette";
import { useSettingsRestore } from "./SettingsPanels";

const mocks = vi.hoisted(() => ({
  confirm: vi.fn(),
  updateSettings: vi.fn(),
}));

vi.mock("./useScopedSettings", () => ({
  useScopedSettings: () => DEFAULT_UNIFIED_SETTINGS,
  useUpdateScopedSettings: () => mocks.updateSettings,
  useScopedSettingsMixed: () => false,
  useScopedSettingSource: () => null,
  useClearScopedSettings: () => vi.fn(),
  useClearProjectOverrides: () => vi.fn(),
  useScopedSettingsWriteAllowed: () => true,
}));

vi.mock("../../localApi", () => ({
  readLocalApi: () => ({ dialogs: { confirm: mocks.confirm } }),
  ensureLocalApi: () => ({ dialogs: { confirm: mocks.confirm } }),
}));

const themeKeys = [
  "t3code:theme",
  THEME_APPEARANCE_MODE_STORAGE_KEY,
  THEME_FOLLOW_SYSTEM_STORAGE_KEY,
  THEME_HALVES_STORAGE_KEY,
];

function setup(storage: Record<string, string> = {}) {
  mocks.confirm.mockReset().mockResolvedValue(true);
  mocks.updateSettings.mockReset();
  const previous = themeKeys.map((key) => [key, localStorage.getItem(key)] as const);
  for (const key of themeKeys) {
    localStorage.removeItem(key);
    if (storage[key] !== undefined) localStorage.setItem(key, storage[key]);
  }
  refreshTheme();
  return {
    [Symbol.dispose]() {
      for (const [key, value] of previous) {
        if (value === null) localStorage.removeItem(key);
        else localStorage.setItem(key, value);
      }
      refreshTheme();
    },
  };
}

function RestoreDeviceDefaults() {
  const { changedSettingLabels, restoreDefaults } = useSettingsRestore();
  const { theme, appearanceMode } = useTheme();
  return (
    <>
      <button disabled={changedSettingLabels.length === 0} onClick={() => void restoreDefaults()}>
        Restore device defaults
      </button>
      <output aria-label="Changed settings">{changedSettingLabels.join(", ") || "None"}</output>
      <output aria-label="Theme">
        {theme} {appearanceMode}
      </output>
    </>
  );
}

describe("device theme defaults", () => {
  it("retains the stored preferences when clearing a theme key fails", async () => {
    const storage = {
      "t3code:theme": "grove",
      [THEME_APPEARANCE_MODE_STORAGE_KEY]: "light",
      [THEME_FOLLOW_SYSTEM_STORAGE_KEY]: "false",
      [THEME_HALVES_STORAGE_KEY]: JSON.stringify({ dark: "ember" }),
    };
    using _storage = setup(storage);
    await using screen = await render(<RestoreDeviceDefaults />);
    const removeItem = Storage.prototype.removeItem;
    using _failure = vi.spyOn(Storage.prototype, "removeItem").mockImplementation(function (
      this: Storage,
      key,
    ) {
      if (key === THEME_APPEARANCE_MODE_STORAGE_KEY) throw new Error("storage blocked");
      removeItem.call(this, key);
    });
    using _log = vi.spyOn(console, "error").mockImplementation(() => {});
    await screen.getByRole("button", { name: "Restore device defaults" }).click();
    for (const [key, value] of Object.entries(storage))
      expect(localStorage.getItem(key)).toBe(value);
    await expect.element(screen.getByLabelText("Theme")).toHaveTextContent("grove light");
    await expect
      .element(screen.getByRole("button", { name: "Restore device defaults" }))
      .toBeEnabled();
  });

  it("has nothing to restore on a fresh install", async () => {
    using _storage = setup();
    await using screen = await render(<RestoreDeviceDefaults />);
    await expect
      .element(screen.getByRole("button", { name: "Restore device defaults" }))
      .toBeDisabled();
    await expect.element(screen.getByLabelText("Changed settings")).toHaveTextContent("None");
    await expect.element(screen.getByLabelText("Theme")).toHaveTextContent("ocean dark");
  });

  it.each([
    {
      name: "a different palette and light appearance",
      storage: { "t3code:theme": "grove", [THEME_APPEARANCE_MODE_STORAGE_KEY]: "light" },
      labels: ["Theme", "Appearance"],
    },
    {
      name: "legacy System and an automatic theme mix",
      storage: {
        "t3code:theme": "system",
        [THEME_FOLLOW_SYSTEM_STORAGE_KEY]: "true",
        [THEME_HALVES_STORAGE_KEY]: JSON.stringify({ dark: "grove" }),
      },
      labels: ["Theme", "Appearance", "Theme mix"],
    },
    {
      name: "explicit Ocean dark preferences",
      storage: { "t3code:theme": "ocean", [THEME_APPEARANCE_MODE_STORAGE_KEY]: "dark" },
      labels: ["Theme", "Appearance"],
    },
  ])("clears $name back to implicit Ocean dark", async ({ storage, labels }) => {
    using _storage = setup(storage);
    await using screen = await render(<RestoreDeviceDefaults />);
    const button = screen.getByRole("button", { name: "Restore device defaults" });
    await expect.element(button).toBeEnabled();
    await expect
      .element(screen.getByLabelText("Changed settings"))
      .toHaveTextContent(labels.join(", "));
    await button.click();
    expect(mocks.confirm).toHaveBeenCalledWith(
      `Restore default settings?\nThis will reset: ${labels.join(", ")}.`,
      { variant: "destructive" },
    );
    for (const key of themeKeys) expect(localStorage.getItem(key), key).toBeNull();
    await expect.element(button).toBeDisabled();
    await expect.element(screen.getByLabelText("Theme")).toHaveTextContent("ocean dark");
    await act(() => refreshTheme());
    await expect.element(screen.getByLabelText("Theme")).toHaveTextContent("ocean dark");
  });
});
