import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import { resolveChannelIdentity } from "@t3tools/shared/channelIdentity";

export class DesktopUserDataInitializationError extends Schema.TaggedError<DesktopUserDataInitializationError>()(
  "DesktopUserDataInitializationError",
  {
    operation: Schema.Literals(["inspect", "read", "create-directory", "write"]),
    resourcePath: Schema.String,
    category: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message() {
    return `Could not initialize Electron user data during ${this.operation} at ${this.resourcePath} (${this.category}).`;
  }

  static fromFileSystem(
    cause: PlatformError.PlatformError,
    operation: DesktopUserDataInitializationError["operation"],
    resourcePath: string,
  ) {
    return new DesktopUserDataInitializationError({
      operation,
      resourcePath,
      category: cause.reason._tag,
      cause,
    });
  }
}

export const resolveUserDataPath = Effect.fn("desktop.userData.resolveUserDataPath")(
  function* (input: {
    readonly appDataDirectory: string;
    readonly isDevelopment: boolean;
    readonly platform: NodeJS.Platform;
    readonly appVersion?: string;
    readonly homeDirectory?: string;
    readonly baseDir?: string;
  }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const identity = resolveChannelIdentity(input.appVersion ?? "");
    if (
      !input.isDevelopment &&
      identity.channel !== "stable" &&
      input.homeDirectory !== undefined &&
      input.baseDir === path.join(input.homeDirectory, identity.homeDirectory)
    ) {
      const sharedHome = path.join(input.homeDirectory, resolveChannelIdentity("").homeDirectory);
      const inspect = (resourcePath: string) =>
        fs
          .exists(resourcePath)
          .pipe(
            Effect.mapError((cause) =>
              DesktopUserDataInitializationError.fromFileSystem(cause, "inspect", resourcePath),
            ),
          );
      // layerOwned has already created the channel home/marker by this point.
      // The old shared location remains worth disclosing on every such startup.
      if (yield* inspect(sharedHome))
        yield* Effect.logWarning(
          `Starting ${identity.channel} with a separate home at ${input.baseDir}. Existing shared data remains untouched at ${sharedHome}; open stable to access it. No live database is copied or moved.`,
        );
    }
    // V2 starts independently: never inspect or copy upstream/V1 profiles or encryption keys.
    const destinationPath = path.join(
      input.appDataDirectory,
      input.isDevelopment
        ? "shuv2code-v2-dev"
        : resolveChannelIdentity(input.appVersion ?? "").profileDirectory,
    );
    yield* fs
      .exists(destinationPath)
      .pipe(
        Effect.mapError((cause) =>
          DesktopUserDataInitializationError.fromFileSystem(cause, "inspect", destinationPath),
        ),
      );
    return destinationPath;
  },
);
