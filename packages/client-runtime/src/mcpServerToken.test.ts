import { McpServerId, type McpServerConfig } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { MCP_TOKEN_REDACTED, mcpServerTestInput, mcpServerTokenToSave } from "./mcpServerToken.ts";

const id = McpServerId.make("executor");
const url = "https://executor.example.com/mcp";
const saved: McpServerConfig = { url, bearerToken: MCP_TOKEN_REDACTED, enabled: true };
const edit = { saved, url, typed: "", cleared: false };
const moved = { ...edit, url: "https://elsewhere.example.com/mcp" };

describe("mcpServerTokenToSave", () => {
  it.each([
    ["keeps the saved token", edit, MCP_TOKEN_REDACTED],
    ["replaces it with typed text", { ...edit, typed: " next " }, "next"],
    ["removes it when cleared", { ...edit, cleared: true }, ""],
    ["drops it once the URL changes", moved, ""],
    ["takes a token typed for the new URL", { ...moved, typed: "again" }, "again"],
    ["has nothing to keep for a new server", { ...edit, saved: undefined }, ""],
  ])("%s", (_name, tokenEdit, expected) => {
    expect(mcpServerTokenToSave(tokenEdit)).toBe(expected);
  });
});

describe("mcpServerTestInput", () => {
  it("omits the token only when the server should use its saved one", () => {
    expect(mcpServerTestInput(id, url, edit)).toEqual({ id, url });
    expect(mcpServerTestInput(id, moved.url, moved)).toEqual({
      id,
      url: moved.url,
      bearerToken: "",
    });
    expect(mcpServerTestInput(id, url, { ...edit, typed: "typed" })).toEqual({
      id,
      url,
      bearerToken: "typed",
    });
  });
});
