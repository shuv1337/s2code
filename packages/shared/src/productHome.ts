// @effect-diagnostics nodeBuiltinImport:off - Ownership is checked before either Node or Effect startup opens state.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import { DEFAULT_HOME_DIRECTORY, PRODUCT_HOME_MARKER, PRODUCT_ID } from "./productIdentity.ts";

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
      "Refusing an upstream .t3 home. Choose a separate SHUV2CODE_HOME; upstream import is not supported.",
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
  try {
    if (NodeFS.readFileSync(marker, "utf8").trim() !== PRODUCT_ID)
      throw new Error(`Home ${directory} belongs to another product.`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const entries = NodeFS.existsSync(canonical) ? NodeFS.readdirSync(canonical) : [];
    const defaultHome =
      canonical === NodePath.join(canonicalProductPath(NodeOS.homedir()), DEFAULT_HOME_DIRECTORY);
    if (entries.length && !defaultHome && !developmentHome) {
      throw new Error(
        `Cannot establish product ownership of ${directory}. Choose an empty SHUV2CODE_HOME. For an existing fork installation, verify it offline before adding ${PRODUCT_HOME_MARKER} containing ${PRODUCT_ID}; this is not an upstream import.`,
        { cause: error },
      );
    }
    if (claim) {
      NodeFS.mkdirSync(canonical, { recursive: true });
      try {
        NodeFS.writeFileSync(marker, `${PRODUCT_ID}\n`, { flag: "wx" });
      } catch (writeError) {
        if (
          (writeError as NodeJS.ErrnoException).code !== "EEXIST" ||
          NodeFS.readFileSync(marker, "utf8").trim() !== PRODUCT_ID
        )
          throw writeError;
      }
    }
  }
}
