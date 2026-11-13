import {
  type McpServerConfig,
  type McpServerId,
  type McpServerTestResult,
  type ProjectId,
  type ServerSettings,
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
import { SECRET_REDACTED } from "../settingsSecrets.ts";
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
      "not_bound_to_caller",
      "secret_required",
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
      case "not_bound_to_caller":
        return "This server is limited to other projects or to top-level threads, so this thread cannot change, remove, or test it.";
      case "secret_required":
        return "This server has a saved token. Changing its url, projectIds, or excludeSubagents needs a new bearerTokenSecretRef, or clearBearerToken: true, in the same call.";
      case "secret_unavailable":
        return "The secret ref is unavailable, expired, already used, or belongs to another host or project.";
      case "settings_failed":
        return "Could not update shared MCP server settings. If a secret ref was passed, it was used; request a new one.";
    }
  }
}

/** The calling thread's audience, or undefined for an owner client outside any thread. */
export type SharedMcpServerCaller = SharedMcpServers.SharedMcpServerAudience | undefined;

export class SharedMcpServerManagement extends Context.Service<
  SharedMcpServerManagement,
  {
    readonly list: (
      caller: SharedMcpServerCaller,
    ) => Effect.Effect<ReadonlyArray<SharedMcpServerSummary>, SharedMcpServerManagementError>;
    readonly set: (
      input: SharedMcpServerSetInput,
      caller: SharedMcpServerCaller,
    ) => Effect.Effect<SharedMcpServerSummary, SharedMcpServerManagementError>;
    readonly remove: (
      id: McpServerId,
      caller: SharedMcpServerCaller,
    ) => Effect.Effect<void, SharedMcpServerManagementError>;
    readonly test: (
      id: McpServerId,
      caller: SharedMcpServerCaller,
    ) => Effect.Effect<McpServerTestResult, SharedMcpServerManagementError>;
  }
>()("t3/mcp/SharedMcpServerManagement") {}

const redactedSummary = (id: McpServerId, server: McpServerConfig): SharedMcpServerSummary => ({
  id,
  ...(server.label === undefined ? {} : { label: server.label }),
  enabled: server.enabled,
  ...(server.projectIds === undefined ? {} : { projectIds: server.projectIds }),
  ...(server.excludeSubagents === undefined ? {} : { excludeSubagents: server.excludeSubagents }),
});

const summary = (id: McpServerId, server: McpServerConfig): SharedMcpServerSummary => ({
  ...redactedSummary(id, server),
  url: server.url,
  hasToken: server.bearerToken.length > 0,
  harnessName: sharedMcpServerHarnessName(id),
});

const sameProjects = (
  left: ReadonlyArray<ProjectId> | undefined,
  right: ReadonlyArray<ProjectId> | undefined,
) => {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  return leftSet.size === rightSet.size && [...leftSet].every((id) => rightSet.has(id));
};

const isManagementError = Schema.is(SharedMcpServerManagementError);

const decodeSetInput = Schema.decodeUnknownEffect(SharedMcpServerSetInput, {
  onExcessProperty: "error",
});

const make = Effect.gen(function* () {
  const settings = yield* Settings.ServerSettingsService;
  const secrets = yield* SecretRequests.SecretRequests;
  const servers = yield* SharedMcpServers.SharedMcpServers;
  const settingsFailed = (cause: unknown) =>
    isManagementError(cause)
      ? cause
      : new SharedMcpServerManagementError({ reason: "settings_failed", cause });
  const current = settings.getSettings.pipe(Effect.mapError(settingsFailed));
  const admitted = (server: McpServerConfig, caller: SharedMcpServerCaller) =>
    caller === undefined || SharedMcpServers.sharedMcpServerAdmits(server, caller);
  const find = (configured: ServerSettings["mcpServers"], id: McpServerId) =>
    Object.hasOwn(configured, id) ? configured[id] : undefined;
  /** The saved server, refused when its binding excludes the caller. */
  const reachable = (
    configured: ServerSettings["mcpServers"],
    id: McpServerId,
    caller: SharedMcpServerCaller,
  ) => {
    const saved = find(configured, id);
    return saved !== undefined && !admitted(saved, caller)
      ? Effect.fail(new SharedMcpServerManagementError({ reason: "not_bound_to_caller" }))
      : Effect.succeed(saved);
  };

  const list = Effect.fn("SharedMcpServerManagement.list")(function* (
    caller: SharedMcpServerCaller,
  ) {
    const { mcpServers } = yield* current;
    return Object.entries(mcpServers).map(([id, server]) =>
      admitted(server, caller)
        ? summary(id as McpServerId, server)
        : redactedSummary(id as McpServerId, server),
    );
  });
  const set = Effect.fn("SharedMcpServerManagement.set")(function* (
    input: SharedMcpServerSetInput,
    caller: SharedMcpServerCaller,
  ) {
    const validated = yield* decodeSetInput(input).pipe(
      Effect.mapError(() => new SharedMcpServerManagementError({ reason: "invalid" })),
    );
    if (validated.bearerTokenSecretRef !== undefined && validated.clearBearerToken === true)
      return yield* new SharedMcpServerManagementError({ reason: "token_conflict" });
    const resolve = Effect.fnUntraced(function* (configured: ServerSettings["mcpServers"]) {
      const saved = yield* reachable(configured, validated.id, caller);
      const url = validated.url ?? saved?.url;
      if (url === undefined)
        return yield* new SharedMcpServerManagementError({ reason: "url_required" });
      const projectIds = validated.projectIds ?? saved?.projectIds;
      const excludeSubagents = validated.excludeSubagents ?? saved?.excludeSubagents;
      // Repointing or rebinding a tokened server hands its token to a new audience, so the caller re-supplies it.
      if (
        saved !== undefined &&
        saved.bearerToken.length > 0 &&
        validated.bearerTokenSecretRef === undefined &&
        validated.clearBearerToken !== true &&
        (url !== saved.url ||
          !sameProjects(projectIds, saved.projectIds) ||
          (excludeSubagents ?? false) !== (saved.excludeSubagents ?? false))
      )
        return yield* new SharedMcpServerManagementError({ reason: "secret_required" });
      return { saved, url, projectIds, excludeSubagents };
    });
    // Refuse before spending a ref; the write re-checks against what it replaces.
    yield* resolve((yield* current).mcpServers);
    const projectId = validated.projectId ?? caller?.projectId;
    if (validated.bearerTokenSecretRef !== undefined && projectId === undefined)
      return yield* new SharedMcpServerManagementError({ reason: "project_required" });
    const suppliedToken =
      validated.bearerTokenSecretRef === undefined
        ? undefined
        : yield* secrets
            .consume({ ref: validated.bearerTokenSecretRef, projectId: projectId! })
            .pipe(
              Effect.mapError(
                (cause) =>
                  new SharedMcpServerManagementError({ reason: "secret_unavailable", cause }),
              ),
            );
    const updated = yield* settings
      .modifySettings((now) =>
        resolve(now.mcpServers).pipe(
          Effect.map(({ saved, url, projectIds, excludeSubagents }) => {
            const label =
              validated.label === undefined ? saved?.label : (validated.label ?? undefined);
            const bearerToken =
              validated.clearBearerToken === true
                ? ""
                : (suppliedToken ??
                  (saved !== undefined && saved.bearerToken.length > 0 ? SECRET_REDACTED : ""));
            return {
              mcpServers: {
                [validated.id]: {
                  ...(label === undefined ? {} : { label }),
                  url,
                  enabled: validated.enabled ?? saved?.enabled ?? true,
                  bearerToken,
                  ...(projectIds === undefined ? {} : { projectIds }),
                  ...(excludeSubagents === undefined ? {} : { excludeSubagents }),
                },
              },
            };
          }),
        ),
      )
      .pipe(Effect.mapError(settingsFailed));
    return summary(validated.id, updated.mcpServers[validated.id]!);
  });
  const remove = Effect.fn("SharedMcpServerManagement.remove")(function* (
    id: McpServerId,
    caller: SharedMcpServerCaller,
  ) {
    yield* settings
      .modifySettings((now) =>
        Effect.gen(function* () {
          if ((yield* reachable(now.mcpServers, id, caller)) === undefined)
            return yield* new SharedMcpServerManagementError({ reason: "not_found" });
          return { mcpServers: { [id]: null } };
        }),
      )
      .pipe(Effect.mapError(settingsFailed));
  });
  const test = Effect.fn("SharedMcpServerManagement.test")(function* (
    id: McpServerId,
    caller: SharedMcpServerCaller,
  ) {
    const saved = yield* reachable((yield* current).mcpServers, id, caller);
    if (saved === undefined)
      return yield* new SharedMcpServerManagementError({ reason: "not_found" });
    return yield* servers.test({ id, url: saved.url });
  });
  return SharedMcpServerManagement.of({ list, set, remove, test });
});
export const layer = Layer.effect(SharedMcpServerManagement, make);
