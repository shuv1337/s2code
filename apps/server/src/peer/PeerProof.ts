// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect Crypto does not expose Ed25519 signing.
import * as NodeCrypto from "node:crypto";
import type { EnvironmentId, PeerEnvironmentProof } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { getOrCreateEnvironmentKeyPairFromSecretStore } from "../cloud/environmentKeys.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";

// This key also signs cloud proofs; the prefix prevents cross-protocol signature reuse.
const message = (environmentId: string, nonce: string) =>
  new TextEncoder().encode(`t3-peer-link-proof/v1\n${environmentId}\n${nonce}`);

export const sign = (
  environmentId: EnvironmentId,
  nonce: string,
  keys: { readonly privateKey: string; readonly publicKey: string },
): PeerEnvironmentProof => ({
  environmentId,
  publicKey: keys.publicKey,
  signature: NodeCrypto.sign(null, message(environmentId, nonce), keys.privateKey).toString(
    "base64url",
  ),
});

export const verify = (
  proof: PeerEnvironmentProof,
  nonce: string,
  environmentId: EnvironmentId,
  publicKey: string,
): boolean => {
  if (proof.environmentId !== environmentId || proof.publicKey !== publicKey) return false;
  try {
    const key = NodeCrypto.createPublicKey(publicKey);
    return (
      key.asymmetricKeyType === "ed25519" &&
      NodeCrypto.verify(
        null,
        message(environmentId, nonce),
        key,
        Buffer.from(proof.signature, "base64url"),
      )
    );
  } catch {
    return false;
  }
};

export const create = Effect.fn("PeerProof.create")(function* (nonce: string) {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const keys = yield* getOrCreateEnvironmentKeyPairFromSecretStore(secrets);
  const environmentId = yield* environment.getEnvironmentId;
  return yield* Effect.try(() => sign(environmentId, nonce, keys));
});
