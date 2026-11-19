import "~/index.css";
import { EnvironmentId, ProviderDriverKind, ThreadId, TurnItemId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
vi.mock(import("./CommandOutputPanel"), () => ({
  useCommandOutputStreaming: () => true,
  CommandOutputPanel: () => <div>Command output stream</div>,
}));

import { render } from "../../../test/render";
import { backgroundWorkNowItem } from "./ThreadActivityBanners";
import { ThreadNow } from "./ThreadNow";

it("opens full command details for short labels and keeps pending tasks current", async () => {
  const command = "python3 audit.py -j 6\n> scratch/audit.log 2>&1";
  const commandItem = (status: "running" | "completed") => ({
    id: TurnItemId.make("bash-1"),
    threadId: ThreadId.make("thread"),
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 1,
    status,
    title: null,
    startedAt: null,
    completedAt: null,
    updatedAt: DateTime.makeUnsafe("2026-11-09T00:00:00Z"),
    type: "command_execution" as const,
    input: command,
    output: "Command running in background with ID: native-task",
  });
  const view = (
    description?: string,
    status: "running" | "completed" = "completed",
    explicitItem = true,
  ) => (
    <ThreadNow
      attention={null}
      syncPhase={null}
      goal={null}
      work={backgroundWorkNowItem({
        environmentId: EnvironmentId.make("test"),
        threadId: ThreadId.make("thread"),
        tasks: [
          {
            taskId: "native-task",
            itemId: explicitItem ? TurnItemId.make("bash-1") : undefined,
            kind: "command",
            description,
            command,
            awaited: true,
          },
        ],
        turnItems: [
          commandItem(status),
          {
            ...commandItem("running"),
            id: TurnItemId.make("native-match"),
            nativeItemRef: {
              driver: ProviderDriverKind.make("codex"),
              nativeId: "native-task",
              strength: "strong",
            },
            ordinal: 2,
          },
        ],
        stopDisabled: false,
        stopping: false,
        onStop: async () => undefined,
        onOpenThread: () => undefined,
      })}
    />
  );
  await using screen = await render(view("Audit"));
  await screen.getByRole("button", { name: "Details", exact: true }).click();
  await vi.waitFor(() => expect(page.getByRole("dialog").element().textContent).toContain(command));
  await expect.element(page.getByText("Command output stream")).not.toBeInTheDocument();

  await screen.rerender(view(command));
  await expect.element(page.getByRole("heading", { name: "Command", exact: true })).toBeVisible();
  await screen.rerender(view());
  await expect.element(page.getByRole("heading", { name: "Command", exact: true })).toBeVisible();

  await screen.rerender(view("Check remaining modules", "running"));
  await expect
    .element(page.getByRole("heading", { name: "Check remaining modules" }))
    .toBeVisible();
  await expect.element(page.getByText("Command output stream")).toBeVisible();
  await screen.rerender(view("Native fallback", "completed", false));
  await expect.element(page.getByText("Command output stream")).toBeVisible();
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
});

it("counts child threads in the banner and groups their follow-ups in the dialog", async () => {
  const child = ThreadId.make("child");
  await using screen = await render(
    <ThreadNow
      attention={null}
      syncPhase={null}
      goal={null}
      work={backgroundWorkNowItem({
        environmentId: EnvironmentId.make("test"),
        threadId: ThreadId.make("thread"),
        tasks: [
          {
            taskId: "subagent-task",
            kind: "subagent",
            description: "Review refactor diffs",
            childThreadId: child,
          },
          {
            taskId: "follow-up-1",
            kind: "subagent",
            description: "Check tests",
            childThreadId: child,
          },
          {
            taskId: "other-subagent",
            kind: "subagent",
            description: "Review documentation",
            childThreadId: ThreadId.make("other-child"),
          },
          {
            taskId: "follow-up-2",
            kind: "subagent",
            description: "Check formatting",
            childThreadId: child,
          },
        ],
        turnItems: [],
        stopDisabled: false,
        stopping: false,
        onStop: async () => undefined,
        onOpenThread: () => undefined,
      })}
    />,
  );
  await expect.element(page.getByText("Waiting on 2 subagents", { exact: false })).toBeVisible();
  await screen.getByRole("button", { name: "Details", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await vi.waitFor(() =>
    expect(
      dialog.getByRole("button", { name: "Open subagent", exact: true }).elements(),
    ).toHaveLength(2),
  );
  await expect.element(dialog.getByText("+2 follow-ups", { exact: true })).toBeVisible();
  expect(dialog.getByText("Waiting", { exact: true }).elements()).toHaveLength(2);
});
