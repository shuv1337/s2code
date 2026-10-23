import { resolveDefaultProductHome } from "@t3tools/shared/productHome";
import * as Option from "effect/Option";
import { DEFAULT_HOME_DIRECTORY } from "@t3tools/shared/productIdentity";
import { resolveChannelIdentity } from "@t3tools/shared/channelIdentity";

export type JoinPath = (first: string, ...segments: string[]) => string;

function normalizeConfiguredBaseDir(t3Home: Option.Option<string>): Option.Option<string> {
  if (Option.isNone(t3Home)) {
    return Option.none();
  }
  const trimmed = t3Home.value.trim();
  return trimmed.length > 0 ? Option.some(trimmed) : Option.none();
}

export function resolveDesktopBaseDir(input: {
  readonly homeDirectory: string;
  readonly joinPath: JoinPath;
  readonly t3Home: Option.Option<string>;
  readonly appVersion?: string;
}): string {
  return Option.getOrElse(normalizeConfiguredBaseDir(input.t3Home), () =>
    resolveDefaultProductHome(
      input.homeDirectory,
      input.appVersion === undefined
        ? DEFAULT_HOME_DIRECTORY
        : resolveChannelIdentity(input.appVersion).homeDirectory,
    ),
  );
}

export function resolveDesktopStateDir(input: {
  readonly baseDir: string;
  readonly isDevelopment: boolean;
  readonly joinPath: JoinPath;
  readonly t3Home: Option.Option<string>;
}): string {
  const useDevSubdir =
    input.isDevelopment && Option.isNone(normalizeConfiguredBaseDir(input.t3Home));
  return input.joinPath(input.baseDir, useDevSubdir ? "dev" : "userdata");
}
