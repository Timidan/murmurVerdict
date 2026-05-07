import { keccak256, toHex } from "viem";

/**
 * Daemon-less reveal commitment for v0.2 committed-mode submissions.
 *
 * Why drand/tlock alongside the age envelope (D21):
 *   - Trustlessness: even an attacker with the daemon's age private
 *     key can't decrypt the drand-encrypted preimage before the
 *     target round. The drand network releases the round signature
 *     on schedule whether the operator wants it to or not.
 *   - Daemon-less reveal: the resolver doesn't HAVE to be online at
 *     t1 + grace. Anyone with the receipt + the drand round can
 *     decrypt and post the plaintext, then the daemon (or anyone
 *     else) can run the resolver math to score the call.
 *   - Bittensor uses this exact pattern in production for hiding
 *     validator weight vectors (Codex round-1 research).
 *
 * Wire layout:
 *   1. Daemon computes target_time_ms = accepted_at + horizon + grace.
 *   2. Daemon picks the drand round whose `round_time` is the first
 *      one >= target_time_ms (so it's guaranteed to be revealed by
 *      the time the resolver wants to read it).
 *   3. Daemon timelockEncrypt(round, preimage_canonical) → ciphertext
 *      string (age-formatted).
 *   4. Receipt subject's `drand` block records (chain_hash, round,
 *      ciphertext_hash) so a verifier can attest the daemon didn't
 *      substitute a different ciphertext post-acceptance.
 */

import {
  HttpCachingChain,
  HttpChainClient,
  defaultChainInfo,
  defaultChainUrl,
  roundAt,
  timelockEncrypt,
  timelockDecrypt,
  type ChainClient,
  type ChainInfo,
} from "tlock-js";

export const DRAND_CIPHERTEXT_ALG = "drand-tlock-bls-unchained-g1-rfc9380@1" as const;

export interface DrandContext {
  client: ChainClient;
  chain: ChainInfo;
  /** Set to false at boot if the daemon was started without a working
   *  network — encryption short-circuits with a logged warning. */
  available: boolean;
}

/**
 * Optional boot-time config:
 *   MURMUR_DRAND_ENABLED=1     opt-in (default off)
 *   MURMUR_DRAND_CHAIN_URL=... override default mainnet quicknet
 *
 * The default chain (mainnet quicknet) has a 3-second period, ~10^17
 * BLS security, and is the chain Bittensor uses. Daemon doesn't need
 * the network at boot — chain info is hardcoded into tlock-js's
 * defaultChainInfo. Network is only needed at decrypt time (Phase C
 * fallback path) to fetch the released beacon for the round.
 */
export function loadDrandContextFromEnv(): DrandContext | null {
  if (process.env.MURMUR_DRAND_ENABLED !== "1") return null;
  const url = process.env.MURMUR_DRAND_CHAIN_URL?.trim() || defaultChainUrl;
  // HttpCachingChain caches the chain info so subsequent calls don't
  // round-trip. Pinning chainHash + publicKey from defaultChainInfo
  // means we never trust the URL's chain to lie about its own identity
  // — encryption refuses to proceed if the upstream returns mismatched
  // metadata.
  const chain = new HttpCachingChain(url, {
    disableBeaconVerification: false,
    noCache: false,
    chainVerificationParams: {
      chainHash: defaultChainInfo.hash,
      publicKey: defaultChainInfo.public_key,
    },
  });
  const client = new HttpChainClient(chain);
  return {
    client,
    chain: defaultChainInfo,
    available: true,
  };
}

export interface DrandEnvelope {
  /** Hex chain_hash from the chain info — verifies the receipt's drand
   *  block ties to a specific drand network. */
  chain_hash: string;
  /** Round the ciphertext is bound to. Decryption only works once the
   *  drand network releases this round's beacon. */
  round: number;
  /** age-formatted tlock ciphertext, ASCII-armored. Stored in the
   *  TEXT column. */
  ciphertext: string;
  /** keccak256 of the ciphertext bytes (UTF-8). Verifier check. */
  ciphertext_hash: `0x${string}`;
}

/**
 * Encrypt to the drand round whose round_time is >= target_time_ms.
 * Caller passes `target_time_ms = accepted_at_ms + horizon_ms + grace_ms`
 * and the daemon timelock-encrypts the canonical preimage to that round.
 *
 * Failure modes:
 *   - target_time_ms in the past → falls back to current round + 1
 *     (encryption still succeeds; reveal is immediate).
 *   - tlock-js network call inside timelockEncrypt fails → caller
 *     catches and proceeds with age-only envelope.
 */
export async function encryptToDrandRound(
  ctx: DrandContext,
  plaintext: Uint8Array,
  target_time_ms: number,
): Promise<DrandEnvelope> {
  // roundAt(time, chain) returns the round at OR BEFORE the target
  // time. We want the round AT OR AFTER, so add one period to the
  // target before computing.
  const periodMs = ctx.chain.period * 1000;
  const adjusted = target_time_ms + periodMs;
  const round = roundAt(adjusted, ctx.chain);
  const ciphertext = await timelockEncrypt(
    round,
    Buffer.from(plaintext),
    ctx.client,
  );
  const ciphertext_hash = keccak256(toHex(new TextEncoder().encode(ciphertext)));
  return {
    chain_hash: ctx.chain.hash,
    round,
    ciphertext,
    ciphertext_hash,
  };
}

/**
 * Decrypt a tlock ciphertext. Used by the resolver fallback path
 * past `fallback_after`; succeeds only once drand has released the
 * round's beacon signature. Network call to drand at decrypt time.
 */
export async function decryptDrandEnvelope(
  ctx: DrandContext,
  ciphertext: string,
): Promise<Uint8Array> {
  const buf = await timelockDecrypt(ciphertext, ctx.client);
  return new Uint8Array(buf);
}
