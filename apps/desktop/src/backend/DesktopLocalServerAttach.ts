import { ExecutionEnvironmentDescriptor } from "@t3tools/contracts";
import { bootstrapRemoteBearerSession } from "@t3tools/client-runtime/authorization";
import { currentDesktopBootstrapToken } from "@t3tools/shared/desktopBootstrapToken";
import {
  LOCAL_SERVER_ATTACHMENT_FILE,
  LocalServerAttachment,
  isLocalServerAttachmentCompatible,
} from "@t3tools/shared/localServerAttachment";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

const decodeRuntime = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      pid: Schema.Int,
      serviceManaged: Schema.optional(Schema.Boolean),
      serverVersion: Schema.optional(Schema.String),
    }),
  ),
);
const decodeAttachment = Schema.decodeUnknownEffect(Schema.fromJsonString(LocalServerAttachment));

export class LocalServerAttachmentError extends Schema.TaggedError<LocalServerAttachmentError>()(
  "LocalServerAttachmentError",
  { reason: Schema.String },
) {
  override get message() {
    return this.reason;
  }
}

/** The background service runs another version; its own `update` can move it to the desktop's. */
export class LocalServiceVersionMismatch extends Schema.TaggedError<LocalServiceVersionMismatch>()(
  "LocalServiceVersionMismatch",
  { serverVersion: Schema.String },
) {
  override get message() {
    return `The background service runs ${this.serverVersion}.`;
  }
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

/** A live but incompatible/unreachable server must never trigger a competing DB owner. */
export const discover = Effect.fn("desktop.localServerAttach.discover")(function* (input: {
  readonly stateDir: string;
  readonly appVersion: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = path.join(input.stateDir, LOCAL_SERVER_ATTACHMENT_FILE);
  const runtimePath = path.join(input.stateDir, "server-runtime.json");
  const readRuntime = fs.readFileString(runtimePath).pipe(
    Effect.flatMap(decodeRuntime),
    Effect.mapError(
      () =>
        new LocalServerAttachmentError({
          reason: "Cannot read the local server runtime record.",
        }),
    ),
  );
  const ensureNoLiveRuntime = Effect.gen(function* () {
    if (yield* fs.exists(runtimePath)) {
      const runtime = yield* readRuntime;
      if (isProcessAlive(runtime.pid)) {
        if (runtime.serviceManaged === true && runtime.serverVersion !== input.appVersion) {
          return yield* new LocalServiceVersionMismatch({
            serverVersion: runtime.serverVersion ?? "unknown",
          });
        }
        return yield* new LocalServerAttachmentError({
          reason:
            "A server is already running but does not support automatic desktop attachment. Update or stop it first.",
        });
      }
    }
  });
  if (!(yield* fs.exists(file))) {
    yield* ensureNoLiveRuntime;
    return null;
  }
  const record = yield* fs.readFileString(file).pipe(
    Effect.flatMap(decodeAttachment),
    Effect.mapError(
      () =>
        new LocalServerAttachmentError({
          reason: "Cannot read the local server attachment record.",
        }),
    ),
  );
  if (!isProcessAlive(record.pid)) {
    yield* ensureNoLiveRuntime;
    return null;
  }
  if (!isLocalServerAttachmentCompatible(record, input.appVersion)) {
    // Only a service is safe to restart on the user's behalf; a server started by hand is theirs.
    const runtime = yield* readRuntime.pipe(Effect.option);
    if (
      record.serverVersion !== input.appVersion &&
      Option.isSome(runtime) &&
      runtime.value.serviceManaged === true &&
      runtime.value.pid === record.pid
    ) {
      return yield* new LocalServiceVersionMismatch({ serverVersion: record.serverVersion });
    }
    return yield* new LocalServerAttachmentError({
      reason:
        "The running server and desktop versions differ. Update both, or stop the server before opening the desktop.",
    });
  }
  // Never use a URL from disk for the credential exchange.
  const httpBaseUrl = `http://127.0.0.1:${record.port}`;
  const client = yield* HttpClient.HttpClient;
  yield* Effect.gen(function* () {
    const descriptor = yield* client
      .get(`${httpBaseUrl}/.well-known/t3/environment`)
      .pipe(Effect.flatMap(HttpClientResponse.schemaBodyJson(ExecutionEnvironmentDescriptor)));
    if (descriptor.serverVersion !== input.appVersion) {
      return yield* new LocalServerAttachmentError({
        reason: "The local endpoint is running a different server version.",
      });
    }
    yield* bootstrapRemoteBearerSession({
      httpBaseUrl,
      credential: currentDesktopBootstrapToken(
        record.bootstrapSecret,
        yield* Clock.currentTimeMillis,
      ),
    });
  }).pipe(
    Effect.timeout("3 seconds"),
    Effect.mapError(
      () =>
        new LocalServerAttachmentError({
          reason:
            "The existing local server is unavailable or rejected desktop authentication. Restart that server, then retry.",
        }),
    ),
  );
  return record;
});

/**
 * Runs the desktop's bundled CLI `update` pinned to the desktop's own version. It
 * downloads that release's runtime, repoints the service, and restarts it. The CLI
 * refuses to move a newer service backwards, so a desktop older than its service
 * reports that instead of downgrading the database owner.
 */
export const updateServiceToAppVersion = Effect.fn("desktop.localServerAttach.updateService")(
  function* (input: {
    readonly executablePath: string;
    readonly entryArgs: ReadonlyArray<string>;
    readonly env: Record<string, string | undefined>;
    readonly appVersion: string;
  }) {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const failed = (detail: string) =>
      new LocalServerAttachmentError({
        reason: `Could not move the background service to ${input.appVersion}: ${detail}`,
      });
    const [output, exitCode] = yield* Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* spawner.spawn(
          ChildProcess.make(
            input.executablePath,
            [...input.entryArgs, "update", input.appVersion, "--yes"],
            { stdin: "ignore", env: input.env, extendEnv: true },
          ),
        );
        return yield* Effect.all(
          [
            Stream.merge(handle.stdout, handle.stderr).pipe(Stream.decodeText(), Stream.mkString),
            handle.exitCode,
          ],
          { concurrency: "unbounded" },
        );
      }),
    ).pipe(
      Effect.timeout("10 minutes"),
      Effect.mapError((error) => failed(error.message)),
    );
    if (exitCode !== 0) {
      const lastLine = output.trim().split("\n").at(-1)?.trim();
      return yield* failed(lastLine || `update exited with ${exitCode}`);
    }
  },
);
