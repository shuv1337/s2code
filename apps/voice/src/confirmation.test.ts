import { expect, it } from "vite-plus/test";

import { applyConfirmation, decideConfirmation } from "./confirmation.ts";

it("rejects destructive tools with spoken message (no await confirm path that runs them)", () => {
  const d = decideConfirmation({
    tool: "t3_environment_unlink",
    environmentLabel: "shuvbot",
  });
  expect(d.action).toBe("reject");
  if (d.action === "reject") {
    expect(d.speak.toLowerCase()).toContain("blocked");
  }
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
  await applyConfirmation(d, (t) => spoken.push(t));
  expect(spoken).toEqual([]);
});
