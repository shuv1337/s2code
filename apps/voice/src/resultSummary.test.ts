import { expect, it } from "vite-plus/test";

import { summarizeToolResult } from "./resultSummary.ts";

const text = (value: unknown) => [{ type: "text", text: JSON.stringify(value) }];

it("redacts secret keys inside JSON text before truncation", () => {
  const secret = "sekret-token-value";
  const output = summarizeToolResult({
    tool: "t3_thread_send",
    ok: false,
    maxChars: 4_000,
    content: text({
      token: secret,
      nested: JSON.stringify({
        clientSecret: secret,
        pairingToken: secret,
        authToken: secret,
      }),
      leak: `https://example.test/a?token=${secret}#token=${secret} sk-proj-abcdefghijklmnop ghp_abcdefghijklmnopqrstuvwxyz`,
      note: "visible",
    }),
  });
  expect(output).not.toContain(secret);
  expect(output).not.toContain("sk-proj-abcdefghijklmnop");
  expect(output).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz");
  expect(output).toContain("[redacted]");
  expect(output).toContain("visible");
  expect(output.indexOf("[redacted]")).toBeLessThan(output.indexOf("visible"));
});

it("keeps the last thread-read items and the paging cursor", () => {
  const output = summarizeToolResult({
    tool: "t3_thread_read",
    content: text({
      thread: { threadId: "thread-1", title: "notes", status: "idle" },
      hasMore: true,
      nextPosition: 9,
      items: [0, 1, 2, 3, 4, 5].map((n) => ({ type: "user", text: `item-${n}` })),
    }),
  });
  const parsed = JSON.parse(output) as {
    hasMore: boolean;
    nextPosition: number;
    items: Array<{ text: string }>;
  };
  expect(parsed.hasMore).toBe(true);
  expect(parsed.nextPosition).toBe(9);
  expect(parsed.items.map((item) => item.text)).toEqual(["item-2", "item-3", "item-4", "item-5"]);
});
