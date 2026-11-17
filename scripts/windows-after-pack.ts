// @effect-diagnostics nodeBuiltinImport:off -- Inspect the final Windows payload before installer creation.
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import { signWindowsFile, windowsPeFiles } from "./lib/windows-stage-signing.ts";
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";

interface AfterPackContext {
  readonly appOutDir: string;
  readonly electronPlatformName: string;
  readonly packager: { readonly projectDir: string };
}

const prepareServerCompileCache: (context: AfterPackContext) => Promise<void> =
  NodeModule.createRequire(import.meta.url)("./prepare-server-compile-cache.cjs");

/** Copy after builder's extra-resource transformer to preserve pre-signed ASAR size/integrity metadata. */
export async function copySignedWindowsSidecar(context: AfterPackContext): Promise<void> {
  const source = NodePath.join(
    context.packager.projectDir,
    "apps/desktop/prod-resources/windows-server",
  );
  // Fail closed on any symlink before copying the immutable signed stage.
  await windowsPeFiles(source);
  const destination = NodePath.join(context.appOutDir, "resources");
  for (const name of ["server.asar", "server.asar.unpacked"]) {
    await NodeFSP.cp(NodePath.join(source, name), NodePath.join(destination, name), {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
  }
}

/** Builder owns app.asar.unpacked. The server sidecar was signed before its ASAR metadata was built. */
export async function signWindowsExtraResources(
  context: Pick<AfterPackContext, "appOutDir" | "electronPlatformName">,
  signFile: (file: string) => Promise<void> = (file) =>
    signWindowsFile(file).pipe(
      Effect.scoped,
      Effect.provide(NodeServices.layer),
      Effect.runPromise,
    ),
): Promise<void> {
  if (context.electronPlatformName !== "win32") {
    throw new Error("Windows resource signing hook must only run for a signed Windows build.");
  }
  const files = await windowsPeFiles(NodePath.join(context.appOutDir, "resources"), [
    "app.asar.unpacked",
    "server.asar.unpacked",
  ]);
  for (const file of files) await signFile(file);
}

export default async function afterPack(context: AfterPackContext): Promise<void> {
  await copySignedWindowsSidecar(context);
  await prepareServerCompileCache(context);
  await signWindowsExtraResources(context);
}
