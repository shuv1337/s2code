// @effect-diagnostics nodeBuiltinImport:off -- Offline identity responses and disposable CI output fixtures.
import { describe, expect, it } from "vite-plus/test";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import {
  hostedDeploymentConfiguration,
  verifyHostedDeploymentIdentities,
  HOSTED_DEPLOYMENT_VARIABLES,
} from "./hosted-deployment-config.ts";

const env = {
  FORK_HOSTED_ENABLED: "1",
  SHUV2CODE_HOSTED_APP_URL: "https://app.fork.test",
  SHUV2CODE_WEB_LATEST_DOMAIN: "latest.fork.test",
  SHUV2CODE_WEB_NIGHTLY_DOMAIN: "nightly.fork.test",
  SHUV2CODE_AUTH_DOMAIN: "auth.fork.test",
  CLERK_PUBLISHABLE_KEY: `pk_live_${btoa("auth.fork.test$")}`,
  FORK_HOSTED_REDIRECT_ORIGINS: JSON.stringify([
    "https://app.fork.test",
    "https://latest.fork.test",
    "https://nightly.fork.test",
  ]),
  CLERK_CLI_OAUTH_CLIENT_ID: "client_fork",
  CLERK_OAUTH_APPLICATION_ID: "oauthapp_fork",
  CLERK_JWT_TEMPLATE: "fork-relay",
  CLERK_JWT_AUDIENCE: "fork-relay",
  PLANETSCALE_API_TOKEN_ID: "fixture",
  PLANETSCALE_API_TOKEN: "fixture",
  AXIOM_TOKEN: "fixture",
  RELAY_DOMAIN: "relay.fork.test",
  RELAY_API_ZONE_NAME: "fork.test",
  RELAY_TUNNEL_ZONE_NAME: "tunnels.fork.test",
  CLOUDFLARE_ACCOUNT_ID: "fork-account",
  PLANETSCALE_ORGANIZATION: "fork-org",
  AXIOM_ORG_ID: "fork-axiom",
  VERCEL_ORG_ID: "fork-team",
  VERCEL_PROJECT_ID: "fork-project",
  VERCEL_TOKEN: "fixture",
  CLOUDFLARE_API_TOKEN: "fixture",
  CLERK_SECRET_KEY: "fixture",
};
const oauth = {
  id: env.CLERK_OAUTH_APPLICATION_ID,
  client_id: env.CLERK_CLI_OAUTH_CLIENT_ID,
  public: true,
  pkce_required: true,
  authorize_url: "https://auth.fork.test/oauth/authorize",
  redirect_uris: ["http://127.0.0.1:34338/callback"],
};
const request = async (url: string) =>
  url.includes("api.clerk.com")
    ? oauth
    : url.includes("api.vercel.com")
      ? { id: env.VERCEL_PROJECT_ID, accountId: env.VERCEL_ORG_ID, rootDirectory: "apps/web" }
      : {
          success: true,
          result: [
            {
              name: new URL(url).searchParams.get("name"),
              account: { id: env.CLOUDFLARE_ACCOUNT_ID },
            },
          ],
        };

describe("hosted deployment gate", () => {
  it.each(HOSTED_DEPLOYMENT_VARIABLES)("requires explicit %s", (name) => {
    expect(() => hostedDeploymentConfiguration({ ...env, [name]: "" })).toThrow();
  });
  it.each([
    "SHUV2CODE_HOSTED_APP_URL",
    "SHUV2CODE_WEB_LATEST_DOMAIN",
    "SHUV2CODE_WEB_NIGHTLY_DOMAIN",
    "SHUV2CODE_AUTH_DOMAIN",
    "RELAY_DOMAIN",
    "RELAY_API_ZONE_NAME",
    "RELAY_TUNNEL_ZONE_NAME",
  ])("rejects upstream %s even with opt-in", (name) => {
    expect(() =>
      hostedDeploymentConfiguration({
        ...env,
        [name]: name.endsWith("URL") ? "https://app.t3.codes" : "relay.t3.codes",
      }),
    ).toThrow();
  });
  it("requires explicit opt-in before making any identity request", async () => {
    let calls = 0;
    await expect(
      verifyHostedDeploymentIdentities({}, "relay", async () => {
        calls++;
        return {};
      }),
    ).rejects.toThrow("not enabled");
    expect(calls).toBe(0);
  });
  it.each(["web", "relay"] as const)(
    "permits configured %s only after exact read-only identity checks",
    async (target) => {
      const urls: string[] = [];
      await verifyHostedDeploymentIdentities(env, target, async (url) => {
        urls.push(url);
        return request(url);
      });
      expect(urls[0]).toContain("/oauth_applications/oauthapp_fork");
      expect(urls).toHaveLength(target === "web" ? 2 : 3);
    },
  );
  it.each([
    { ...oauth, client_id: "upstream-client" },
    { ...oauth, authorize_url: "https://clerk.t3.codes/oauth/authorize" },
    { ...oauth, redirect_uris: ["https://app.t3.codes/callback"] },
    { ...oauth, redirect_uris: [...oauth.redirect_uris, "https://unconfigured.test/callback"] },
    { ...oauth, pkce_required: false },
  ])("refuses mismatched auth identity/redirects before deployment", async (response) => {
    await expect(
      verifyHostedDeploymentIdentities(env, "web", async () => response),
    ).rejects.toThrow();
  });
  it.each(["web", "relay"] as const)(
    "refuses an accessible but differently owned %s destination",
    async (target) => {
      await expect(
        verifyHostedDeploymentIdentities(env, target, async (url) =>
          url.includes("api.clerk.com")
            ? oauth
            : target === "web"
              ? { id: env.VERCEL_PROJECT_ID, accountId: "upstream-team" }
              : {
                  success: true,
                  result: [
                    {
                      name: new URL(url).searchParams.get("name"),
                      account: { id: "upstream-account" },
                    },
                  ],
                },
        ),
      ).rejects.toThrow();
    },
  );
  it("rejects inherited upstream Vercel Git linkage even when project IDs match", async () => {
    await expect(
      verifyHostedDeploymentIdentities(env, "web", async (url) =>
        url.includes("api.clerk.com")
          ? oauth
          : {
              id: env.VERCEL_PROJECT_ID,
              accountId: env.VERCEL_ORG_ID,
              rootDirectory: "apps/web",
              link: { type: "github", org: "pingdotgg", repo: "t3code" },
            },
      ),
    ).rejects.toThrow("another repository");
  });
  it("does not attempt identity requests without relay provisioning credentials", async () => {
    let calls = 0;
    await expect(
      verifyHostedDeploymentIdentities({ ...env, PLANETSCALE_API_TOKEN: "" }, "relay", async () => {
        calls++;
        return {};
      }),
    ).rejects.toThrow("requires PLANETSCALE_API_TOKEN");
    expect(calls).toBe(0);
  });
  it("skips unconfigured CI with a visible notice and false deployment output", () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "hosted-gate-"));
    try {
      const output = NodePath.join(directory, "output");
      const summary = NodePath.join(directory, "summary");
      const result = NodeChildProcess.spawnSync(
        process.execPath,
        [new URL("./hosted-deployment-preflight.ts", import.meta.url).pathname, "relay"],
        {
          env: { PATH: process.env.PATH, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary },
          encoding: "utf8",
        },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("::notice::Hosted deployment skipped");
      expect(NodeFS.readFileSync(output, "utf8")).toBe("allowed=false\n");
      expect(NodeFS.readFileSync(summary, "utf8")).toContain("CLI/desktop releases are unaffected");
    } finally {
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }
  });
});
