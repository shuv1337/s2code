// @effect-diagnostics nodeBuiltinImport:off -- Offline guard checks inspect source and workflows without provisioning providers.
import * as NodeFS from "node:fs";
import { UPSTREAM_HOSTED_DOMAINS } from "@t3tools/shared/hostedConfig";
import { assert, describe, expect, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

import {
  assertForkFeedbackGithubRepo,
  assertForkRelayDeploymentEnv,
  forkRelayDeploymentConfig,
} from "./forkOwnership.ts";

const VALID_ACCOUNT_ID = "771240435fb4f1407f2b4669085dc79d";
const VALID_CLERK_KEY = `pk_live_${btoa("clerk.s2code.dev$")}`;

const validExternalEnv = (
  overrides: Readonly<Record<string, string | undefined>> = {},
): Record<string, string | undefined> => ({
  CLOUDFLARE_ACCOUNT_ID: VALID_ACCOUNT_ID,
  RELAY_API_ZONE_NAME: "s2code.dev",
  RELAY_TUNNEL_ZONE_NAME: "s2code.dev",
  CLERK_PUBLISHABLE_KEY: VALID_CLERK_KEY,
  RELAY_DB_HOST: "pg.s2code.dev",
  RELAY_DB_NAME: "s2coderelay",
  RELAY_DB_USER: "relay",
  RELAY_DB_PASSWORD: "secret-password",
  RELAY_DB_ACCESS_CLIENT_ID: "access-id",
  RELAY_DB_ACCESS_CLIENT_SECRET: "access-secret",
  ...overrides,
});

const validPlanetscaleEnv = (
  overrides: Readonly<Record<string, string | undefined>> = {},
): Record<string, string | undefined> => ({
  CLOUDFLARE_ACCOUNT_ID: VALID_ACCOUNT_ID,
  RELAY_API_ZONE_NAME: "s2code.dev",
  RELAY_TUNNEL_ZONE_NAME: "s2code.dev",
  CLERK_PUBLISHABLE_KEY: VALID_CLERK_KEY,
  PLANETSCALE_ORGANIZATION: "shuv-org",
  ...overrides,
});

describe("assertForkRelayDeploymentEnv", () => {
  it("accepts external Postgres without PlanetScale or Axiom credentials", () => {
    expect(assertForkRelayDeploymentEnv(validExternalEnv())).toEqual({
      cloudflareAccountId: VALID_ACCOUNT_ID,
      relayApiZoneName: "s2code.dev",
      relayTunnelZoneName: "s2code.dev",
      relayDomain: undefined,
      clerkPublishableKey: VALID_CLERK_KEY,
      databaseBackend: "external",
      observabilityBackend: "none",
    });
    expect(
      assertForkRelayDeploymentEnv(
        validExternalEnv({ RELAY_DOMAIN: "relay.s2code.dev", AXIOM_TOKEN: "xaat-test" }),
      ),
    ).toMatchObject({
      relayDomain: "relay.s2code.dev",
      databaseBackend: "external",
      observabilityBackend: "none",
    });
  });

  it("accepts PlanetScale mode when PLANETSCALE_ORGANIZATION is configured", () => {
    expect(assertForkRelayDeploymentEnv(validPlanetscaleEnv())).toMatchObject({
      databaseBackend: "planetscale",
      observabilityBackend: "none",
    });
  });

  it("fails closed when neither external Postgres nor PlanetScale is configured", () => {
    expect(() =>
      assertForkRelayDeploymentEnv(validPlanetscaleEnv({ PLANETSCALE_ORGANIZATION: undefined })),
    ).toThrow("Configure either external Postgres (RELAY_DB_HOST) or PlanetScale");
  });

  it("fails closed on empty env, malformed account IDs, half-set Access creds, or unsafe OTLP URLs", () => {
    expect(() => assertForkRelayDeploymentEnv({})).toThrow("CLOUDFLARE_ACCOUNT_ID");
    for (const badAccount of ["", "not-hex", "1234", "g".repeat(32)]) {
      expect(() =>
        assertForkRelayDeploymentEnv(validExternalEnv({ CLOUDFLARE_ACCOUNT_ID: badAccount })),
      ).toThrow("CLOUDFLARE_ACCOUNT_ID");
    }
    expect(() => assertForkRelayDeploymentEnv(validExternalEnv({ RELAY_DB_PASSWORD: "" }))).toThrow(
      "RELAY_DB_PASSWORD",
    );
    expect(() =>
      assertForkRelayDeploymentEnv(validExternalEnv({ RELAY_DB_ACCESS_CLIENT_SECRET: "" })),
    ).toThrow("RELAY_DB_ACCESS_CLIENT_ID and RELAY_DB_ACCESS_CLIENT_SECRET");
    expect(() =>
      assertForkRelayDeploymentEnv(validExternalEnv({ RELAY_DB_ACCESS_CLIENT_ID: "" })),
    ).toThrow("RELAY_DB_ACCESS_CLIENT_ID and RELAY_DB_ACCESS_CLIENT_SECRET");
    expect(() =>
      assertForkRelayDeploymentEnv(
        validExternalEnv({
          RELAY_OTLP_TRACES_URL: "https://user:pass@traces.s2code.dev/v1/traces",
        }),
      ),
    ).toThrow("embedded credentials");
    expect(() =>
      assertForkRelayDeploymentEnv(
        validExternalEnv({ RELAY_OTLP_TRACES_URL: "https://traces.example.com/v1/traces" }),
      ),
    ).toThrow("RELAY_OTLP_TRACES_URL");
  });

  it.each(UPSTREAM_HOSTED_DOMAINS)(
    "rejects upstream domain %s across relay zones, domain override, external DB host, and Clerk key",
    (root) => {
      for (const host of [root, `relay.${root}`]) {
        expect(() =>
          assertForkRelayDeploymentEnv(validExternalEnv({ RELAY_API_ZONE_NAME: host })),
        ).toThrow("RELAY_API_ZONE_NAME");
        expect(() =>
          assertForkRelayDeploymentEnv(validExternalEnv({ RELAY_TUNNEL_ZONE_NAME: host })),
        ).toThrow("RELAY_TUNNEL_ZONE_NAME");
        expect(() =>
          assertForkRelayDeploymentEnv(validExternalEnv({ RELAY_DOMAIN: host })),
        ).toThrow("RELAY_DOMAIN");
        expect(() =>
          assertForkRelayDeploymentEnv(validExternalEnv({ RELAY_DB_HOST: host })),
        ).toThrow("RELAY_DB_HOST");
        expect(() =>
          assertForkRelayDeploymentEnv(
            validExternalEnv({ CLERK_PUBLISHABLE_KEY: `pk_live_${btoa(`clerk.${host}$`)}` }),
          ),
        ).toThrow("CLERK_PUBLISHABLE_KEY");
      }
    },
  );

  it.each([
    "example.com",
    "relay.example.com",
    "tunnels.example.net",
    "relay.example.org",
    "relay.example",
    "relay.invalid",
    "relay.test",
  ])("rejects placeholder host %s", (host) => {
    expect(() =>
      assertForkRelayDeploymentEnv(validExternalEnv({ RELAY_API_ZONE_NAME: host })),
    ).toThrow("RELAY_API_ZONE_NAME");
    expect(() =>
      assertForkRelayDeploymentEnv(validExternalEnv({ RELAY_TUNNEL_ZONE_NAME: host })),
    ).toThrow("RELAY_TUNNEL_ZONE_NAME");
    expect(() => assertForkRelayDeploymentEnv(validExternalEnv({ RELAY_DOMAIN: host }))).toThrow(
      "RELAY_DOMAIN",
    );
    expect(() => assertForkRelayDeploymentEnv(validExternalEnv({ RELAY_DB_HOST: host }))).toThrow(
      "RELAY_DB_HOST",
    );
    expect(() =>
      assertForkRelayDeploymentEnv(
        validExternalEnv({ CLERK_PUBLISHABLE_KEY: `pk_test_${btoa(`clerk.${host}$`)}` }),
      ),
    ).toThrow("CLERK_PUBLISHABLE_KEY");
  });

  it.effect(
    "resolves forkRelayDeploymentConfig through Effect ConfigProvider (for local .env)",
    () =>
      Effect.gen(function* () {
        const env = Object.fromEntries(
          Object.entries(validExternalEnv()).filter(([, value]) => value !== undefined),
        ) as Record<string, string>;
        const resolved = yield* forkRelayDeploymentConfig.pipe(
          Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))),
        );
        assert.equal(resolved.cloudflareAccountId, VALID_ACCOUNT_ID);
        assert.equal(resolved.databaseBackend, "external");

        const empty = yield* forkRelayDeploymentConfig.pipe(
          Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} }))),
          Effect.result,
        );
        assert.isTrue(Result.isFailure(empty));
      }),
  );

  it("validates FEEDBACK_GITHUB_REPO with fork default and rejects upstream or malformed slugs", () => {
    expect(assertForkFeedbackGithubRepo(undefined)).toBe("shuv1337/s2code");
    expect(assertForkFeedbackGithubRepo("   ")).toBe("shuv1337/s2code");
    expect(assertForkFeedbackGithubRepo("shuv1337/s2code")).toBe("shuv1337/s2code");
    expect(assertForkFeedbackGithubRepo("my-org/my.repo_1")).toBe("my-org/my.repo_1");
    for (const bad of [
      "pingdotgg/t3code",
      "PINGDOTGG/t3code",
      "t3tools/t3code",
      "t3-oss/t3code",
      "example/repo",
      "test/repo",
      "invalid/repo",
      "not-a-slug",
      "owner/.",
      "owner/..",
      "owner/repo/extra",
      "https://github.com/shuv1337/s2code",
    ]) {
      expect(() => assertForkFeedbackGithubRepo(bad)).toThrow("FEEDBACK_GITHUB_REPO");
      expect(() =>
        assertForkRelayDeploymentEnv(validExternalEnv({ FEEDBACK_GITHUB_REPO: bad })),
      ).toThrow("FEEDBACK_GITHUB_REPO");
    }
  });

  it("pins Cloudflare.state through Effect Config rather than top-level process.env", () => {
    const source = NodeFS.readFileSync(new URL("../alchemy.run.ts", import.meta.url), "utf8");
    expect(source).not.toContain("process.env");
    expect(source).toContain("forkRelayDeploymentConfig");
    expect(source).toContain("Cloudflare.state({ accountId: forkRelayEnv.cloudflareAccountId })");
    expect(source).toContain("cloudMintPublicKey: cloudMintKeyPair.publicKey");
    expect(source).not.toContain("mobileTracing");
    expect(source).not.toContain("clientTracing");
  });
});

describe("hosted workflow guards", () => {
  const readWorkflow = (name: string) =>
    NodeFS.readFileSync(new URL(`../../../.github/workflows/${name}`, import.meta.url), "utf8");

  it("enforces deploy-relay.yml repo/main guard, preflight-before-migrations order, env-only Access tokens, and token-free summary", () => {
    const deploy = readWorkflow("deploy-relay.yml");
    expect(deploy).toContain("github.repository == 'shuv1337/s2code'");
    expect(deploy).toContain("github.ref == 'refs/heads/main'");
    expect(deploy).toContain(
      "(github.event_name == 'workflow_dispatch' || vars.RELAY_API_ZONE_NAME != '')",
    );
    expect(deploy).toContain("runs-on: ubuntu-24.04");
    expect(deploy).toContain("name: production");
    expect(deploy).toContain("cancel-in-progress: false");
    expect(deploy).not.toMatch(/APNS_PRIVATE_KEY|FCM_SERVICE_ACCOUNT|T3CHAT_LINK_SECRET/);

    const preflightIndex = deploy.indexOf("- name: Verify fork relay ownership configuration");
    const migrateIndex = deploy.indexOf("- name: Run external Postgres migrations");
    const deployIndex = deploy.indexOf("- name: Deploy production relay stage");
    expect(preflightIndex).toBeGreaterThan(-1);
    expect(migrateIndex).toBeGreaterThan(preflightIndex);
    expect(deployIndex).toBeGreaterThan(migrateIndex);

    const migrateStep = deploy.slice(migrateIndex, deployIndex);
    expect(migrateStep).toContain("if: env.RELAY_DB_HOST != ''");
    expect(migrateStep).toContain("TUNNEL_SERVICE_TOKEN_ID:");
    expect(migrateStep).toContain("TUNNEL_SERVICE_TOKEN_SECRET:");
    expect(migrateStep).not.toMatch(/--service-token-id|--service-token-secret/);
    expect(migrateStep).toContain("${RELAY_DB_MIGRATION_SSLMODE:-disable}");
    expect(migrateStep).toContain("vp run --filter t3code-relay migrate:postgres");

    const summaryStep = deploy.split("- name: Publish public relay outputs to summary")[1]!;
    expect(summaryStep).toContain("relay-client-config.env");
    expect(summaryStep).not.toContain("npx");
    expect(summaryStep).not.toMatch(
      /CLOUDFLARE_API_TOKEN|Token|token|Credentials|credentials|PASSWORD|FEEDBACK_GITHUB_TOKEN/,
    );

    const deployStep = deploy.slice(
      deployIndex,
      deploy.indexOf("- name: Publish relay deploy commit status"),
    );
    expect(deployStep).toContain("FEEDBACK_GITHUB_TOKEN: ${{ secrets.FEEDBACK_GITHUB_TOKEN }}");
    expect(deploy.slice(0, deployIndex)).not.toContain("FEEDBACK_GITHUB_TOKEN");
    expect(deploy).toContain("FEEDBACK_GITHUB_REPO: ${{ vars.FEEDBACK_GITHUB_REPO }}");
    expect(deploy).toContain(
      "FEEDBACK_GITHUB_AUTO_ISSUES: ${{ vars.FEEDBACK_GITHUB_AUTO_ISSUES || 'false' }}",
    );
  });

  it("gates every job in relay-preview.yml and relay-preview-cleanup.yml behind RELAY_PREVIEWS_ENABLED", () => {
    const preview = readWorkflow("relay-preview.yml");
    expect(preview).toContain("github.repository == 'shuv1337/s2code'");
    expect(preview).toContain("vars.RELAY_PREVIEWS_ENABLED == 'true'");

    const cleanup = readWorkflow("relay-preview-cleanup.yml");
    const jobsSection = cleanup.split("\njobs:\n")[1]!;
    const jobBlocks = jobsSection.split(/\n  (?=[a-z_]+:\n)/u);
    expect(jobBlocks).toHaveLength(3);
    for (const block of jobBlocks) {
      expect(block).toContain("github.repository == 'shuv1337/s2code'");
      expect(block).toContain("vars.RELAY_PREVIEWS_ENABLED == 'true'");
    }
  });

  it("keeps web-preview.yml notice-only without secrets or executable deployment steps", () => {
    const webPreview = readWorkflow("web-preview.yml");
    expect(webPreview).toContain("::notice::");
    expect(webPreview).toContain("GITHUB_STEP_SUMMARY");
    expect(webPreview).not.toMatch(
      /secrets:|secrets\.|uses:|id-token:|environment:|hosted-preflight|FORK_HOSTED_DEPLOYMENT_VERIFIED/,
    );
    const lines = webPreview.split("run: |\n")[1]!.trim().split("\n");
    expect(lines).toHaveLength(2);
    for (const line of lines) expect(line.trim()).toMatch(/^echo '/);
  });
});
