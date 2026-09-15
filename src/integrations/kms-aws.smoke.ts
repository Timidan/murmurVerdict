import { strict as assert } from "node:assert";
import { createPublicKey } from "node:crypto";

import { GetPublicKeyCommand, SignCommand } from "@aws-sdk/client-kms";
import { secp256k1 } from "@noble/curves/secp256k1";
import { recoverMessageAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { toKmsAccount } from "./kms-account.js";
import { createAwsKmsSignerFactory, type KmsSendClient } from "./kms-aws.js";

// The AWS glue, against a stand-in client that behaves like KMS: it answers
// GetPublicKey with SPKI + metadata, and Sign with DER over the exact digest.
// What this pins is the two refusals and the ARN pinning, since a real KMS
// would only reveal those mistakes with money on the line.
process.stdout.write("murmur kms aws smoke\n");

const KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;
const priv = Buffer.from(KEY.slice(2), "hex");
const pub = secp256k1.getPublicKey(priv, false);
const spki = new Uint8Array(
  createPublicKey({
    key: {
      kty: "EC",
      crv: "secp256k1",
      x: Buffer.from(pub.slice(1, 33)).toString("base64url"),
      y: Buffer.from(pub.slice(33, 65)).toString("base64url"),
    },
    format: "jwk",
  }).export({ format: "der", type: "spki" }),
);

function stub(meta: { KeySpec: string; KeyUsage: string }): KmsSendClient & { signedWith: string[] } {
  const signedWith: string[] = [];
  return {
    signedWith,
    async send(command) {
      if (command instanceof GetPublicKeyCommand) {
        return { KeyId: "arn:aws:kms:eu-west-1:1:key/real", PublicKey: spki, ...meta };
      }
      if (command instanceof SignCommand) {
        signedWith.push(String(command.input.KeyId));
        assert.equal(command.input.MessageType, "DIGEST", "never re-hashed by KMS");
        assert.equal(command.input.SigningAlgorithm, "ECDSA_SHA_256");
        return { Signature: secp256k1.sign(command.input.Message as Uint8Array, priv).toDERRawBytes() };
      }
      throw new Error("unexpected command");
    },
  };
}

// Happy path, through the alias the operator configured.
{
  const client = stub({ KeySpec: "ECC_SECG_P256K1", KeyUsage: "SIGN_VERIFY" });
  const account = await toKmsAccount(createAwsKmsSignerFactory({ client })("alias/murmur-relayer"));
  assert.equal(account.address.toLowerCase(), privateKeyToAccount(KEY).address.toLowerCase());
  const sig = await account.signMessage({ message: "hi" });
  const who = await recoverMessageAddress({ message: "hi", signature: sig });
  assert.equal(who.toLowerCase(), account.address.toLowerCase());
  assert.deepEqual(client.signedWith, ["arn:aws:kms:eu-west-1:1:key/real"], "signs with the pinned ARN, not the alias");
}

// The wrong kind of key is refused before any signature is attempted.
await assert.rejects(
  () => toKmsAccount(createAwsKmsSignerFactory({ client: stub({ KeySpec: "RSA_2048", KeyUsage: "SIGN_VERIFY" }) })("k")),
  /not ECC_SECG_P256K1/,
);
await assert.rejects(
  () => toKmsAccount(createAwsKmsSignerFactory({ client: stub({ KeySpec: "ECC_SECG_P256K1", KeyUsage: "ENCRYPT_DECRYPT" }) })("k")),
  /not SIGN_VERIFY/,
);

// No region and no injected client: a clear refusal, not an SDK stack trace.
await assert.rejects(
  () => createAwsKmsSignerFactory({})("k").getPublicKeyDer(),
  /AWS_REGION is required/,
);

process.stdout.write("OK kms aws smoke\n");
