import { Encrypter, Decrypter } from "age-encryption";
import { keccak256, toHex } from "viem";

/**
 * Daemon-held age-x25519 envelope for v0.2 committed-mode call bodies.
 *
 * Why age (D19): well-audited format authored by the original age author
 * (FiloSottile), first-party JS, no shell-out, supports multiple
 * recipients (lets us escrow a recovery identity off-disk), and binds
 * to the v0.3 fhEVM port through a string `encrypted_body_alg` tag —
 * v0.3 introduces 'fhevm-euint' alongside, no schema migration needed.
 *
 * The encryption recipient is the daemon's PUBLIC age recipient
 * (`age1...`). The matching identity (`AGE-SECRET-KEY-1...`) is held
 * in env at boot for fallback decrypt past `fallback_after`. v0.2
 * stores the identity in `MURMUR_DAEMON_AGE_IDENTITY`; v0.3 (Phase G)
 * moves to KMS; the `daemon_key_id` field carries the rotation
 * generation so an envelope encrypted under key gen 1 stays decryptable
 * after gen 2 takes over.
 */

export const AGE_ENVELOPE_ALG = "age-x25519-v1" as const;

export interface AgeContext {
  /** age1… public recipient. Used to encrypt new envelopes. */
  recipient: string;
  /**
   * Identifier carried alongside every envelope. Lets a rotation drill
   * decrypt envelopes from older keys without bringing the older private
   * key online. Format is "age:<short-hex>" derived from the recipient.
   */
  daemon_key_id: string;
  /**
   * Identity (private key) for fallback decrypt. Loaded from env at
   * boot. Optional — if absent, encrypts still work but daemon
   * fallback decrypt is disabled. The agent's voluntary reveal path
   * is unaffected.
   */
  identity?: string;
}

/**
 * Pull recipient + optional identity from env. Boot-time call. Returns
 * null if no recipient configured (committed-mode submissions then
 * fail with a clear error rather than silently writing un-encryptable
 * envelopes).
 *
 * MURMUR_DAEMON_AGE_RECIPIENT — required for committed mode
 * MURMUR_DAEMON_AGE_IDENTITY  — required for daemon fallback decrypt;
 *                               optional otherwise
 */
export function loadAgeContextFromEnv(): AgeContext | null {
  const recipient = process.env.MURMUR_DAEMON_AGE_RECIPIENT?.trim();
  if (!recipient) return null;
  const identity = process.env.MURMUR_DAEMON_AGE_IDENTITY?.trim() || undefined;
  // daemon_key_id = first 16 hex of keccak256(recipient). Stable across
  // restarts as long as the recipient string hasn't changed; rotates
  // automatically when the operator swaps to a new recipient.
  const fingerprintHex = keccak256(toHex(recipient)).slice(2, 18);
  const ctx: AgeContext = {
    recipient,
    daemon_key_id: `age:${fingerprintHex}`,
  };
  if (identity) ctx.identity = identity;
  return ctx;
}

export interface EncryptedEnvelope {
  /** Base64-encoded age binary ciphertext. Stored in the TEXT column. */
  ciphertext_base64: string;
  /** keccak256 of the raw ciphertext bytes. Surfaced on receipts as
   *  `fallback.encrypted_body_hash` so a verifier can attest the daemon
   *  didn't substitute a different ciphertext post-acceptance. */
  encrypted_body_hash: `0x${string}`;
  /** "age-x25519-v1" today; v0.3 may add 'fhevm-euint' as a sibling. */
  alg: string;
  /** Generation tag — see AgeContext.daemon_key_id. */
  daemon_key_id: string;
}

/**
 * Encrypt a plaintext byte string to the daemon's recipient. Returns
 * the ciphertext + metadata to persist on call_private_envelopes.
 *
 * Caller is responsible for canonicalizing the plaintext if it's
 * structured (e.g. canonicalize the commit preimage JSON before
 * passing in). Encryption itself is byte-deterministic only at the
 * payload level — age uses random nonces internally.
 */
export async function encryptEnvelope(
  ctx: AgeContext,
  plaintext: Uint8Array,
): Promise<EncryptedEnvelope> {
  const enc = new Encrypter();
  enc.addRecipient(ctx.recipient);
  const ciphertext = await enc.encrypt(plaintext);
  return {
    ciphertext_base64: Buffer.from(ciphertext).toString("base64"),
    encrypted_body_hash: keccak256(ciphertext),
    alg: AGE_ENVELOPE_ALG,
    daemon_key_id: ctx.daemon_key_id,
  };
}

/**
 * Decrypt an envelope using the daemon's identity. Used by the
 * resolver fallback path past `fallback_after` if the agent failed to
 * reveal voluntarily. Throws if the identity is missing or the
 * ciphertext doesn't decrypt under it (e.g. encrypted to a rotated
 * recipient the operator no longer holds).
 */
export async function decryptEnvelope(
  ctx: AgeContext,
  ciphertext_base64: string,
): Promise<Uint8Array> {
  if (!ctx.identity) {
    throw new Error(
      "daemon age identity not configured; cannot decrypt fallback envelope",
    );
  }
  const dec = new Decrypter();
  dec.addIdentity(ctx.identity);
  const ciphertext = Buffer.from(ciphertext_base64, "base64");
  return dec.decrypt(ciphertext);
}
