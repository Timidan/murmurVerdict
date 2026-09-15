import { strict as assert } from "node:assert";
import { createPublicKey } from "node:crypto";

import { secp256k1 } from "@noble/curves/secp256k1";
import {
  parseSignature,
  recoverMessageAddress,
  recoverTransactionAddress,
  recoverTypedDataAddress,
  parseGwei,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import {
  assertDistinctSigners,
  resolveDaemonSigners,
  toKmsAccount,
  type DigestSigner,
} from "./kms-account.js";

// ─── A KMS-shaped signer, checked without a KMS ─────────────────────────────
//
// The fake below does exactly what AWS KMS does with ECDSA_SHA_256 + DIGEST:
// returns a DER signature over the bytes it was given. It is also made
// adversarial in the one way that matters: it FORCES a high s on every
// signature, so the adapter's normalisation and post-normalisation recovery
// are exercised on every call rather than by luck.
process.stdout.write("murmur kms account smoke\n");

const KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex; // anvil #0
const expected = privateKeyToAccount(KEY);
const N = secp256k1.CURVE.n;

function fakeKms(privHex: Hex, opts: { forceHighS: boolean; lieAboutKey?: Hex } = { forceHighS: true }): DigestSigner {
  const priv = Buffer.from(privHex.slice(2), "hex");
  const pubOf = (k: Buffer) => secp256k1.getPublicKey(k, false);
  const pub = pubOf(opts.lieAboutKey ? Buffer.from(opts.lieAboutKey.slice(2), "hex") : priv);
  return {
    async getPublicKeyDer() {
      // Build SPKI the way a real HSM would hand it back.
      const x = Buffer.from(pub.slice(1, 33)).toString("base64url");
      const y = Buffer.from(pub.slice(33, 65)).toString("base64url");
      return new Uint8Array(
        createPublicKey({ key: { kty: "EC", crv: "secp256k1", x, y }, format: "jwk" }).export({
          format: "der",
          type: "spki",
        }),
      );
    },
    async signDigest(digest) {
      let sig: ReturnType<typeof secp256k1.Signature.fromDER> = secp256k1.sign(digest, priv, {
        lowS: false,
      });
      if (opts.forceHighS && !sig.hasHighS()) {
        sig = new secp256k1.Signature(sig.r, N - sig.s);
      }
      return sig.toDERRawBytes();
    },
  };
}

const account = await toKmsAccount(fakeKms(KEY));
assert.equal(account.address.toLowerCase(), expected.address.toLowerCase(), "address derived from the SPKI");
assert.equal(account.type, "local");

// signMessage
{
  const sig = await account.signMessage({ message: "murmur" });
  const { s } = parseSignature(sig);
  assert.ok(BigInt(s) <= N / 2n, "s is normalised low");
  const who = await recoverMessageAddress({ message: "murmur", signature: sig });
  assert.equal(who.toLowerCase(), expected.address.toLowerCase(), "recovers to our key after normalisation");
}

// signTypedData — this is the path the CoFHE permit goes down.
{
  const typed = {
    domain: { name: "murmur", version: "1", chainId: 84532 },
    types: { Accept: [{ name: "entitlement", type: "uint256" }] },
    primaryType: "Accept",
    message: { entitlement: 7n },
  } as const;
  const sig = await account.signTypedData(typed);
  const who = await recoverTypedDataAddress({ ...typed, signature: sig });
  assert.equal(who.toLowerCase(), expected.address.toLowerCase());
}

// signTransaction — an EIP-1559 transfer like the payout worker sends.
{
  const raw = await account.signTransaction({
    chainId: 84532,
    to: "0x2222222222222222222222222222222222222222",
    value: 0n,
    nonce: 3,
    gas: 21_000n,
    maxFeePerGas: parseGwei("1"),
    maxPriorityFeePerGas: parseGwei("1"),
    type: "eip1559",
  });
  const who = await recoverTransactionAddress({ serializedTransaction: raw as `0x02${string}` });
  assert.equal(who.toLowerCase(), expected.address.toLowerCase(), "the serialized tx recovers to our key");
}

// Determinism of the bytes is NOT required (KMS is not RFC6979), but every
// signature must recover. Run a handful to catch a parity-flip bug that only
// shows on some digests.
for (let i = 0; i < 8; i += 1) {
  const sig = await account.signMessage({ message: `round ${i}` });
  const who = await recoverMessageAddress({ message: `round ${i}`, signature: sig });
  assert.equal(who.toLowerCase(), expected.address.toLowerCase(), `round ${i}`);
}

// A signer whose signatures do not match the key it CLAIMS is refused, never
// broadcast. This is the "KMS alias points at the wrong key" failure.
{
  const liar = await toKmsAccount(
    fakeKms(KEY, { forceHighS: false, lieAboutKey: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" }),
  );
  await assert.rejects(
    () => liar.signMessage({ message: "x" }),
    /does not recover/,
    "a signature we cannot attribute to our own key is not ours to use",
  );
}

// A non-32-byte digest is rejected before it reaches the signer.
await assert.rejects(() => account.sign!({ hash: "0x1234" as Hex }), /32 bytes/);

// ─── The daemon's four lanes ───────────────────────────────────────────────

const KEY_B = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as Hex; // anvil #1
const byId: Record<string, Hex> = { "kms:a": KEY, "kms:b": KEY_B };
const factory = (keyId: string) => fakeKms(byId[keyId]!, { forceHighS: false });

// Only lanes that name a KMS id are resolved; the rest stay on raw keys.
{
  const signers = await resolveDaemonSigners(
    { FHENIX_GATEWAY_RELAYER_KMS_KEY_ID: "kms:a", MURMUR_PAYOUT_KMS_KEY_ID: "kms:b" },
    factory,
  );
  assert.equal(signers.relayer?.address.toLowerCase(), expected.address.toLowerCase());
  assert.ok(signers.payout, "payout resolved");
  assert.equal(signers.grantor, undefined);
  assert.ok(signers.relayer?.nonceManager, "writer lanes carry the shared nonce manager");
  assert.equal(signers.payout?.nonceManager, undefined, "payout owns its nonces in the outbox");
}

// A KMS id with no signer wired is a refusal, not a silent raw-key fallback.
await assert.rejects(
  () => resolveDaemonSigners({ FHENIX_GRANT_KMS_KEY_ID: "kms:b" }, null),
  /no KMS signer wired/,
);

// No two lanes on one wallet, whether KMS-backed, raw, or one of each.
{
  const a = await toKmsAccount(factory("kms:a"));
  const b = await toKmsAccount(factory("kms:b"));
  assert.doesNotThrow(() => assertDistinctSigners({ relayer: a, payout: b }, {}));
  assert.throws(
    () => assertDistinctSigners({ relayer: a, payout: a }, {}),
    /payout is the same wallet as relayer/,
  );
  // A raw grantor key that is wallet A collides with the KMS-backed relayer A.
  assert.throws(
    () => assertDistinctSigners({ relayer: a }, { FHENIX_GRANT_PRIVATE_KEY: KEY }),
    /grantor is the same wallet as relayer/,
    "mixed raw/KMS lanes are compared by address too",
  );
}

process.stdout.write("OK kms account smoke\n");
