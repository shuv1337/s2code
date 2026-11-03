import { McpServerId, type McpServerConfig } from "@t3tools/contracts";
import * as Result from "effect/Result";
import { describe, expect, it } from "vite-plus/test";

import {
  describeMcpServerTest,
  draftFromMcpServer,
  mcpServerFromDraft,
  mcpServerTestInputFromDraft,
  newMcpServerDraft,
  nextMcpServerToken,
  savedTokenDropped,
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

  it("keeps, replaces, or clears the saved token and keeps the id and enabled state", () => {
    const draft = draftFromMcpServer(id, saved);
    expect(draft.token).toEqual({ kind: "saved" });
    const save = (token: typeof draft.token) =>
      mcpServerFromDraft({ ...draft, id: "ignored", token }, new Set([id]), edit);
    expect(save({ kind: "saved" })).toEqual(Result.succeed({ id, config: saved }));
    expect(save({ kind: "new", value: "next" })).toEqual(
      Result.succeed({ id, config: { ...saved, bearerToken: "next" } }),
    );
    expect(save({ kind: "cleared" })).toEqual(
      Result.succeed({ id, config: { ...saved, bearerToken: "" } }),
    );
    const moved = (token: typeof draft.token) =>
      mcpServerFromDraft(
        { ...draft, url: "https://other.example.com/mcp", token },
        new Set([id]),
        edit,
      );
    expect(moved({ kind: "saved" })).toEqual(
      Result.succeed({
        id,
        config: { ...saved, url: "https://other.example.com/mcp", bearerToken: "" },
      }),
    );
    expect(moved({ kind: "new", value: "next" })).toEqual(
      Result.succeed({
        id,
        config: { ...saved, url: "https://other.example.com/mcp", bearerToken: "next" },
      }),
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

describe("mcpServerTestInputFromDraft", () => {
  it("never sends the redaction marker and sends an explicit token otherwise", () => {
    const draft = draftFromMcpServer(id, saved);
    expect(mcpServerTestInputFromDraft(draft, new Set([id]), edit)).toEqual({
      id,
      url: saved.url,
    });
    expect(
      mcpServerTestInputFromDraft({ ...draft, token: { kind: "cleared" } }, new Set([id]), edit),
    ).toEqual({ id, url: saved.url, bearerToken: "" });
    expect(mcpServerTestInputFromDraft({ ...draft, url: "nope" }, new Set([id]), edit)).toBeNull();
  });

  it("drops a saved token once the URL changes", () => {
    const draft = draftFromMcpServer(id, saved);
    const movedDraft = { ...draft, url: "https://other.example.com" };
    expect(savedTokenDropped(draft, edit)).toBe(false);
    expect(savedTokenDropped(movedDraft, edit)).toBe(true);
    expect(mcpServerTestInputFromDraft(movedDraft, new Set([id]), edit)).toEqual({
      id,
      url: "https://other.example.com",
      bearerToken: "",
    });
  });
});

describe("describeMcpServerTest", () => {
  it("names the first tools and points a rejected token at the token", () => {
    expect(
      describeMcpServerTest({
        _tag: "Connected",
        tools: ["search", "execute", "describe", "call", "skills", "resume"],
      }).label,
    ).toBe("Connected · 6 tools: search, execute, describe, …");
    expect(describeMcpServerTest({ _tag: "Rejected", status: 401 })).toEqual({
      label: "Rejected (HTTP 401): check the token",
      ok: false,
    });
    expect(describeMcpServerTest({ _tag: "Rejected", status: 500 }).label).toBe(
      "Rejected (HTTP 500)",
    );
  });
});
