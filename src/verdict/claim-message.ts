/**
 * Canonical claim message — what an agent's wallet signs to prove control.
 *
 * Earlier the daemon verified signatures over `nonce` only, even though
 * `challenge_text` already carried richer context. That left the
 * signature open to a few subtle replay vectors:
 *   - same nonce reused across slugs / agents (extremely unlikely with
 *     16-byte randomness, but trivially exploitable if it ever collides)
 *   - cross-environment replay (sign once in dev, replay in prod)
 *   - cross-claim replay across different challenge_ids
 *
 * The fix: signatures bind ALL of (origin, slug, agent_id, challenge_id,
 * wallet, nonce, expires_at). Same data on both sides; if any single
 * field disagrees the signature won't verify. Domain-bound by construction.
 *
 * Format is human-readable so it can be displayed in MetaMask /
 * WalletConnect modals; it's also stable so older signatures can still
 * verify if we ever need to replay them. Field order is fixed.
 */

export interface ClaimMessageInput {
  origin: string; // e.g. "https://murmur-verdict.onrender.com"
  display_slug: string;
  agent_id: string;
  challenge_id: string;
  wallet: string; // lowercase 0x + 40 hex
  nonce: string;
  expires_at: string;
}

export const CLAIM_MESSAGE_VERSION = "1";

export function buildClaimMessage(input: ClaimMessageInput): string {
  // Lines are sorted into a stable order regardless of input field order.
  // Trailing newline omitted so the message is byte-stable.
  const fields: Array<[string, string]> = [
    ["v", CLAIM_MESSAGE_VERSION],
    ["origin", input.origin],
    ["slug", input.display_slug],
    ["agent_id", input.agent_id],
    ["challenge_id", input.challenge_id],
    ["wallet", input.wallet.toLowerCase()],
    ["nonce", input.nonce],
    ["expires_at", input.expires_at],
  ];
  const body = fields.map(([k, v]) => `${k}=${v}`).join("\n");
  return `Murmur Verdict claim — sign to prove wallet control.\n\n${body}`;
}
