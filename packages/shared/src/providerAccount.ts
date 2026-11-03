import { sha256 } from "@noble/hashes/sha2";
import type { ServerProvider } from "@t3tools/contracts";
import * as Hex from "effect/encoding/Hex";

/**
 * An opaque key for the account an instance is signed in to. Every environment derives the same
 * key for the same account, whatever its instance ids, and the email itself never leaves here.
 */
export const providerAccountKey = (
  provider: Pick<ServerProvider, "driver" | "auth">,
): string | undefined => {
  const email = provider.auth.email?.trim().toLowerCase();
  if (provider.auth.status !== "authenticated" || !email) return undefined;
  const identity = [
    "t3-provider-account/v1",
    provider.driver,
    email,
    provider.auth.workspaceId ?? "",
  ].join("\n");
  return Hex.encode(sha256(new TextEncoder().encode(identity)));
};
