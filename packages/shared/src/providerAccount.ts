import { sha256 } from "@noble/hashes/sha2";
import type { ServerProvider } from "@t3tools/contracts";
import * as Hex from "effect/encoding/Hex";

/**
 * An opaque key for the account an instance is signed in to. Every environment derives the same
 * key for the same account, whatever its instance ids. The email is not sent as text, but the key
 * is an unsalted hash, so anyone who guesses the email can confirm it.
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
