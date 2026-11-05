import { ProviderInstanceId, type ServerSettingsError } from "@t3tools/contracts";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Argument, Command, GlobalFlag } from "effect/cli";
import * as CliError from "effect/cli/CliError";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import { disableInstanceOnExhaustedQuota } from "../provider/usageLimitAutoDisable.ts";
import * as ServerSettings from "../serverSettings.ts";
import { projectLocationFlags, resolveCliAuthConfig } from "./config.ts";

export const POOL_DEV_FLAG = "S2CODE_DEV_POOL_MARK_SPENT";

const devFlagEnabled = Config.Boolean(POOL_DEV_FLAG).pipe(Config.withDefault(false));

const devSpentFailure = makeProviderFailure({
  class: "usage_limit",
  message: "Marked spent by `s2code pool mark-spent` (dev).",
  code: "usage_limit",
  retryable: false,
});

/** Turns a pool member off as an exhausted quota would; false when it is not an enabled member. */
export const markInstanceSpent = (instanceId: ProviderInstanceId) =>
  disableInstanceOnExhaustedQuota(instanceId, devSpentFailure);

/** Turns a spent instance back on; saving it enabled clears its quota note. */
export const restoreSpentInstance = (instanceId: ProviderInstanceId) =>
  ServerSettings.ServerSettingsService.use((settings) =>
    settings.modifyProviderInstance(instanceId, (current) =>
      current?.usageLimitDisabled == null ? undefined : { ...current, enabled: true },
    ),
  );

const instanceIdArgument = Argument.String("instanceId").pipe(
  Argument.withDescription("Provider instance id, as in settings.providerInstances."),
);

// Writes settings.json directly; a running server picks the change up through its file watcher.
const makePoolCommand = (
  name: string,
  description: string,
  write: (
    instanceId: ProviderInstanceId,
  ) => Effect.Effect<boolean, ServerSettingsError, ServerSettings.ServerSettingsService>,
  done: (instanceId: string) => string,
  refused: (instanceId: string) => string,
) =>
  Command.make(name, { ...projectLocationFlags, instanceId: instanceIdArgument }).pipe(
    Command.withDescription(description),
    Command.withHandler(
      Effect.fn(`cli.pool.${name}`)(function* (flags) {
        if (!(yield* devFlagEnabled)) {
          return yield* new CliError.UserError({
            cause: POOL_DEV_FLAG,
            userMessage: `\`s2code pool ${name}\` is a dev-only command. Set ${POOL_DEV_FLAG}=1 to use it.`,
          });
        }
        const config = yield* resolveCliAuthConfig(flags, yield* GlobalFlag.LogLevel);
        const changed = yield* write(ProviderInstanceId.make(flags.instanceId)).pipe(
          Effect.provide(
            ServerSettings.layer.pipe(
              Layer.provide(
                Layer.mergeAll(
                  ServerSecretStore.layer,
                  ManagedPolicy.layer,
                  SqlitePersistence.layerConfig,
                ),
              ),
              Layer.provide(ServerConfig.layer(config)),
            ),
          ),
        );
        if (!changed) {
          return yield* new CliError.UserError({
            cause: flags.instanceId,
            userMessage: refused(flags.instanceId),
          });
        }
        yield* Console.log(done(flags.instanceId));
      }),
    ),
  );

export const poolCommand = Command.make("pool").pipe(
  Command.withDescription(`Dev-only usage-limit pool controls. Requires ${POOL_DEV_FLAG}=1.`),
  Command.unlisted,
  Command.withSubcommands([
    makePoolCommand(
      "mark-spent",
      "Turn a pool member off as if its quota ran out.",
      markInstanceSpent,
      (id) => `Marked ${id} spent.`,
      (id) =>
        `${id} was not changed: it must be an enabled instance set to turn off at its usage limit.`,
    ),
    makePoolCommand(
      "restore",
      "Turn a spent pool member back on.",
      restoreSpentInstance,
      (id) => `Restored ${id}.`,
      (id) => `${id} was not changed: it is not marked spent.`,
    ),
  ]),
);
