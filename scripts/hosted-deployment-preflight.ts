// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalFetch:off -- Dependency-free read-only CI boundary before installation. No deployment tools or mutations.
import * as NodeFS from "node:fs";
import {
  hostedDeploymentConfiguration,
  verifyHostedDeploymentIdentities,
  RELAY_DEPLOYMENT_UNAVAILABLE_MESSAGE,
} from "./hosted-deployment-config.ts";

const env = process.env;
const output = (allowed: boolean) => {
  if (env.GITHUB_OUTPUT) NodeFS.appendFileSync(env.GITHUB_OUTPUT, `allowed=${allowed}\n`);
};
try {
  if (process.argv[2] === "relay") throw new Error(RELAY_DEPLOYMENT_UNAVAILABLE_MESSAGE);
  hostedDeploymentConfiguration(env);
  const requiredSecrets = ["CLERK_SECRET_KEY", "VERCEL_TOKEN"];
  for (const name of requiredSecrets)
    if (!env[name]) throw new Error(`Hosted identity verification requires ${name}.`);
} catch (error) {
  output(false);
  const message = error instanceof Error ? error.message : "Hosted configuration is invalid.";
  console.log(`::notice::Hosted deployment skipped: ${message}`);
  if (env.GITHUB_STEP_SUMMARY)
    NodeFS.appendFileSync(
      env.GITHUB_STEP_SUMMARY,
      `Hosted deployment skipped: ${message} Local/direct/Tailscale and CLI/desktop releases are unaffected.\n`,
    );
  process.exit(0);
}
try {
  const target = process.argv[2];
  if (target !== "web" && target !== "relay")
    throw new Error("Choose web or relay identity verification.");
  await verifyHostedDeploymentIdentities(env, target, async (url, authorization) => {
    const response = await fetch(url, {
      headers: { authorization },
      signal: AbortSignal.timeout(20_000),
      redirect: "error",
    });
    if (!response.ok)
      throw new Error("Hosted destination identity lookup failed; no deployment attempted.");
    return response.json();
  });
  output(true);
  console.log("Fork hosted destination identities verified; deployment may proceed.");
} catch {
  output(false);
  console.error("Hosted destination identity verification failed; no deployment attempted.");
  process.exitCode = 1;
}
