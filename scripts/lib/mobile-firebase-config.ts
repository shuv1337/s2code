// @effect-diagnostics nodeBuiltinImport:off -- Expo build-time materialization of public Firebase app configuration.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { assertFirebaseDestination } from "./mobile-release-identity.ts";

/** Inline verified app JSON wins over worker file variables; never use an FCM private key here. */
export function materializeMobileFirebaseConfig(
  env: Readonly<Record<string, string | undefined>>,
  androidPackage: string,
  directory: string,
) {
  const inline = env.ANDROID_GOOGLE_SERVICES_JSON;
  const file = inline
    ? NodePath.join(directory, "google-services.json")
    : env.ANDROID_GOOGLE_SERVICES_FILE?.trim();
  if (!file)
    throw new Error(
      "ANDROID_GOOGLE_SERVICES_FILE or ANDROID_GOOGLE_SERVICES_JSON is required for enabled Android push.",
    );
  const json = inline ?? NodeFS.readFileSync(file, "utf8");
  assertFirebaseDestination(JSON.parse(json), androidPackage, env.FIREBASE_PROJECT_ID ?? "");
  if (inline) NodeFS.writeFileSync(file, json, { mode: 0o600 });
  return file;
}
