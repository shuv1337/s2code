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
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/http";

const decodeRuntime = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ pid: Schema.Int })),
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
  const ensureNoLiveRuntime = Effect.gen(function* () {
    const runtimePath = path.join(input.stateDir, "server-runtime.json");
    if (yield* fs.exists(runtimePath)) {
      const runtime = yield* fs.readFileString(runtimePath).pipe(
        Effect.flatMap(decodeRuntime),
        Effect.mapError(
          () =>
            new LocalServerAttachmentError({
              reason: "Cannot read the local server runtime record.",
            }),
        ),
      );
      if (isProcessAlive(runtime.pid))
        return yield* new LocalServerAttachmentError({
          reason:
            "A server is already running but does not support automatic desktop attachment. Update or stop it first.",
        });
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
