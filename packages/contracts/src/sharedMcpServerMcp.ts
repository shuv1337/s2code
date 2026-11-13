import * as Schema from "effect/Schema";
import { ProjectId, SecretRef, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { OrchestratorMcpEnvironmentTarget } from "./orchestratorMcp.ts";
import { McpServerConfig, McpServerId } from "./settings.ts";

const target = { environmentId: OrchestratorMcpEnvironmentTarget };
export const SharedMcpServerListInput = Schema.Struct(target);
export const SharedMcpServerIdInput = Schema.Struct({ ...target, id: McpServerId });
export const SharedMcpServerSetInput = Schema.Struct({
  ...target,
  id: McpServerId,
  url: Schema.optionalKey(
    McpServerConfig.fields.url.check(
      Schema.makeFilter(
        (value) => {
          if (!URL.canParse(value)) return false;
          const url = new URL(value);
          return url.hostname.length > 0 && url.username === "" && url.password === "";
        },
        { expected: "an HTTP(S) URL without embedded credentials" },
      ),
    ),
  ),
  label: Schema.optionalKey(Schema.NullOr(TrimmedNonEmptyString)),
  enabled: Schema.optionalKey(Schema.Boolean),
  projectIds: McpServerConfig.fields.projectIds,
  excludeSubagents: McpServerConfig.fields.excludeSubagents,
  bearerTokenSecretRef: Schema.optionalKey(SecretRef),
  clearBearerToken: Schema.optionalKey(Schema.Boolean),
  projectId: Schema.optionalKey(ProjectId),
});
export type SharedMcpServerSetInput = typeof SharedMcpServerSetInput.Type;

/** `url`, `hasToken`, and `harnessName` are omitted for a server whose binding excludes the caller. */
export const SharedMcpServerSummary = Schema.Struct({
  id: McpServerId,
  label: McpServerConfig.fields.label,
  url: Schema.optionalKey(Schema.String),
  enabled: Schema.Boolean,
  projectIds: McpServerConfig.fields.projectIds,
  excludeSubagents: McpServerConfig.fields.excludeSubagents,
  hasToken: Schema.optionalKey(Schema.Boolean),
  harnessName: Schema.optionalKey(Schema.String),
});
export type SharedMcpServerSummary = typeof SharedMcpServerSummary.Type;

export const SHARED_MCP_SESSION_NOTICE =
  "Added or re-enabled servers reach new sessions only; other changes apply immediately.";
export const SharedMcpServerListResult = Schema.Struct({
  servers: Schema.Array(SharedMcpServerSummary),
  sessionNotice: Schema.String,
});
export const SharedMcpServerSetResult = Schema.Struct({
  server: SharedMcpServerSummary,
  sessionNotice: Schema.String,
});
export const SharedMcpServerRemoveResult = Schema.Struct({
  id: McpServerId,
  sessionNotice: Schema.String,
});
