import { expect, it } from "vite-plus/test";

import { applyConfirmation, decideConfirmation } from "./confirmation.ts";

it("asks for a spoken yes before a guarded tool and blocks delete", () => {
  const guarded = decideConfirmation({
    tool: "t3_environment_unlink",
    environmentLabel: "shuvbot",
    args: { environmentId: "env-shuvbot" },
  });
  expect(guarded.action).toBe("await_confirm");
  if (guarded.action === "await_confirm") {
    expect(guarded.speak).toBe(
      "Say yes to t3_environment_unlink on shuvbot, environment env-shuvbot.",
    );
  }
  const blocked = decideConfirmation({
    tool: "t3_project_delete",
    environmentLabel: "shuvbot",
  });
  expect(blocked.action).toBe("reject");
});

it("announces environment name before side-effecting allowlisted tools", async () => {
  const spoken: string[] = [];
  const d = decideConfirmation({
    tool: "t3_thread_launch",
    environmentLabel: "shuvbot",
  });
  expect(d.action).toBe("proceed");
  if (d.action === "proceed") {
    expect(d.announce).toBe("On shuvbot.");
  }
  const gate = await applyConfirmation(d, (t) => {
    spoken.push(t);
  });
  expect(gate).toBe("proceed");
  expect(spoken).toEqual(["On shuvbot."]);
});

it("read-only tools proceed silently", async () => {
  const spoken: string[] = [];
  const d = decideConfirmation({
    tool: "t3_thread_list",
    environmentLabel: "shuvdev",
  });
  expect(d.action).toBe("proceed");
  await applyConfirmation(d, (t) => {
    spoken.push(t);
  });
  expect(spoken).toEqual([]);
});
