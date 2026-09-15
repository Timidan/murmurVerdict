// ─── AWS KMS as a DigestSigner ──────────────────────────────────────────────
//
// The only file in the daemon that knows what AWS is. It answers the two
// questions kms-account.ts asks and nothing else: what is this key's public
// key, and sign these 32 bytes.
//
// Two details that are easy to get wrong and expensive when they are:
//
//   · MessageType is DIGEST. We hand KMS the keccak hash Ethereum wants
//     signed; asking it to hash again (RAW) would sign SHA-256(keccak(tx)),
//     which recovers to nobody.
//   · Sign with the ARN that GetPublicKey returns, not the alias the operator
//     configured. An alias can be repointed at another key while the daemon
//     runs; the ARN cannot, so the key we resolved the address from is the
//     key we sign with for the life of the process.

import {
  GetPublicKeyCommand,
  KMSClient,
  SignCommand,
} from "@aws-sdk/client-kms";

import type { DigestSigner, KmsSignerFactory } from "./kms-account.js";

/** The subset of KMSClient this file uses, so a smoke can stand one in. */
export interface KmsSendClient {
  send(command: GetPublicKeyCommand | SignCommand): Promise<unknown>;
}

export function createAwsKmsSignerFactory(input: {
  region?: string;
  /** Injected in smokes; built lazily from `region` in the daemon. */
  client?: KmsSendClient;
}): KmsSignerFactory {
  let client: KmsSendClient | null = input.client ?? null;
  const getClient = (): KmsSendClient => {
    if (client) return client;
    if (!input.region) {
      throw new Error("AWS_REGION is required when any *_KMS_KEY_ID is set");
    }
    client = new KMSClient({ region: input.region });
    return client;
  };

  return (keyId: string): DigestSigner => {
    let pinnedArn: string | null = null;
    return {
      async getPublicKeyDer() {
        const out = (await getClient().send(new GetPublicKeyCommand({ KeyId: keyId }))) as {
          KeyId?: string;
          KeySpec?: string;
          KeyUsage?: string;
          PublicKey?: Uint8Array;
        };
        // Refuse anything that is not a secp256k1 signing key before a single
        // signature is attempted: the wrong spec would fail at recovery time
        // with a far less useful error.
        if (out.KeySpec !== "ECC_SECG_P256K1") {
          throw new Error(`KMS key ${keyId} is ${out.KeySpec ?? "unknown"}, not ECC_SECG_P256K1`);
        }
        if (out.KeyUsage !== "SIGN_VERIFY") {
          throw new Error(`KMS key ${keyId} is ${out.KeyUsage ?? "unknown"}, not SIGN_VERIFY`);
        }
        if (!out.PublicKey || !out.KeyId) {
          throw new Error(`KMS key ${keyId}: GetPublicKey returned no key material`);
        }
        pinnedArn = out.KeyId;
        return out.PublicKey;
      },
      async signDigest(digest) {
        if (digest.length !== 32) throw new Error("kms-aws: digest must be 32 bytes");
        const out = (await getClient().send(
          new SignCommand({
            // The ARN we resolved the address from, never the alias.
            KeyId: pinnedArn ?? keyId,
            Message: digest,
            MessageType: "DIGEST",
            SigningAlgorithm: "ECDSA_SHA_256",
          }),
        )) as { Signature?: Uint8Array };
        if (!out.Signature) throw new Error(`KMS key ${keyId}: Sign returned no signature`);
        return out.Signature;
      },
    };
  };
}
