import { expect, it, vi } from "vite-plus/test";

import { act, render, stubGlobal } from "../../../test/render";

const state = vi.hoisted(() => ({
  primary: null as {
    environmentId: string;
    connection: { phase: string };
    serverConfig: object | null;
  } | null,
  navigate: vi.fn(async (): Promise<void> => undefined),
  openScratch: vi.fn(async () => ({ environmentId: "local", id: "scratch" })),
  openThread: vi.fn(async () => ({ threadId: "new-thread" })),
  openFile: vi.fn(async () => ({ _tag: "Success" })),
}));

vi.mock(import("@tanstack/react-router"), async (original) => ({
  ...(await original()),
  useRouter: (() => ({ navigate: state.navigate, state: { matches: [] } })) as never,
}));
// A remote-only desktop has no local primary or file-serving base URL.
vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  usePrimaryEnvironment: (() => state.primary) as never,
  useEnvironmentHttpBaseUrl: () => (state.primary ? "http://local" : null),
}));
vi.mock(import("../../hooks/useScratchProject"), async (original) => ({
  ...(await original()),
  useScratchProject: (() => ({
    scratchEnvironmentId: () => state.primary?.environmentId ?? null,
    openScratchProject: state.openScratch,
  })) as never,
}));
vi.mock(import("../../hooks/useHandleNewThread"), async (original) => ({
  ...(await original()),
  useNewThreadHandler: (() => state.openThread) as never,
}));
vi.mock(import("../../browser/openFileInPreview"), async (original) => ({
  ...(await original()),
  openFileInPreview: state.openFile as never,
}));

import { AppAtomRegistryProvider } from "../../rpc/atomRegistry";
import {
  DesktopWebLinkCoordinator,
  shouldMountDesktopWebLinkCoordinator,
} from "./DesktopWebLinkCoordinator";

function setup() {
  vi.clearAllMocks();
  state.primary = null;
}

/** A desktop bridge that hands over `startup` once the renderer is ready, and later links on `deliver`. */
function stubWebLinks(startup: string[] = []) {
  const bridge = {
    deliver: undefined as ((url: string) => void) | undefined,
    stub: stubGlobal("desktopBridge", {
      getClientSettings: async () => null,
      webLinks: {
        onOpen: (listener: (url: string) => void) => {
          bridge.deliver = listener;
          return () => {
            bridge.deliver = undefined;
          };
        },
        setReady: async (ready: boolean) => {
          if (ready) for (const url of startup.splice(0)) bridge.deliver?.(url);
        },
      },
    }),
  };
  return bridge;
}

// A fresh element each time, so a rerender reaches the coordinator instead of bailing out.
const coordinator = () => (
  <AppAtomRegistryProvider>
    <DesktopWebLinkCoordinator />
  </AppAtomRegistryProvider>
);

it("mounts in the authenticated and remote-only shells, not an auth gate", () => {
  expect(shouldMountDesktopWebLinkCoordinator("authenticated")).toBe(true);
  expect(shouldMountDesktopWebLinkCoordinator("hosted-static")).toBe(true);
  expect(shouldMountDesktopWebLinkCoordinator("unauthenticated")).toBe(false);
});

it("navigates an environment-qualified thread with local disabled, while other links stay gated", async () => {
  setup();
  const bridge = stubWebLinks();
  using _bridge = bridge.stub;
  await using _screen = await render(coordinator(), { router: false });
  await act(async () => {
    bridge.deliver?.("shuv2code://threads/remote-env/thread-one");
  });
  expect(state.navigate).toHaveBeenCalledExactlyOnceWith({ href: "/remote-env/thread-one" });
  for (const url of [
    "file:///Users/me/report.html",
    "https://example.test",
    "shuv2code://new?prompt=hello",
  ])
    await act(async () => {
      bridge.deliver?.(url);
    });
  expect(state.navigate).toHaveBeenCalledTimes(1);
});

it("holds a startup file link until primary readiness and opens it only once", async () => {
  setup();
  const bridge = stubWebLinks(["file:///Users/me/report.html"]);
  using _bridge = bridge.stub;
  await using screen = await render(coordinator(), { router: false });
  expect(state.openScratch).not.toHaveBeenCalled();
  expect(state.openFile).not.toHaveBeenCalled();
  await act(async () => {
    bridge.deliver?.("shuv2code://threads/remote-env/thread-one");
  });
  expect(state.navigate).toHaveBeenCalledExactlyOnceWith({ href: "/remote-env/thread-one" });

  state.primary = { environmentId: "local", connection: { phase: "connected" }, serverConfig: {} };
  await screen.rerender(coordinator());
  expect(state.openFile).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      filePath: "/Users/me/report.html",
      threadRef: { environmentId: "local", threadId: "new-thread" },
    }),
  );
  for (const phase of ["connecting", "connected"]) {
    state.primary = { ...state.primary, connection: { phase } };
    await screen.rerender(coordinator());
  }
  expect(state.openFile).toHaveBeenCalledTimes(1);
  expect(state.openScratch).toHaveBeenCalledTimes(1);
});
