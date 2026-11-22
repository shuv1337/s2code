// @effect-diagnostics nodeBuiltinImport:off -- Offline guard checks inspect source and workflows without provisioning providers.
import * as NodeFS from "node:fs";
import { UPSTREAM_HOSTED_DOMAINS } from "@t3tools/shared/hostedConfig";
import { describe, expect, it } from "vite-plus/test";

import { assertForkRelayDeploymentEnv } from "./forkOwnership.ts";

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
      observabilityBackend: "axiom",
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

  it("fails closed on empty env, malformed account IDs, or half-set external DB credentials", () => {
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

  it("runs before Alchemy.Stack and pins Cloudflare.state to the validated accountId", () => {
    const source = NodeFS.readFileSync(new URL("../alchemy.run.ts", import.meta.url), "utf8");
    const preflightIndex = source.indexOf("assertForkRelayDeploymentEnv(process.env)");
    const stackIndex = source.indexOf("Alchemy.Stack(");
    expect(preflightIndex).toBeGreaterThan(-1);
    expect(stackIndex).toBeGreaterThan(preflightIndex);
    expect(source).toContain("Cloudflare.state({ accountId: forkRelayEnv.cloudflareAccountId })");
    expect(source).toContain("cloudMintPublicKey: cloudMintKeyPair.publicKey");
  });
});

describe("hosted workflow guards", () => {
  const readWorkflow = (name: string) =>
    NodeFS.readFileSync(new URL(`../../../.github/workflows/${name}`, import.meta.url), "utf8");

  it("restricts deploy-relay.yml to shuv1337/s2code main, supports external Postgres migrations, and omits push/T3Chat secrets", () => {
    const deploy = readWorkflow("deploy-relay.yml");
    expect(deploy).toContain("github.repository == 'shuv1337/s2code'");
    expect(deploy).toContain("github.ref == 'refs/heads/main'");
    expect(deploy).toContain(
      "(github.event_name == 'workflow_dispatch' || vars.RELAY_API_ZONE_NAME != '')",
    );
    expect(deploy).toContain("runs-on: ubuntu-24.04");
    expect(deploy).toContain("name: production");
    expect(deploy).toContain("cancel-in-progress: false");
    expect(deploy).toContain("APNS_ENABLED: ${{ vars.APNS_ENABLED || 'false' }}");
    expect(deploy).toContain("RELAY_DB_HOST: ${{ vars.RELAY_DB_HOST }}");
    expect(deploy).toContain("RELAY_DB_CLUSTER_SIZE: ${{ vars.RELAY_DB_CLUSTER_SIZE }}");
    expect(deploy).toContain("RELAY_DB_REPLICAS: ${{ vars.RELAY_DB_REPLICAS }}");
    expect(deploy).toContain("RELAY_OTLP_TRACES_URL: ${{ vars.RELAY_OTLP_TRACES_URL }}");
    expect(deploy).toContain("RELAY_DB_PASSWORD: ${{ secrets.RELAY_DB_PASSWORD }}");
    expect(deploy).toContain("RELAY_DB_ACCESS_CLIENT_ID: ${{ secrets.RELAY_DB_ACCESS_CLIENT_ID }}");
    expect(deploy).toContain(
      "RELAY_DB_ACCESS_CLIENT_SECRET: ${{ secrets.RELAY_DB_ACCESS_CLIENT_SECRET }}",
    );
    expect(deploy).toContain("RELAY_OTLP_TRACES_TOKEN: ${{ secrets.RELAY_OTLP_TRACES_TOKEN }}");
    expect(deploy).not.toMatch(/APNS_PRIVATE_KEY|FCM_SERVICE_ACCOUNT|T3CHAT_LINK_SECRET/);

    const migrateIndex = deploy.indexOf("- name: Run external Postgres migrations");
    const deployIndex = deploy.indexOf("- name: Deploy production relay stage");
    expect(migrateIndex).toBeGreaterThan(-1);
    expect(deployIndex).toBeGreaterThan(migrateIndex);
    const migrateStep = deploy.slice(migrateIndex, deployIndex);
    expect(migrateStep).toContain("if: env.RELAY_DB_HOST != ''");
    expect(migrateStep).toContain("access tcp");
    expect(migrateStep).toContain("vp run --filter t3code-relay migrate:postgres");

    const summaryStep = deploy.split("- name: Publish public relay outputs to summary")[1]!;
    expect(summaryStep).toContain(".url");
    expect(summaryStep).toContain(".cloudMintPublicKey");
    expect(summaryStep).not.toMatch(/Token|token|Credentials|credentials|PASSWORD/);
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
