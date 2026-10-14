import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vite-plus/test";

const navigate = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("@tanstack/react-router", () => ({
  useRouter: () => ({ navigate, state: { matches: [] } }),
}));
// A remote-only desktop has no local primary or file-serving base URL.
vi.mock("../../state/environments", () => ({
  usePrimaryEnvironment: () => null,
  useEnvironmentHttpBaseUrl: () => null,
}));
vi.mock("../../hooks/useScratchProject", () => ({
  useScratchProject: () => ({ scratchEnvironmentId: () => null, openScratchProject: vi.fn() }),
}));
vi.mock("../../hooks/useHandleNewThread", () => ({ useNewThreadHandler: () => vi.fn() }));
vi.mock("../../browser/openFileInPreview", () => ({
  openFileInPreview: vi.fn(),
  openUrlInPreview: vi.fn(),
}));
vi.mock("../../browser/previewRuntime", () => ({ isPreviewAvailableFor: () => false }));
vi.mock("../../composerDraftStore", () => ({ useComposerDraftStore: { getState: vi.fn() } }));
vi.mock("../../rightPanelStore", () => ({
  selectActiveRightPanelSurface: vi.fn(),
  useRightPanelStore: { getState: vi.fn() },
}));
vi.mock("../../state/assets", () => ({ assetEnvironment: { createUrl: vi.fn() } }));
vi.mock("../../state/preview", () => ({ previewEnvironment: { open: vi.fn() } }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../../state/use-atom-query-runner", () => ({ useAtomQueryRunner: () => vi.fn() }));
vi.mock("../ui/toast", () => ({
  toastManager: { add: vi.fn() },
  stackedThreadToast: (input: unknown) => input,
}));

import {
  DesktopWebLinkCoordinator,
  shouldMountDesktopWebLinkCoordinator,
} from "./DesktopWebLinkCoordinator";

let renderer: ReactTestRenderer | undefined;
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

it("mounts in the authenticated and remote-only shells, not an auth gate", () => {
  expect(shouldMountDesktopWebLinkCoordinator("authenticated")).toBe(true);
  expect(shouldMountDesktopWebLinkCoordinator("hosted-static")).toBe(true);
  expect(shouldMountDesktopWebLinkCoordinator("unauthenticated")).toBe(false);
});

it("navigates an environment-qualified thread with local disabled, while other links stay gated", async () => {
  let listener: ((url: string) => void) | undefined;
  const webLinks = {
    onOpen: (next: (url: string) => void) => {
      listener = next;
      return () => {
        listener = undefined;
      };
    },
    setReady: vi.fn(async () => {}),
  };
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", { desktopBridge: { webLinks } });
  await act(async () => {
    renderer = create(<DesktopWebLinkCoordinator />);
  });
  await act(async () => {
    listener?.("shuv2code://threads/remote-env/thread-one");
  });
  expect(navigate).toHaveBeenCalledExactlyOnceWith({ href: "/remote-env/thread-one" });
  for (const url of [
    "file:///Users/me/report.html",
    "https://example.test",
    "shuv2code://new?prompt=hello",
  ])
    await act(async () => {
      listener?.(url);
    });
  expect(navigate).toHaveBeenCalledTimes(1);
});
