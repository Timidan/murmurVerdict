import type Database from "better-sqlite3";

import { prep } from "../db-statements.js";

/**
 * Where a ciphertext handle has been seen before, if anywhere.
 *
 * CoFHE input proofs bind the relayer and the contract, not the agent, market,
 * feed, or path — so a handle pair lifted from another submission's public
 * calldata verifies on-chain under any agent. The chain cannot tell a copy
 * from an original; this lookup can. It spans every pool a handle lands in:
 * gateway attempts on both paths (queued rows now carry the hashes at insert)
 * and the chain-ingested calls/packets.
 *
 * `exceptAgentId` skips the submitting agent's own ATTEMPT rows so a retry
 * under a fresh client_order_id keeps working. Chain-ingested rows are never
 * excepted: once a handle is on-chain, resubmitting it is a replay even for
 * its own author.
 */
export interface EncryptedInputReuse {
  pool:
    | "gateway_call_attempt"
    | "gateway_feed_packet_attempt"
    | "sealed_call"
    | "feed_packet";
  ref: string;
}

export function findEncryptedInputReuse(
  db: Database.Database,
  input: {
    ctHashes: readonly string[];
    exceptAgentId: string;
  },
): EncryptedInputReuse | null {
  const [a, b] = input.ctHashes;
  const withAgent = { a, b, agent_id: input.exceptAgentId };
  const hashesOnly = { a, b };

  const callAttempt = prep(
    db,
    `SELECT attempt_id AS ref FROM fhenix_gateway_tx_attempts
      WHERE (binary_index_ct_hash IN (@a, @b) OR confidence_ct_hash IN (@a, @b))
        AND agent_id != @agent_id
      LIMIT 1`,
  ).get(withAgent) as { ref: string } | undefined;
  if (callAttempt) return { pool: "gateway_call_attempt", ref: callAttempt.ref };

  const feedAttempt = prep(
    db,
    `SELECT attempt_id AS ref FROM fhenix_gateway_feed_packet_tx_attempts
      WHERE (action_ct_hash IN (@a, @b) OR signal_ct_hash IN (@a, @b))
        AND agent_id != @agent_id
      LIMIT 1`,
  ).get(withAgent) as { ref: string } | undefined;
  if (feedAttempt) return { pool: "gateway_feed_packet_attempt", ref: feedAttempt.ref };

  const sealedCall = prep(
    db,
    `SELECT call_id AS ref FROM fhenix_sealed_calls
      WHERE binary_index_ct_hash IN (@a, @b) OR confidence_ct_hash IN (@a, @b)
      LIMIT 1`,
  ).get(hashesOnly) as { ref: string } | undefined;
  if (sealedCall) return { pool: "sealed_call", ref: sealedCall.ref };

  const feedPacket = prep(
    db,
    `SELECT packet_id AS ref FROM feed_packets
      WHERE packet_ct_hash IN (@a, @b)
         OR binary_index_ct_hash IN (@a, @b)
         OR confidence_ct_hash IN (@a, @b)
      LIMIT 1`,
  ).get(hashesOnly) as { ref: string } | undefined;
  if (feedPacket) return { pool: "feed_packet", ref: feedPacket.ref };

  return null;
}
