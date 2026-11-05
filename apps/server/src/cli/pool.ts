import {
  ProviderInstanceConfig,
  ProviderInstanceId,
  type ServerSettingsError,
} from "@t3tools/contracts";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Argument, Command, GlobalFlag } from "effect/cli";
import * as CliError from "effect/cli/CliError";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import {
  disableInstanceOnExhaustedQuota,
  disablesOnExhaustedQuota,
} from "../provider/usageLimitAutoDisable.ts";
import * as ServerSettings from "../serverSettings.ts";
import { projectLocationFlags, resolveCliAuthConfig } from "./config.ts";

// `vp build` defines this false, so release CLIs never register dev commands.
declare const __T3CODE_DEV_COMMANDS__: boolean | undefined;
export const devCommandsBuilt =
  typeof __T3CODE_DEV_COMMANDS__ === "undefined" || __T3CODE_DEV_COMMANDS__;

export const POOL_DEV_FLAG = "T3CODE_DEV_POOL_MARK_SPENT";

const devFlagEnabled = Config.Boolean(POOL_DEV_FLAG).pipe(
  Config.withDefault(false),
  Effect.orElseSucceed(() => false),
);

const devSpentFailure = makeProviderFailure({
  class: "usage_limit",
  message: "Marked spent by `s2code pool mark-spent` (dev).",
  code: "usage_limit",
  retryable: false,
});

/** Turns a pool member off as an exhausted quota would; false when it is not an enabled member. */
export const markInstanceSpent = (instanceId: ProviderInstanceId) =>
  disableInstanceOnExhaustedQuota(instanceId, devSpentFailure);

/**
 * Only a note seen here without an account: re-enabling one an account sync wrote or reports
 * would tell linked environments the quota reset.
 */
const isRestorable = (instance: ProviderInstanceConfig | undefined) => {
  const note = instance?.usageLimitDisabled;
  return note != null && note.account === undefined && note.reportedBy === undefined;
};

/** Turns a spent instance back on; saving it enabled clears its quota note. */
export const restoreSpentInstance = (instanceId: ProviderInstanceId) =>
  ServerSettings.ServerSettingsService.use((settings) =>
    settings.modifyProviderInstance(instanceId, (current) =>
      current !== undefined && isRestorable(current) ? { ...current, enabled: true } : undefined,
    ),
  );

const decodeSavedProviderInstances = Schema.decodeOption(
  Schema.fromJsonString(
    Schema.Struct({
      providerInstances: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
    }),
  ),
);
const decodeProviderInstance = Schema.decodeUnknownOption(ProviderInstanceConfig);

/** The instance as settings.json has it, read without the settings service or its database. */
const readSavedInstance = Effect.fn("cli.pool.readSavedInstance")(function* (
  settingsPath: string,
  instanceId: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const text = yield* fs.readFileString(settingsPath).pipe(Effect.orElseSucceed(() => "{}"));
  const saved = Option.getOrUndefined(decodeSavedProviderInstances(text));
  return Option.getOrUndefined(decodeProviderInstance(saved?.providerInstances?.[instanceId]));
});

const instanceIdArgument = Argument.String("instanceId").pipe(
  Argument.withDescription("Provider instance id, as in settings.providerInstances."),
);

// No lock spans processes: a server write between this read and write is lost. The running
// server reloads the result through its settings file watcher.
const makePoolCommand = (input: {
  readonly name: string;
  readonly description: string;
  readonly eligible: (instance: ProviderInstanceConfig | undefined) => boolean;
  readonly write: (
    instanceId: ProviderInstanceId,
  ) => Effect.Effect<boolean, ServerSettingsError, ServerSettings.ServerSettingsService>;
  readonly done: (instanceId: string) => string;
  readonly refused: (instanceId: string) => string;
}) =>
  Command.make(input.name, { ...projectLocationFlags, instanceId: instanceIdArgument }).pipe(
    Command.withDescription(input.description),
    Command.withHandler(
      Effect.fn(`cli.pool.${input.name}`)(function* (flags) {
        if (!(yield* devFlagEnabled)) {
          return yield* new CliError.UserError({
            cause: POOL_DEV_FLAG,
            userMessage: `\`s2code pool ${input.name}\` is a dev-only command. Set ${POOL_DEV_FLAG}=1 to use it.`,
          });
        }
        const refuse = new CliError.UserError({
          cause: flags.instanceId,
          userMessage: input.refused(flags.instanceId),
        });
        const config = yield* resolveCliAuthConfig(flags, yield* GlobalFlag.LogLevel);
        // Loading settings opens, and may migrate, the database; a refusal must not create it.
        if (!input.eligible(yield* readSavedInstance(config.settingsPath, flags.instanceId))) {
          return yield* refuse;
        }
        const changed = yield* input
          .write(ProviderInstanceId.make(flags.instanceId))
          .pipe(
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
        if (!changed) return yield* refuse;
        yield* Console.log(input.done(flags.instanceId));
      }),
    ),
  );

export const poolCommand = Command.make("pool").pipe(
  Command.withDescription(`Dev-only usage-limit pool controls. Requires ${POOL_DEV_FLAG}=1.`),
  Command.unlisted,
  Command.withSubcommands([
    makePoolCommand({
      name: "mark-spent",
      description: "Turn a pool member off as if its quota ran out.",
      eligible: disablesOnExhaustedQuota,
      write: markInstanceSpent,
      done: (id) => `Marked ${id} spent.`,
      refused: (id) =>
        `${id} was not changed: it must be an enabled instance set to turn off at its usage limit.`,
    }),
    makePoolCommand({
      name: "restore",
      description: "Turn a member back on that a local quota note without an account turned off.",
      eligible: isRestorable,
      write: restoreSpentInstance,
      done: (id) => `Restored ${id}.`,
      refused: (id) =>
        `${id} was not changed: it is not marked spent here, or its note came from account sync.`,
    }),
  ]),
);
