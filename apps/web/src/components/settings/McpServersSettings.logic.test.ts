import { McpServerId, type McpServerConfig } from "@t3tools/contracts";
import * as Result from "effect/Result";
import { describe, expect, it } from "vite-plus/test";

import {
  draftFromMcpServer,
  mcpServerFromDraft,
  newMcpServerDraft,
  nextMcpServerToken,
  type McpServerTarget,
} from "./McpServersSettings.logic";

const REDACTED = "\u2022".repeat(6);
const id = McpServerId.make("executor");
const saved: McpServerConfig = {
  label: "Executor",
  url: "https://executor.example.com/mcp",
  bearerToken: REDACTED,
  enabled: false,
};
const edit: McpServerTarget = { mode: "edit", id, config: saved };

describe("mcpServerFromDraft", () => {
  it("adds an enabled server and reports every field that blocks it", () => {
    expect(
      mcpServerFromDraft(
        {
          id: " executor ",
          label: "  ",
          url: " https://executor.example.com/mcp ",
          token: { kind: "new", value: " secret " },
        },
        new Set(),
        { mode: "add" },
      ),
    ).toEqual(
      Result.succeed({
        id: "executor",
        config: { url: "https://executor.example.com/mcp", bearerToken: "secret", enabled: true },
      }),
    );

    const cases: ReadonlyArray<[string, string, string]> = [
      ["", "", "Enter a name."],
      ["t3code", "ftp://x", "reserved"],
      ["Executor", "executor.example.com", "lowercase"],
      ["executor", "https://", "A server with this name exists."],
    ];
    for (const [name, url, idIssue] of cases) {
      const blocked = mcpServerFromDraft(
        { ...newMcpServerDraft(), id: name, url },
        new Set(["executor"]),
        { mode: "add" },
      );
      expect(Result.isFailure(blocked) && blocked.failure.id).toContain(idIssue);
      expect(Result.isFailure(blocked) && blocked.failure.url).toBeTruthy();
    }
  });

  it("keeps the id, enabled state, and saved token of an edited server", () => {
    const draft = draftFromMcpServer(id, saved);
    expect(draft.token).toEqual({ kind: "saved" });
    expect(mcpServerFromDraft({ ...draft, id: "ignored" }, new Set([id]), edit)).toEqual(
      Result.succeed({ id, config: saved }),
    );
  });
});

describe("nextMcpServerToken", () => {
  it("brings a saved token back when the field empties, but only Clear drops it", () => {
    expect(nextMcpServerToken("abc", edit)).toEqual({ kind: "new", value: "abc" });
    expect(nextMcpServerToken("", edit)).toEqual({ kind: "saved" });
    expect(nextMcpServerToken("", { mode: "add" })).toEqual({ kind: "cleared" });
    expect(nextMcpServerToken("", { ...edit, config: { ...saved, bearerToken: "" } })).toEqual({
      kind: "cleared",
    });
  });
});
