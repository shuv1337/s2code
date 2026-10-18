// @effect-diagnostics-next-line nodeBuiltinImport:off -- Tests exercise real Ed25519 signatures.
import * as NodeCrypto from "node:crypto";
import { EnvironmentId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import * as PeerProof from "./PeerProof.ts";

const keys = () =>
  NodeCrypto.generateKeyPairSync("ed25519", {
    privateKeyEncoding: { format: "pem", type: "pkcs8" },
    publicKeyEncoding: { format: "pem", type: "spki" },
  });

it("binds the signature to the nonce, environment, key and protocol", () => {
  const pair = keys();
  const id = EnvironmentId.make("environment-box");
  const nonce = NodeCrypto.randomBytes(32).toString("base64url");
  const proof = PeerProof.sign(id, nonce, pair);
  expect(PeerProof.verify(proof, nonce, id, pair.publicKey)).toBe(true);
  expect(
    PeerProof.verify(proof, NodeCrypto.randomBytes(32).toString("base64url"), id, pair.publicKey),
  ).toBe(false);
  expect(PeerProof.verify(proof, nonce, EnvironmentId.make("other"), pair.publicKey)).toBe(false);
  expect(PeerProof.verify(proof, nonce, id, keys().publicKey)).toBe(false);
  expect(PeerProof.verify({ ...proof, publicKey: "invalid" }, nonce, id, "invalid")).toBe(false);
  const signature = NodeCrypto.sign(null, Buffer.from(`${id}\n${nonce}`), pair.privateKey).toString(
    "base64url",
  );
  expect(PeerProof.verify({ ...proof, signature }, nonce, id, pair.publicKey)).toBe(false);
});
