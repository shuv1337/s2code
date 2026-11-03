import { MCP_TOKEN_REDACTED } from "@t3tools/client-runtime/mcp-server-token";
import type { McpServerConfig } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { mcpServerDraft, mcpServerHost, parseMcpServerDraft } from "./mcp-servers";

const saved: Record<string, McpServerConfig> = {
  executor: {
    label: "Executor",
    url: "https://executor.example.com/mcp",
    bearerToken: MCP_TOKEN_REDACTED,
    enabled: true,
  },
};

describe("parseMcpServerDraft", () => {
  it.each([
    ["", "Enter a name."],
    ["t3tools", "Names starting with t3 are reserved."],
    ["Executor", "Use up to 24 lowercase letters, digits, or hyphens, starting with a letter."],
    ["1password", "Use up to 24 lowercase letters, digits, or hyphens, starting with a letter."],
    ["a".repeat(25), "Use up to 24 lowercase letters, digits, or hyphens, starting with a letter."],
    ["executor", "A server named executor already exists."],
  ])("rejects the new name %j", (id, error) => {
    const draft = { ...mcpServerDraft(id, undefined), url: "https://example.com" };
    expect(parseMcpServerDraft(draft, saved, true)).toEqual({ ok: false, error });
  });

  it.each(["", "example.com", "ftp://example.com", "https://"])("rejects the URL %j", (url) => {
    const draft = { ...mcpServerDraft("docs", undefined), url };
    expect(parseMcpServerDraft(draft, saved, true)).toEqual({
      ok: false,
      error: "Enter a URL starting with http:// or https://.",
    });
  });

  it("keeps a saved token by sending the redaction marker back", () => {
    const draft = { ...mcpServerDraft("executor", saved.executor), label: "  Tools  " };
    expect(parseMcpServerDraft(draft, saved, false)).toEqual({
      ok: true,
      value: {
        id: "executor",
        config: {
          label: "Tools",
          url: "https://executor.example.com/mcp",
          bearerToken: MCP_TOKEN_REDACTED,
          enabled: true,
        },
      },
    });
  });
});

describe("mcpServerHost", () => {
  it.each([
    ["https://executor.example.com:8443/mcp?x=1", "executor.example.com:8443"],
    ["http://localhost/mcp", "localhost"],
  ])("shows the host of %s", (url, host) => {
    expect(mcpServerHost(url)).toBe(host);
  });
});
