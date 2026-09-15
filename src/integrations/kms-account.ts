// ─── A viem account whose key lives somewhere else ──────────────────────────
//
// Every writer in the daemon signs through a viem `LocalAccount`. Today those
// are built from raw private keys in .env. This builds one from a DigestSigner
// instead: something that can hand us a public key and sign a 32-byte digest,
// and nothing else. A cloud KMS is that thing; so is a fake in a smoke.
//
// The provider boundary is deliberately this narrow. The daemon should not
// know what AWS is; it should know that a signer exists and that the bytes it
// returns recover to the address it claims. Everything Ethereum-specific
// (message prefixes, typed-data hashing, transaction serialization, recovery
// ids) is done HERE, once, with viem's own helpers, so the four writers get
// identical behaviour to the key-backed accounts they replace.
//
// ─── What a KMS signature needs done to it ─────────────────────────────────
//
//   · It arrives DER-encoded. Ethereum wants raw (r, s, v).
//   · It may carry a high s. Ethereum rejects those (EIP-2); normalise to
//     s = min(s, n - s).
//   · It has no recovery id. Try both parities against the KNOWN public key
//     and keep the one that recovers; refuse if neither does, because a
//     signature we cannot attribute to our own key is not ours to broadcast.
//   · The digest goes to the signer AS the digest. Hashing it again (which a
//     "sign this message" API would do) signs the wrong thing.

import { createPublicKey } from "node:crypto";

import { secp256k1 } from "@noble/curves/secp256k1";
import {
  hashMessage,
  hashTypedData,
  keccak256,
  parseSignature,
  serializeSignature,
  serializeTransaction,
  toHex,
  type CustomSource,
  type Hex,
  type LocalAccount,
  type NonceManager,
} from "viem";
import { nonceManager } from "viem";
import { privateKeyToAccount, toAccount } from "viem/accounts";

export interface DigestSigner {
  /** The secp256k1 public key, DER-encoded SubjectPublicKeyInfo. */
  getPublicKeyDer(): Promise<Uint8Array>;
  /** A DER-encoded ECDSA signature over exactly these 32 bytes. No re-hashing. */
  signDigest(digest: Uint8Array): Promise<Uint8Array>;
}

/**
 * Resolve the key once, then return an account that signs through it.
 *
 * Async because the address comes from the signer, not from a key we hold.
 * Everything downstream that compares addresses (the boot guards) awaits this
 * before it runs.
 */
export async function toKmsAccount(
  signer: DigestSigner,
  opts: { nonceManager?: NonceManager } = {},
): Promise<LocalAccount> {
  const publicKey = uncompressedFromSpki(await signer.getPublicKeyDer());
  // Address is the last 20 bytes of keccak(pubkey without the 0x04 prefix).
  const address = `0x${keccak256(publicKey.slice(1)).slice(-40)}` as Hex;

  const sign = async ({ hash }: { hash: Hex }): Promise<Hex> => {
    const digest = hexToBytes32(hash);
    let sig = secp256k1.Signature.fromDER(await signer.signDigest(digest));
    if (sig.hasHighS()) sig = sig.normalizeS();
    // Recovery AFTER normalisation: flipping s flips which parity recovers.
    for (const recovery of [0, 1] as const) {
      const candidate = sig.addRecoveryBit(recovery);
      let recovered: Uint8Array;
      try {
        recovered = candidate.recoverPublicKey(digest).toRawBytes(false);
      } catch {
        continue;
      }
      if (bytesEqual(recovered, publicKey)) {
        return serializeSignature({
          r: toHex(sig.r, { size: 32 }),
          s: toHex(sig.s, { size: 32 }),
          yParity: recovery,
        });
      }
    }
    throw new Error(
      `kms-account: signature from the signer does not recover to ${address}; refusing to use it`,
    );
  };

  // No signAuthorization: EIP-7702 is not something any murmur writer does,
  // and an account that cannot sign one fails closed rather than quietly.
  const source: CustomSource = {
    address,
    nonceManager: opts.nonceManager,
    sign,
    signMessage: ({ message }) => sign({ hash: hashMessage(message) }),
    signTypedData: (typedData) => sign({ hash: hashTypedData(typedData) }),
    // Mirrors viem's own signTransaction: hash the serialized unsigned tx
    // (EIP-4844 without sidecars), sign, then serialize again with the
    // signature attached.
    signTransaction: async (transaction, { serializer = serializeTransaction } = {}) => {
      const signable =
        transaction.type === "eip4844" ? { ...transaction, sidecars: false } : transaction;
      const hex = await sign({ hash: keccak256(await serializer(signable)) });
      return serializer(transaction, parseSignature(hex));
    },
  };
  return toAccount(source);
}

/** SPKI DER → 65-byte uncompressed point, via Node's own parser. No hand ASN.1. */
function uncompressedFromSpki(der: Uint8Array): Uint8Array {
  const jwk = createPublicKey({ key: Buffer.from(der), format: "der", type: "spki" }).export({
    format: "jwk",
  }) as { kty?: string; crv?: string; x?: string; y?: string };
  if (jwk.kty !== "EC" || jwk.crv !== "secp256k1" || !jwk.x || !jwk.y) {
    throw new Error(`kms-account: public key is not secp256k1 (got ${jwk.kty}/${jwk.crv})`);
  }
  const x = Buffer.from(jwk.x, "base64url");
  const y = Buffer.from(jwk.y, "base64url");
  if (x.length !== 32 || y.length !== 32) {
    throw new Error("kms-account: public key coordinates are not 32 bytes");
  }
  return new Uint8Array([0x04, ...x, ...y]);
}

function hexToBytes32(hash: Hex): Uint8Array {
  const clean = hash.slice(2);
  if (clean.length !== 64) throw new Error(`kms-account: digest must be 32 bytes, got ${clean.length / 2}`);
  return Uint8Array.from(Buffer.from(clean, "hex"));
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

/* ── The daemon's four signers ─────────────────────────────────────────────── */

/** One optional account per writer lane. Absent = that lane still uses a raw key. */
export interface DaemonSigners {
  relayer?: LocalAccount;
  grantor?: LocalAccount;
  reveal?: LocalAccount;
  payout?: LocalAccount;
}

/** Builds a DigestSigner for a KMS key id. The AWS implementation is injected. */
export type KmsSignerFactory = (keyId: string) => DigestSigner;

export const KMS_KEY_ID_VARS = {
  relayer: "FHENIX_GATEWAY_RELAYER_KMS_KEY_ID",
  grantor: "FHENIX_GRANT_KMS_KEY_ID",
  reveal: "FHENIX_REVEAL_KMS_KEY_ID",
  payout: "MURMUR_PAYOUT_KMS_KEY_ID",
} as const;

/** The raw-key variable each lane falls back to, for the distinctness check. */
const RAW_KEY_VARS = {
  relayer: "FHENIX_GATEWAY_RELAYER_PRIVATE_KEY",
  grantor: "FHENIX_GRANT_PRIVATE_KEY",
  reveal: "FHENIX_REVEAL_PRIVATE_KEY",
  payout: "MURMUR_PAYOUT_PRIVATE_KEY",
} as const;

/**
 * Resolve every lane that names a KMS key. Awaited ONCE at daemon start,
 * before the synchronous config loaders run, so their address comparisons see
 * real addresses.
 *
 * Relayer, grantor and reveal get viem's shared nonce manager, exactly as the
 * key-backed accounts they replace (it is keyed by address, so sharing the
 * singleton is what keeps each wallet's lane coherent). Payout gets NONE: its
 * nonces come from the withdrawal outbox so they survive a restart.
 */
export async function resolveDaemonSigners(
  env: NodeJS.ProcessEnv,
  makeSigner: KmsSignerFactory | null,
): Promise<DaemonSigners> {
  const out: DaemonSigners = {};
  for (const lane of ["relayer", "grantor", "reveal", "payout"] as const) {
    const keyId = (env[KMS_KEY_ID_VARS[lane]] ?? "").trim();
    if (!keyId) continue;
    if (!makeSigner) {
      throw new Error(
        `${KMS_KEY_ID_VARS[lane]} is set but this build has no KMS signer wired in`,
      );
    }
    out[lane] = await toKmsAccount(
      makeSigner(keyId),
      lane === "payout" ? {} : { nonceManager },
    );
  }
  return out;
}

/**
 * No two lanes on one wallet. The one rule that keeps four independent nonce
 * allocators from racing each other, checked by ADDRESS so it holds across
 * KMS-backed and raw-key lanes alike, and across a key pasted under two names.
 */
export function assertDistinctSigners(signers: DaemonSigners, env: NodeJS.ProcessEnv): void {
  const seen = new Map<string, string>();
  for (const lane of ["relayer", "grantor", "reveal", "payout"] as const) {
    let address: string | null = signers[lane]?.address.toLowerCase() ?? null;
    if (!address) {
      const raw = (env[RAW_KEY_VARS[lane]] ?? "").trim();
      if (/^0x[0-9a-fA-F]{64}$/.test(raw)) {
        address = privateKeyToAccount(raw as Hex).address.toLowerCase();
      }
    }
    if (!address) continue;
    const prior = seen.get(address);
    if (prior) {
      throw new Error(
        `signer for ${lane} is the same wallet as ${prior} (${address}). Every writer lane needs its own wallet: two nonce allocators on one address race each other.`,
      );
    }
    seen.set(address, lane);
  }
}
