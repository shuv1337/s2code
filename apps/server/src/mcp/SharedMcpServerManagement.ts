import {
  type McpServerConfig,
  type McpServerId,
  type McpServerTestResult,
  type ProjectId,
  SharedMcpServerSetInput,
  type SharedMcpServerSummary,
  sharedMcpServerHarnessName,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as Settings from "../serverSettings.ts";
import * as SharedMcpServers from "./SharedMcpServers.ts";

export class SharedMcpServerManagementError extends Schema.TaggedError<SharedMcpServerManagementError>()(
  "SharedMcpServerManagementError",
  {
    reason: Schema.Literals([
      "invalid",
      "not_found",
      "url_required",
      "token_conflict",
      "project_required",
      "secret_unavailable",
      "settings_failed",
    ]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message() {
    switch (this.reason) {
      case "invalid":
        return "Invalid shared MCP server configuration.";
      case "not_found":
        return "Shared MCP server not found.";
      case "url_required":
        return "A new shared MCP server needs a URL.";
      case "token_conflict":
        return "Use bearerTokenSecretRef or clearBearerToken, not both.";
      case "project_required":
        return "Pass the destination secret ref's projectId outside a thread. Refs are host-local.";
      case "secret_unavailable":
        return "The secret ref is unavailable, expired, already used, or belongs to another host or project.";
      case "settings_failed":
        return "Could not update shared MCP server settings. If a secret ref was passed, it was used; request a new one.";
    }
  }
}

export class SharedMcpServerManagement extends Context.Service<
  SharedMcpServerManagement,
  {
    readonly list: Effect.Effect<
      ReadonlyArray<SharedMcpServerSummary>,
      SharedMcpServerManagementError
    >;
    readonly set: (
      input: SharedMcpServerSetInput,
      callerProjectId?: ProjectId,
    ) => Effect.Effect<SharedMcpServerSummary, SharedMcpServerManagementError>;
    readonly remove: (id: McpServerId) => Effect.Effect<void, SharedMcpServerManagementError>;
    readonly test: (
      id: McpServerId,
    ) => Effect.Effect<McpServerTestResult, SharedMcpServerManagementError>;
  }
>()("t3/mcp/SharedMcpServerManagement") {}

const summary = (id: McpServerId, server: McpServerConfig): SharedMcpServerSummary => ({
  id,
  ...(server.label === undefined ? {} : { label: server.label }),
  url: server.url,
  enabled: server.enabled,
  hasToken: server.bearerToken.length > 0,
  harnessName: sharedMcpServerHarnessName(id),
});

const decodeSetInput = Schema.decodeUnknownEffect(SharedMcpServerSetInput, {
  onExcessProperty: "error",
});

const make = Effect.gen(function* () {
  const settings = yield* Settings.ServerSettingsService;
  const secrets = yield* SecretRequests.SecretRequests;
  const servers = yield* SharedMcpServers.SharedMcpServers;
  const current = settings.getSettings.pipe(
    Effect.mapError(
      (cause) => new SharedMcpServerManagementError({ reason: "settings_failed", cause }),
    ),
  );
  const list = current.pipe(
    Effect.map((value) =>
      Object.entries(value.mcpServers).map(([id, server]) => summary(id as McpServerId, server)),
    ),
  );
  const set = Effect.fn("SharedMcpServerManagement.set")(function* (
    input: SharedMcpServerSetInput,
    callerProjectId?: ProjectId,
  ) {
    const validated = yield* decodeSetInput(input).pipe(
      Effect.mapError(() => new SharedMcpServerManagementError({ reason: "invalid" })),
    );
    if (validated.bearerTokenSecretRef !== undefined && validated.clearBearerToken === true)
      return yield* new SharedMcpServerManagementError({ reason: "token_conflict" });
    const configured = (yield* current).mcpServers;
    const saved = Object.hasOwn(configured, validated.id) ? configured[validated.id] : undefined;
    const url = validated.url ?? saved?.url;
    if (url === undefined)
      return yield* new SharedMcpServerManagementError({ reason: "url_required" });
    const projectId = validated.projectId ?? callerProjectId;
    if (validated.bearerTokenSecretRef !== undefined && projectId === undefined)
      return yield* new SharedMcpServerManagementError({ reason: "project_required" });
    const bearerToken =
      validated.clearBearerToken === true
        ? ""
        : validated.bearerTokenSecretRef === undefined
          ? saved?.url === url
            ? saved.bearerToken
            : ""
          : yield* secrets
              .consume({ ref: validated.bearerTokenSecretRef, projectId: projectId! })
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new SharedMcpServerManagementError({ reason: "secret_unavailable", cause }),
                ),
              );
    const updated = yield* settings
      .updateSettings({
        mcpServers: {
          [validated.id]: {
            ...(saved?.label === undefined ? {} : { label: saved.label }),
            ...(validated.label === undefined ? {} : { label: validated.label }),
            url,
            enabled: validated.enabled ?? saved?.enabled ?? true,
            bearerToken,
          },
        },
      })
      .pipe(
        Effect.mapError(
          (cause) => new SharedMcpServerManagementError({ reason: "settings_failed", cause }),
        ),
      );
    return summary(validated.id, updated.mcpServers[validated.id]!);
  });
  const remove = Effect.fn("SharedMcpServerManagement.remove")(function* (id: McpServerId) {
    yield* settings
      .updateSettings({ mcpServers: { [id]: null } })
      .pipe(
        Effect.mapError(
          (cause) => new SharedMcpServerManagementError({ reason: "settings_failed", cause }),
        ),
      );
  });
  const test = Effect.fn("SharedMcpServerManagement.test")(function* (id: McpServerId) {
    const configured = (yield* current).mcpServers;
    const saved = Object.hasOwn(configured, id) ? configured[id] : undefined;
    if (saved === undefined)
      return yield* new SharedMcpServerManagementError({ reason: "not_found" });
    return yield* servers.test({ id, url: saved.url });
  });
  return SharedMcpServerManagement.of({ list, set, remove, test });
});
export const layer = Layer.effect(SharedMcpServerManagement, make);
