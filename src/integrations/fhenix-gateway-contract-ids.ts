/**
 * Murmur Gateway deterministic contract-id derivations.
 *
 * The Sealed Call ID and Feed Packet ID are computed off-chain with the exact
 * formula the contract uses on-chain, so a broadcast-timeout can be reconciled
 * against the id the write would have produced:
 *
 *   callId   = keccak256(abi.encodePacked(chainId, contract, agent, marketId, clientNonce))
 *   packetId = keccak256(abi.encodePacked(chainId, contract, agent, feedId, marketId, clientNonce))
 *
 * Source of truth: contracts/src/MurmurSealedVerdicts.sol:232 (callId) / :373
 * (packetId).
 *
 * This is a SEPARATE concern from Market / Feed id normalization
 * (fhenixMarketIdForMurmurMarket in fhenix-event-primitives.ts,
 * fhenixFeedIdForMurmurFeed in fhenix-gateway-feed-packets.ts): those map a
 * human Murmur market/feed name to its bytes32 hash, whereas these derive the
 * on-chain record id from an already-normalized key. Keep them apart.
 */

import { encodePacked, keccak256, type Address, type Hex } from "viem";

/**
 * The already-normalized inputs to a Sealed Call ID: the agent wallet, the
 * bytes32 market id hash, and the per-submission client nonce.
 */
export interface SealedCallReconciliationKey {
  agentWalletAddress: string;
  marketIdHash: string;
  clientNonce: string;
}

/**
 * The already-normalized inputs to a Feed Packet ID: as above plus the bytes32
 * feed id hash the packet is scoped to.
 */
export interface FeedPacketReconciliationKey {
  agentWalletAddress: string;
  feedIdHash: string;
  marketIdHash: string;
  clientNonce: string;
}

export function computeSealedCallId(
  chainId: number,
  contractAddress: string,
  key: SealedCallReconciliationKey,
): Hex {
  return keccak256(
    encodePacked(
      ["uint256", "address", "address", "bytes32", "bytes32"],
      [
        BigInt(chainId),
        contractAddress as Address,
        key.agentWalletAddress as Address,
        key.marketIdHash as Hex,
        key.clientNonce as Hex,
      ],
    ),
  );
}

export function computeFeedPacketId(
  chainId: number,
  contractAddress: string,
  key: FeedPacketReconciliationKey,
): Hex {
  return keccak256(
    encodePacked(
      ["uint256", "address", "address", "bytes32", "bytes32", "bytes32"],
      [
        BigInt(chainId),
        contractAddress as Address,
        key.agentWalletAddress as Address,
        key.feedIdHash as Hex,
        key.marketIdHash as Hex,
        key.clientNonce as Hex,
      ],
    ),
  );
}
