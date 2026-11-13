import { OrchestratorMcpFailure, SHARED_MCP_SESSION_NOTICE } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as ThreadCommandExecutor from "../../../orchestration-v2/ThreadCommandExecutor.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as Management from "../../SharedMcpServerManagement.ts";
import * as SharedMcpServers from "../../SharedMcpServers.ts";
import { type Caller } from "../../threadAccess.ts";
import { SharedMcpServersToolkit } from "./tools.ts";

const failure = (error: Management.SharedMcpServerManagementError) =>
  new OrchestratorMcpFailure({
    code: error.reason === "settings_failed" ? "orchestration_error" : "invalid_request",
    message: error.message,
  });

const audience = ({ caller, scope }: Caller): Management.SharedMcpServerCaller =>
  caller === undefined
    ? undefined
    : SharedMcpServers.sharedMcpServerAudience(caller, scope.thread?.subagent === true);

const locked = Effect.fn("SharedMcpServersToolkit.locked")(function* <A, E, R, R2>(
  check: Effect.Effect<Caller, OrchestratorMcpFailure, R>,
  use: (caller: Caller) => Effect.Effect<A, E, R2>,
) {
  const caller = yield* check;
  const executor = yield* ThreadCommandExecutor.ThreadCommandExecutor;
  const operation = check.pipe(Effect.flatMap(use));
  return yield* caller.scope.thread === undefined
    ? operation
    : executor.withLock(caller.scope.thread.threadId, operation);
});

export const layer = McpToolAccess.toLayer(SharedMcpServersToolkit, {
  t3_mcp_server_list: McpToolAccess.writesEnvironment((_input, check) =>
    Effect.gen(function* () {
      const caller = yield* check;
      const service = yield* Management.SharedMcpServerManagement;
      return {
        servers: yield* service.list(audience(caller)).pipe(Effect.mapError(failure)),
        sessionNotice: SHARED_MCP_SESSION_NOTICE,
      };
    }),
  ),
  t3_mcp_server_set: McpToolAccess.writesEnvironment((input, check) =>
    locked(check, (caller) =>
      Effect.gen(function* () {
        const service = yield* Management.SharedMcpServerManagement;
        return {
          server: yield* service.set(input, audience(caller)).pipe(Effect.mapError(failure)),
          sessionNotice: SHARED_MCP_SESSION_NOTICE,
        };
      }),
    ),
  ),
  t3_mcp_server_remove: McpToolAccess.writesEnvironment(({ id }, check) =>
    locked(check, (caller) =>
      Effect.gen(function* () {
        const service = yield* Management.SharedMcpServerManagement;
        yield* service.remove(id, audience(caller)).pipe(Effect.mapError(failure));
        return { id, sessionNotice: SHARED_MCP_SESSION_NOTICE };
      }),
    ),
  ),
  t3_mcp_server_test: McpToolAccess.writesEnvironment(({ id }, check) =>
    Effect.gen(function* () {
      const caller = yield* check;
      const service = yield* Management.SharedMcpServerManagement;
      return yield* service.test(id, audience(caller)).pipe(Effect.mapError(failure));
    }),
  ),
});
