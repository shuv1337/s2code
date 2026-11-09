import * as Schema from "effect/Schema";
import { ProjectId, SecretRef } from "./baseSchemas.ts";
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
  label: McpServerConfig.fields.label,
  enabled: Schema.optionalKey(Schema.Boolean),
  bearerTokenSecretRef: Schema.optionalKey(SecretRef).annotate({
    description: "request_secret ref on this host; never a token.",
  }),
  clearBearerToken: Schema.optionalKey(Schema.Boolean),
  projectId: Schema.optionalKey(ProjectId).annotate({
    description: "Secret ref's project; defaults to caller's. Required outside a thread.",
  }),
});
export type SharedMcpServerSetInput = typeof SharedMcpServerSetInput.Type;

export const SharedMcpServerSummary = Schema.Struct({
  id: McpServerId,
  label: McpServerConfig.fields.label,
  url: Schema.String,
  enabled: Schema.Boolean,
  hasToken: Schema.Boolean,
  harnessName: Schema.String,
});
export type SharedMcpServerSummary = typeof SharedMcpServerSummary.Type;

export const SHARED_MCP_SESSION_NOTICE =
  "Changes apply to new provider sessions; existing sessions keep their MCP set.";
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
