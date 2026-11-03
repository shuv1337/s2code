import type { McpServerConfig } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  MCP_SECRET_REDACTED,
  describeMcpServerTest,
  mcpServerDraft,
  mcpServerHost,
  mcpServerTestInput,
  parseMcpServerDraft,
} from "./mcp-servers";

const saved: Record<string, McpServerConfig> = {
  executor: {
    label: "Executor",
    url: "https://executor.example.com/mcp",
    bearerToken: MCP_SECRET_REDACTED,
    enabled: true,
  },
  open: { url: "http://localhost:4000/mcp", bearerToken: "", enabled: false },
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
          bearerToken: MCP_SECRET_REDACTED,
          enabled: true,
        },
      },
    });
  });

  it("replaces, clears, or leaves unset the token", () => {
    const executor = mcpServerDraft("executor", saved.executor);
    const config = (draft: typeof executor, isNew = false) => {
      const parsed = parseMcpServerDraft(draft, saved, isNew);
      return parsed.ok ? parsed.value.config : parsed.error;
    };
    expect(config({ ...executor, token: " new " })).toMatchObject({ bearerToken: "new" });
    expect(config({ ...executor, clearToken: true })).toMatchObject({ bearerToken: "" });
    expect(config(mcpServerDraft("open", saved.open))).toMatchObject({ bearerToken: "" });
    expect(
      config({ ...mcpServerDraft("docs", undefined), url: "https://docs.example.com" }, true),
    ).toEqual({ url: "https://docs.example.com", bearerToken: "", enabled: true });
  });
});

describe("mcpServerTestInput", () => {
  it("omits the token only to test with the saved one", () => {
    const executor = mcpServerDraft("executor", saved.executor);
    expect(mcpServerTestInput(executor, saved, false)).toEqual({
      ok: true,
      value: { id: "executor", url: "https://executor.example.com/mcp" },
    });
    expect(mcpServerTestInput({ ...executor, token: "typed" }, saved, false)).toEqual({
      ok: true,
      value: { id: "executor", url: "https://executor.example.com/mcp", bearerToken: "typed" },
    });
    expect(mcpServerTestInput({ ...executor, clearToken: true }, saved, false)).toEqual({
      ok: true,
      value: { id: "executor", url: "https://executor.example.com/mcp", bearerToken: "" },
    });
  });

  it("drops a saved token once the URL changes, unless it is entered again", () => {
    const moved = { ...mcpServerDraft("executor", saved.executor), url: "https://elsewhere.test" };
    expect(parseMcpServerDraft(moved, saved, false)).toMatchObject({
      ok: true,
      value: { config: { bearerToken: "" } },
    });
    expect(mcpServerTestInput(moved, saved, false)).toMatchObject({
      ok: true,
      value: { bearerToken: "" },
    });
    expect(parseMcpServerDraft({ ...moved, token: "again" }, saved, false)).toMatchObject({
      ok: true,
      value: { config: { url: "https://elsewhere.test", bearerToken: "again" } },
    });
  });
});

describe("MCP server presentation", () => {
  it.each([
    ["https://executor.example.com:8443/mcp?x=1", "executor.example.com:8443"],
    ["http://localhost/mcp", "localhost"],
  ])("shows the host of %s", (url, host) => {
    expect(mcpServerHost(url)).toBe(host);
  });

  it("describes each test result", () => {
    expect(
      describeMcpServerTest({
        _tag: "Connected",
        serverName: "Executor",
        tools: Array.from({ length: 10 }, (_, index) => `t${index}`),
      }),
    ).toEqual({
      tone: "default",
      message: "Connected to Executor. 10 tools: t0, t1, t2, t3, t4, t5, t6, t7, and 2 more.",
    });
    expect(describeMcpServerTest({ _tag: "Connected", tools: [] }).message).toBe(
      "Connected to the server. No tools listed.",
    );
    expect(describeMcpServerTest({ _tag: "Rejected", status: 401 }).message).toBe(
      "The server rejected the token (HTTP 401).",
    );
    expect(describeMcpServerTest({ _tag: "Rejected", status: 500 }).message).toBe(
      "The server responded with HTTP 500.",
    );
    expect(describeMcpServerTest({ _tag: "Unreachable", timedOut: true }).message).toBe(
      "The server did not respond in time.",
    );
  });
});
