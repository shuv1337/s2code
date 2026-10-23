// @effect-diagnostics nodeBuiltinImport:off - Ownership is checked before either Node or Effect startup opens state.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeCrypto from "node:crypto";
import {
  DEFAULT_HOME_DIRECTORY,
  LEGACY_HOME_DIRECTORY,
  LEGACY_PRODUCT_ID,
  PRODUCT_HOME_MARKER,
  PRODUCT_ID,
  isProductIdentity,
} from "./productIdentity.ts";

/** Resolve existing ancestors too, so a new child of an upstream symlink is not adopted. */
export function canonicalProductPath(directory: string): string {
  const absolute = NodePath.resolve(directory);
  try {
    return NodeFS.realpathSync(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = NodePath.dirname(absolute);
    if (parent === absolute) throw error;
    return NodePath.join(canonicalProductPath(parent), NodePath.basename(absolute));
  }
}

function readProductMarker(directory: string) {
  const marker = NodePath.join(directory, PRODUCT_HOME_MARKER);
  try {
    const stat = NodeFS.lstatSync(marker);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1)
      throw new Error("Refusing linked product metadata.");
    return NodeFS.readFileSync(marker, "utf8").trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return undefined;
  }
}

function hasHomeState(directory: string) {
  try {
    return NodeFS.readdirSync(directory).some((entry) => entry !== PRODUCT_HOME_MARKER);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return false;
  }
}

/** Existing V2 state stays in place; a spelling change must not start an empty environment. */
export function resolveDefaultProductHome(
  homeDirectory: string,
  directoryName = DEFAULT_HOME_DIRECTORY,
): string {
  if (!/^\.s2code-v2(?:-(?:nightly|preview|dev))?$/.test(directoryName))
    throw new Error("Expected a channel-specific S2Code V2 home name.");
  const current = NodePath.join(homeDirectory, directoryName);
  const legacy = NodePath.join(
    homeDirectory,
    directoryName.replace(DEFAULT_HOME_DIRECTORY, LEGACY_HOME_DIRECTORY),
  );
  ensureProductHome(current, false);
  if (!hasHomeState(legacy)) return current;
  ensureProductHome(legacy, false);
  if (hasHomeState(current) && canonicalProductPath(current) !== canonicalProductPath(legacy)) {
    throw new Error(
      `Both ${current} and ${legacy} contain state. Set S2CODE_HOME to choose one; automatic merging is not supported.`,
    );
  }
  return hasHomeState(current) ? current : legacy;
}

/** Refuse foreign state before creating anything. Empty custom homes can be claimed. */
export function ensureProductHome(directory: string, claim = true): void {
  const canonical = canonicalProductPath(directory);
  if (canonical === NodePath.parse(canonical).root)
    throw new Error("Cannot establish product ownership of a filesystem root.");
  const developmentHome =
    NodePath.basename(canonical).toLowerCase() === ".t3" &&
    NodePath.dirname(canonical).toLowerCase() !==
      canonicalProductPath(NodeOS.homedir()).toLowerCase() &&
    NodeFS.existsSync(NodePath.join(NodePath.dirname(canonical), ".git"));
  if (
    canonical.split(NodePath.sep).some((segment) => segment.toLowerCase() === ".t3") &&
    !developmentHome
  ) {
    throw new Error(
      "Refusing an upstream .t3 home. Choose a separate S2CODE_HOME; upstream import is not supported.",
    );
  }
  const stateFiles = [
    "statev2.sqlite",
    "statev2.sqlite-wal",
    "statev2.sqlite-shm",
    "state.sqlite",
    "state.sqlite-wal",
    "state.sqlite-shm",
    "environment-id",
    "anonymous-id",
    "server-runtime.json",
    "settings.json",
    "desktop-settings.json",
  ];
  const protectedPaths = [
    "userdata",
    "dev",
    "runtime",
    "caches",
    ...["userdata", "dev"].flatMap((state) => [
      NodePath.join(state, "secrets"),
      ...stateFiles.map((file) => NodePath.join(state, file)),
    ]),
  ];
  for (const child of protectedPaths) {
    const target = canonicalProductPath(NodePath.join(canonical, child));
    if (!target.startsWith(`${canonical}${NodePath.sep}`))
      throw new Error(`Refusing foreign ${child} path in ${directory}.`);
    try {
      const stat = NodeFS.statSync(target);
      if (stat.isFile() && stat.nlink > 1)
        throw new Error(`Refusing shared ${child} file in ${directory}.`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const marker = NodePath.join(canonical, PRODUCT_HOME_MARKER);
  const existing = readProductMarker(canonical);
  // Retain the old marker so a rollback can still open the same installation.
  if (existing !== undefined && isProductIdentity(existing)) return;
  if (
    existing !== undefined &&
    !PRODUCT_ID.startsWith(existing) &&
    !LEGACY_PRODUCT_ID.startsWith(existing)
  )
    throw new Error(`Home ${directory} belongs to another product.`);
  // An incomplete marker is not ownership proof. Reclaim only an otherwise
  // empty home or the same exact legacy default/worktree exception as no marker.
  const entries = NodeFS.existsSync(canonical)
    ? NodeFS.readdirSync(canonical).filter((entry) => entry !== PRODUCT_HOME_MARKER)
    : [];
  const defaultHome =
    (NodePath.sep === "\\" ? canonical.toLowerCase() : canonical) ===
    (NodePath.sep === "\\"
      ? NodePath.join(canonicalProductPath(NodeOS.homedir()), LEGACY_HOME_DIRECTORY).toLowerCase()
      : NodePath.join(canonicalProductPath(NodeOS.homedir()), LEGACY_HOME_DIRECTORY));
  if (entries.length && !defaultHome && !developmentHome) {
    throw new Error(
      `Cannot establish product ownership of ${directory}. Choose an empty S2CODE_HOME. For an existing fork installation, verify it offline before adding ${PRODUCT_HOME_MARKER} containing ${PRODUCT_ID}; this is not an upstream import.`,
    );
  }
  if (claim) {
    NodeFS.mkdirSync(canonical, { recursive: true });
    const temporary = `${marker}.${NodeCrypto.randomUUID()}.tmp`;
    try {
      NodeFS.writeFileSync(temporary, `${defaultHome ? LEGACY_PRODUCT_ID : PRODUCT_ID}\n`, {
        flag: "wx",
      });
      NodeFS.renameSync(temporary, marker);
    } finally {
      NodeFS.rmSync(temporary, { force: true });
    }
  }
}
