import { ProviderDriverKind, type ServerProvider } from "@t3tools/contracts";
import { compareSemverVersions } from "@t3tools/shared/semver";
import { OpenCodeSettings } from "../settings.ts";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/http/HttpClient";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as OpenCode2TextGeneration from "./v2/textGeneration.ts";
import { makeOpenCodeTextGeneration } from "./textGeneration.ts";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import * as OpenCodeAdapterV2 from "./adapter.ts";
import * as OpenCode2AdapterV2 from "./v2/adapter.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import type { ProviderTextGeneration } from "@t3tools/provider-core/server/textGeneration";
import { ProviderDriverError } from "@t3tools/provider-core/server/errors";
import { openCodeUsageReader, type OpenCodeUsageReaderEnv } from "./usage.ts";
import { readOpenCodeGoUsageLimits } from "./usageLimits.ts";
import { loadOpenCode2Catalog } from "./openCode2Catalog.ts";
import {
  checkOpenCodeProviderStatus,
  loadOpenCode2Workspace,
  makeOpenCode2ModelLoader,
  makePendingOpenCodeProvider,
  openCode2CommandsToServerProviderSlashCommands,
  openCode2SkillsToServerProviderSkills,
  openCodeSkillsToServerProviderSkills,
  openCodeCommandsToServerProviderSlashCommands,
} from "./status.ts";
import { makeManagedServerProvider } from "@t3tools/provider-core/server/managedProvider";
import * as OpenCodeRuntime from "./OpenCodeRuntime.ts";
import {
  makeOpenCodeRuntimeProbe,
  probeOpenCodeRuntime,
  type ProbedOpenCode,
} from "./versionProbe.ts";
import * as OpenCodeServerOwner from "./OpenCodeServerOwner.ts";
import * as OpenCode2Client from "./v2/OpenCode2Client.ts";
import * as OpenCode2Server from "./v2/OpenCode2Server.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "@t3tools/provider-core/server/driver";
import { withInstanceIdentity } from "@t3tools/provider-core/server/instanceIdentity";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  makeCachedProviderMaintenanceResolution,
  makeManualOnlyProviderMaintenanceCapabilities,
  makePackageManagedProviderMaintenanceResolver,
  makeProviderMaintenanceCapabilities,
  normalizeCommandPath,
  resolveProviderMaintenanceCapabilitiesEffect,
  type ProviderMaintenanceCapabilities,
  type ProviderMaintenanceCapabilitiesResolver,
  type ProviderMaintenanceResolutionContext,
} from "@t3tools/provider-core/server/maintenanceResolver";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "@t3tools/provider-core/server/snapshotSettings";
const decodeOpenCodeSettings = Schema.decodeSync(OpenCodeSettings);

const DRIVER_KIND = ProviderDriverKind.make("opencode");

function isOpenCodeNativeCommandPath(commandPath: string): boolean {
  const normalized = normalizeCommandPath(commandPath);
  return (
    normalized.endsWith("/.opencode/bin/opencode") ||
    normalized.endsWith("/.opencode/bin/opencode.exe")
  );
}

/**
 * OpenCode 1.x ships as `opencode-ai` and 2.x as `@opencode/cli`. An install is
 * only ever updated within its own package: T3 never moves a 1.x install onto
 * 2.x or back, since 2.x converts the shared database in place.
 */
export const openCodeUpdateFor = (generation: ProbedOpenCode["generation"]) =>
  makeOpenCodeMaintenanceResolver({
    provider: DRIVER_KIND,
    npmPackageName: generation === "v2" ? "@opencode/cli" : "opencode-ai",
    nativeUpdate: {
      args: ["upgrade"],
      isCommandPath: isOpenCodeNativeCommandPath,
    },
  });

const SHUVCODE_PACKAGE_PATTERN =
  /^shuvcode(?:-node)?(?:-(?:darwin|linux|windows)-(?:x64|arm64|arm)(?:-baseline)?(?:-musl)?)?$/;

/** Map shuvcode's wrapper and platform packages back to the package whose `latest` tag it follows. */
function shuvcodePackageFromCommandPath(commandPath: string): "shuvcode" | "shuvcode-node" | null {
  const packages = Array.from(
    commandPath.replaceAll("\\", "/").matchAll(/\/node_modules\/([^/]+)/gi),
    (match) => match[1]?.toLowerCase(),
  ).filter((packageName): packageName is string => packageName !== undefined);
  const ownedPackage = packages.find((packageName) => SHUVCODE_PACKAGE_PATTERN.test(packageName));
  if (!ownedPackage) return null;
  return ownedPackage.startsWith("shuvcode-node") ? "shuvcode-node" : "shuvcode";
}

function isShuvcodeCommand(context: ProviderMaintenanceResolutionContext): boolean {
  return [context.binaryPath, context.resolvedCommandPath, context.realCommandPath].some(
    (commandPath) => /(?:^|[/\\])shuvcode(?:\.(?:cmd|bat|exe|ps1))?$/i.test(commandPath),
  );
}

const shuvcodePackageFromWindowsShim = Effect.fn("shuvcodePackageFromWindowsShim")(function* (
  context: ProviderMaintenanceResolutionContext,
) {
  if (context.platform !== "win32" || !isShuvcodeCommand(context)) return null;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const shimDirectory = path.dirname(context.resolvedCommandPath);
  for (const packageName of ["shuvcode", "shuvcode-node"] as const) {
    const manifest = path.join(shimDirectory, "node_modules", packageName, "package.json");
    if (yield* fileSystem.exists(manifest).pipe(Effect.orElseSucceed(() => false))) {
      return packageName;
    }
  }
  return null;
});

function makeOpenCodeMaintenanceResolver(
  definition: Parameters<typeof makePackageManagedProviderMaintenanceResolver>[0],
): ProviderMaintenanceCapabilitiesResolver {
  const upstream = makePackageManagedProviderMaintenanceResolver(definition);
  return {
    resolve: (context) =>
      Effect.gen(function* () {
        if (!context) return yield* upstream.resolve(context);
        const shuvcodePackage =
          [context.resolvedCommandPath, context.realCommandPath]
            .map(shuvcodePackageFromCommandPath)
            .find((packageName) => packageName !== null) ??
          (yield* shuvcodePackageFromWindowsShim(context));
        if (shuvcodePackage) {
          return makeProviderMaintenanceCapabilities({
            provider: definition.provider,
            packageName: shuvcodePackage,
            updateExecutable: context.resolvedCommandPath,
            updateArgs: ["upgrade"],
            updateLockKey: `${definition.provider}-native`,
            platform: context.platform,
          });
        }
        if (isShuvcodeCommand(context)) {
          return makeManualOnlyProviderMaintenanceCapabilities({
            provider: definition.provider,
            packageName: "shuvcode",
          });
        }
        return yield* upstream.resolve(context);
      }),
  };
}

export const enrichOpenCodeSnapshotWithVersionAdvisory = Effect.fn(
  "enrichOpenCodeSnapshotWithVersionAdvisory",
)(function* (input: {
  readonly snapshot: ServerProvider;
  readonly maintenanceCapabilities: ProviderMaintenanceCapabilities;
  readonly installedRuntime: ProbedOpenCode | undefined;
  readonly usesExternalServer: boolean;
  readonly enableProviderUpdateChecks: boolean | undefined;
}) {
  const advisoryVersion = input.usesExternalServer
    ? (input.installedRuntime?.version ?? null)
    : input.snapshot.version;
  const enriched = yield* enrichProviderSnapshotWithVersionAdvisory(
    { ...input.snapshot, version: advisoryVersion },
    input.maintenanceCapabilities,
    { enableProviderUpdateChecks: input.enableProviderUpdateChecks },
  );
  const serverVersion = input.snapshot.version;
  const restartPending =
    input.usesExternalServer &&
    advisoryVersion !== null &&
    serverVersion !== null &&
    compareSemverVersions(serverVersion, advisoryVersion) < 0;
  const packageName = input.maintenanceCapabilities.packageName;
  const providerName = packageName?.startsWith("shuvcode") ? "shuvcode" : "OpenCode";
  return {
    ...enriched,
    version: serverVersion,
    versionAdvisory:
      restartPending && enriched.versionAdvisory
        ? {
            ...enriched.versionAdvisory,
            message: `${providerName} ${advisoryVersion} is installed; the running server is still ${serverVersion} and will use the new version after it restarts.`,
          }
        : enriched.versionAdvisory,
  };
});

type OpenCodeRuntimeProbe = Effect.Success<
  ReturnType<typeof makeOpenCodeRuntimeProbe<OpenCodeRuntime.OpenCodeRuntimeError>>
>;

function byOpenCodeRuntime<A, E, R, PE>(
  probed: Effect.Effect<ProbedOpenCode | undefined, PE>,
  paths: { readonly v1: Effect.Effect<A, E, R>; readonly v2: Effect.Effect<A, E, R> },
): Effect.Effect<A, E, R> {
  return probed.pipe(
    Effect.orElseSucceed(() => undefined),
    Effect.flatMap((result) => (result?.generation === "v2" ? paths.v2 : paths.v1)),
  );
}

/**
 * Capability and selection reads are hot, so they use the last successful probe (1.x before one
 * lands) and never wait on a slow server. Opening a session waits for a probe, so each server is
 * spoken to in its own protocol.
 */
function selectOpenCodeRuntimeAdapter(input: {
  readonly probe: OpenCodeRuntimeProbe;
  readonly v1: ProviderAdapter.ProviderAdapterV2["Service"];
  readonly v2: ProviderAdapter.ProviderAdapterV2["Service"];
}): ProviderAdapter.ProviderAdapterV2["Service"] {
  const pick = <PE>(probed: Effect.Effect<ProbedOpenCode | undefined, PE>) =>
    byOpenCodeRuntime(probed, { v1: Effect.succeed(input.v1), v2: Effect.succeed(input.v2) });
  const hot = pick(Effect.map(input.probe.lastSuccess, Option.getOrUndefined));
  return {
    instanceId: input.v1.instanceId,
    driver: DRIVER_KIND,
    getCapabilities: () => Effect.flatMap(hot, (adapter) => adapter.getCapabilities()),
    planSelectionTransition: (transition) =>
      Effect.flatMap(hot, (adapter) => adapter.planSelectionTransition(transition)),
    openSession: (session) =>
      Effect.flatMap(pick(input.probe.get), (adapter) => adapter.openSession(session)),
  };
}

function selectOpenCodeRuntimeTextGeneration(
  probe: OpenCodeRuntimeProbe,
  v1: ProviderTextGeneration,
  v2: ProviderTextGeneration,
): ProviderTextGeneration {
  return {
    generateCommitMessage: (input) =>
      byOpenCodeRuntime(probe.get, {
        v1: v1.generateCommitMessage(input),
        v2: v2.generateCommitMessage(input),
      }),
    generatePrContent: (input) =>
      byOpenCodeRuntime(probe.get, {
        v1: v1.generatePrContent(input),
        v2: v2.generatePrContent(input),
      }),
    generateBranchName: (input) =>
      byOpenCodeRuntime(probe.get, {
        v1: v1.generateBranchName(input),
        v2: v2.generateBranchName(input),
      }),
    generateThreadTitle: (input) =>
      byOpenCodeRuntime(probe.get, {
        v1: v1.generateThreadTitle(input),
        v2: v2.generateThreadTitle(input),
      }),
    generateReviewGuide: (input) =>
      byOpenCodeRuntime(probe.get, {
        v1: v1.generateReviewGuide(input),
        v2: v2.generateReviewGuide(input),
      }),
  };
}

export type OpenCodeDriverEnv =
  | OpenCodeAdapterV2.OpenCodeAdapterV2DriverEnv
  | ProviderHost.ProviderHost
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | ProviderLatestVersions.ProviderLatestVersions
  | OpenCodeRuntime.OpenCodeRuntime
  | Path.Path;

export const OpenCodeDriver: ProviderDriver<
  OpenCodeSettings,
  OpenCodeDriverEnv,
  OpenCodeUsageReaderEnv
> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "OpenCode",
    supportsMultipleInstances: true,
  },
  configSchema: OpenCodeSettings,
  defaultConfig: (): OpenCodeSettings => decodeOpenCodeSettings({}),
  usage: openCodeUsageReader,
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const pathService = yield* Path.Path;
      const openCodeRuntime = yield* OpenCodeRuntime.OpenCodeRuntime;
      const httpClient = yield* HttpClient.HttpClient;
      const latestVersions = yield* ProviderLatestVersions.ProviderLatestVersions;
      const crypto = yield* Crypto.Crypto;
      const host = yield* ProviderHost.ProviderHost;
      const processEnv = yield* mergeProviderInstanceEnvironment(environment);
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const stampIdentity = withInstanceIdentity({
        instanceId,
        driverKind: DRIVER_KIND,
        displayName,
        accentColor,
        continuationGroupKey: continuationIdentity.continuationKey,
      });
      const effectiveConfig = { ...config, enabled } satisfies OpenCodeSettings;
      const runtimeProbe = yield* makeOpenCodeRuntimeProbe(
        probeOpenCodeRuntime(effectiveConfig, processEnv).pipe(
          Effect.provideService(HttpClient.HttpClient, httpClient),
          Effect.provideService(OpenCodeRuntime.OpenCodeRuntime, openCodeRuntime),
        ),
      );
      const usesExternalServer = effectiveConfig.serverUrl.trim().length > 0;
      const installedRuntimeProbe = usesExternalServer
        ? yield* makeOpenCodeRuntimeProbe(
            probeOpenCodeRuntime(
              { ...effectiveConfig, serverUrl: "", serverPassword: "" },
              processEnv,
            ).pipe(
              Effect.provideService(HttpClient.HttpClient, httpClient),
              Effect.provideService(OpenCodeRuntime.OpenCodeRuntime, openCodeRuntime),
            ),
          )
        : runtimeProbe;
      // Updates follow the installed package, which the version probe names. An
      // unknown version offers no package update, since a guess could move a
      // 2.x install onto 1.x's package or the reverse. A disabled instance never
      // runs its binary, so it has no version and offers no update.
      const noUpdate = makeManualOnlyProviderMaintenanceCapabilities({
        provider: DRIVER_KIND,
        packageName: null,
      });
      const unavailableInstalledRuntime: ProviderMaintenanceCapabilities = {
        ...noUpdate,
        installedVersion: null,
      };
      const maintenanceFor = (probed: typeof runtimeProbe.get) =>
        probed.pipe(
          Effect.option,
          Effect.flatMap((result) =>
            Option.isNone(result)
              ? Effect.succeed(unavailableInstalledRuntime)
              : resolveProviderMaintenanceCapabilitiesEffect(
                  openCodeUpdateFor(result.value.generation),
                  {
                    binaryPath: effectiveConfig.binaryPath,
                    env: processEnv,
                  },
                ).pipe(
                  Effect.map((capabilities) => ({
                    ...capabilities,
                    installedVersion: result.value.version,
                  })),
                ),
          ),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, pathService),
        );
      const cachedMaintenance = yield* makeCachedProviderMaintenanceResolution(
        maintenanceFor(installedRuntimeProbe.get),
      );
      const resolveMaintenance = (options?: { readonly fresh?: boolean }) =>
        !effectiveConfig.enabled
          ? Effect.succeed(noUpdate)
          : options?.fresh === true
            ? installedRuntimeProbe.refresh.pipe(
                Effect.ignore,
                Effect.andThen(cachedMaintenance({ fresh: true })),
              )
            : cachedMaintenance();
      const resolveSnapshotMaintenance = usesExternalServer
        ? Effect.gen(function* () {
            const installedRuntime = yield* installedRuntimeProbe.refresh.pipe(Effect.option);
            const maintenanceCapabilities = Option.isSome(installedRuntime)
              ? yield* maintenanceFor(Effect.succeed(installedRuntime.value))
              : noUpdate;
            return {
              maintenanceCapabilities,
              installedRuntime: Option.getOrUndefined(installedRuntime),
            };
          })
        : Effect.all({
            maintenanceCapabilities: resolveMaintenance(),
            installedRuntime: installedRuntimeProbe.get.pipe(
              Effect.option,
              Effect.map(Option.getOrUndefined),
            ),
          });
      const openCodeV1Adapter = yield* OpenCodeAdapterV2.OpenCodeAdapterV2Driver.create({
        instanceId,
        displayName,
        accentColor,
        environment,
        enabled,
        config,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: "Failed to build OpenCode orchestration adapter.",
              cause,
            }),
        ),
      );
      const openCode2Server = yield* OpenCode2Server.make({
        binaryPath: effectiveConfig.binaryPath,
        serverUrl: effectiveConfig.serverUrl,
        serverPassword: effectiveConfig.serverPassword,
        directory: host.paths.cwd,
        environment: processEnv,
      }).pipe(
        Effect.provideService(OpenCodeRuntime.OpenCodeRuntime, openCodeRuntime),
        Effect.provideService(
          OpenCode2Client.OpenCode2Client,
          yield* OpenCode2Client.make.pipe(
            Effect.provideService(HttpClient.HttpClient, httpClient),
          ),
        ),
      );
      const orchestrationAdapter = selectOpenCodeRuntimeAdapter({
        probe: runtimeProbe,
        v1: openCodeV1Adapter,
        v2: yield* OpenCode2AdapterV2.make(instanceId).pipe(
          Effect.provideService(OpenCode2Server.OpenCode2Server, openCode2Server),
        ),
      });
      const loadOpenCode2Models = yield* makeOpenCode2ModelLoader(
        openCode2Server.withConnection(({ client }) =>
          loadOpenCode2Catalog(client, host.paths.cwd),
        ),
      );
      const listOpenCode2Workspace = (cwd: string) =>
        openCode2Server.withConnection(({ client, events }) =>
          Effect.gen(function* () {
            const location = { directory: cwd };
            const scanned = yield* Deferred.make<void>();
            const pending = new Set(["command.updated", "skill.updated"]);
            const stream = yield* events.pipe(Effect.option);
            if (stream._tag === "Some") {
              yield* stream.value.pipe(
                Stream.runForEach((event) =>
                  "location" in event &&
                  event.location?.directory === cwd &&
                  pending.delete(event.type) &&
                  pending.size === 0
                    ? Deferred.succeed(scanned, undefined)
                    : Effect.void,
                ),
                Effect.ignore,
                Effect.forkScoped,
              );
            }
            return yield* loadOpenCode2Workspace(
              Effect.all(
                {
                  skills: client.skill.list({ location }).pipe(Effect.map((list) => list.data)),
                  commands: client.command.list({ location }).pipe(Effect.map((list) => list.data)),
                },
                { concurrency: "unbounded" },
              ),
              Deferred.await(scanned),
            );
          }).pipe(Effect.scoped),
        );
      const serverOwner = yield* OpenCodeServerOwner.make({
        binaryPath: effectiveConfig.binaryPath,
        directory: host.paths.cwd,
        ...(effectiveConfig.serverPassword
          ? { serverPassword: effectiveConfig.serverPassword }
          : {}),
        environment: processEnv,
      });
      const textGeneration = selectOpenCodeRuntimeTextGeneration(
        runtimeProbe,
        yield* makeOpenCodeTextGeneration(effectiveConfig).pipe(
          Effect.provideService(OpenCodeServerOwner.OpenCodeServerOwner, serverOwner),
        ),
        yield* OpenCode2TextGeneration.make().pipe(
          Effect.provideService(OpenCode2Server.OpenCode2Server, openCode2Server),
        ),
      );

      const checkProvider = Effect.all(
        {
          provider: checkOpenCodeProviderStatus(
            effectiveConfig,
            host.paths.cwd,
            runtimeProbe.refresh,
            loadOpenCode2Models,
          ),
          usageLimits: readOpenCodeGoUsageLimits({
            enabled: effectiveConfig.enabled,
            serverUrl: effectiveConfig.serverUrl,
            environment: processEnv,
          }),
        },
        { concurrency: "unbounded" },
      ).pipe(
        Effect.map(({ provider, usageLimits }) => ({ ...provider, usageLimits })),
        Effect.map(stampIdentity),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, pathService),
        Effect.provideService(HttpClient.HttpClient, httpClient),
        Effect.provideService(Crypto.Crypto, crypto),
        Effect.provideService(OpenCodeServerOwner.OpenCodeServerOwner, serverOwner),
        Effect.provideService(OpenCodeRuntime.OpenCodeRuntime, openCodeRuntime),
      );
      // The CLI writes its full JSON inventory to stdout, but the Bun-compiled binary does not
      // flush more than one 64KB pipe buffer to a non-TTY stdout, so the piped output arrives
      // truncated and unparseable — which degrades to an empty skill list and poisons the workspace
      // snapshot the `$` picker reads.
      const loadWorkspaceInventory = (
        client: Parameters<typeof OpenCodeRuntime.loadOpenCodeCommands>[0],
      ) =>
        Effect.all(
          {
            skills: openCodeRuntime.loadOpenCodeSkills(client),
            commands: OpenCodeRuntime.loadOpenCodeCommands(client).pipe(
              Effect.timeout("10 seconds"),
              Effect.orElseSucceed(() => []),
            ),
          },
          { concurrency: "unbounded" },
        );
      const loadWorkspaceForCwd = (cwd: string) =>
        effectiveConfig.serverUrl.trim().length > 0
          ? Effect.scoped(
              Effect.gen(function* () {
                const server = yield* openCodeRuntime.connectToOpenCodeServer({
                  binaryPath: effectiveConfig.binaryPath,
                  directory: cwd,
                  serverUrl: effectiveConfig.serverUrl,
                  ...(effectiveConfig.serverPassword
                    ? { serverPassword: effectiveConfig.serverPassword }
                    : {}),
                  environment: processEnv,
                });
                const client = openCodeRuntime.createOpenCodeSdkClient({
                  baseUrl: server.url,
                  directory: cwd,
                  ...(effectiveConfig.serverPassword
                    ? { serverPassword: effectiveConfig.serverPassword }
                    : {}),
                });
                return yield* loadWorkspaceInventory(client);
              }),
            )
          : serverOwner.withServer((server) =>
              loadWorkspaceInventory(
                openCodeRuntime.createOpenCodeSdkClient({
                  baseUrl: server.url,
                  directory: cwd,
                  ...(server.serverPassword !== undefined
                    ? { serverPassword: server.serverPassword }
                    : {}),
                }),
              ),
            );

      const snapshotSettings = yield* makeProviderSnapshotSettingsSource(effectiveConfig);
      const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<OpenCodeSettings>>(
        {
          resolveMaintenance,
          getSettings: snapshotSettings.getSettings,
          streamSettings: snapshotSettings.streamSettings,
          haveSettingsChanged: haveProviderSnapshotSettingsChanged,
          checkProviderOnSettingsChange: () => false,
          refreshOnInterval: false,
          initialSnapshot: (settings) =>
            makePendingOpenCodeProvider(settings.provider).pipe(Effect.map(stampIdentity)),
          checkProvider,
          enrichSnapshot: ({ settings, snapshot, publishSnapshot }) =>
            resolveSnapshotMaintenance.pipe(
              Effect.flatMap(({ maintenanceCapabilities, installedRuntime }) =>
                enrichOpenCodeSnapshotWithVersionAdvisory({
                  snapshot,
                  maintenanceCapabilities,
                  installedRuntime,
                  usesExternalServer,
                  enableProviderUpdateChecks: settings.enableProviderUpdateChecks,
                }),
              ),
              Effect.provideService(HttpClient.HttpClient, httpClient),
              Effect.provideService(ProviderLatestVersions.ProviderLatestVersions, latestVersions),
              Effect.flatMap((enrichedSnapshot) => publishSnapshot(enrichedSnapshot)),
            ),
        },
      ).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to build OpenCode snapshot: ${cause.message ?? String(cause)}`,
              cause,
            }),
        ),
      );

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot,
        snapshotForCwd: (cwd) =>
          !effectiveConfig.enabled
            ? snapshot.getSnapshot
            : byOpenCodeRuntime(runtimeProbe.get, {
                v2: Effect.all([
                  snapshot.getSnapshot,
                  listOpenCode2Workspace(cwd).pipe(
                    Effect.timeout("20 seconds"),
                    Effect.mapError(
                      (cause) =>
                        new ProviderDriverError({
                          driver: DRIVER_KIND,
                          instanceId,
                          detail: `Failed to list OpenCode commands and skills for '${cwd}'`,
                          cause,
                        }),
                    ),
                  ),
                ]).pipe(
                  Effect.map(([machineSnapshot, { skills, commands }]) => ({
                    ...machineSnapshot,
                    skills: openCode2SkillsToServerProviderSkills(skills),
                    slashCommands: openCode2CommandsToServerProviderSlashCommands(commands),
                  })),
                ),
                v1: Effect.all([
                  snapshot.getSnapshot,
                  loadWorkspaceForCwd(cwd).pipe(Effect.timeout("20 seconds")),
                ]).pipe(
                  Effect.map(([machineSnapshot, { skills, commands }]) => ({
                    ...machineSnapshot,
                    skills: openCodeSkillsToServerProviderSkills(skills),
                    slashCommands: openCodeCommandsToServerProviderSlashCommands(commands),
                  })),
                  Effect.mapError(
                    (cause) =>
                      new ProviderDriverError({
                        driver: DRIVER_KIND,
                        instanceId,
                        detail: `Failed to probe OpenCode commands and skills for '${cwd}'`,
                        cause,
                      }),
                  ),
                ),
              }),
        orchestrationAdapter,
        textGeneration,
      } satisfies ProviderInstance;
    }),
};
