/**
 * Deterministic Sealed Call / Feed Packet ids, using the contract's exact formula so a
 * broadcast timeout can be reconciled against the id the write would have produced:
 *
 *   callId   = keccak256(abi.encodePacked(chainId, contract, agent, marketId, clientNonce))
 *   packetId = keccak256(abi.encodePacked(chainId, contract, agent, feedId, marketId, clientNonce))
 *
 * Must match contracts/src/MurmurSealedVerdicts.sol.
 */

import { encodePacked, keccak256, type Address, type Hex } from "viem";

/** Already-normalized inputs to a Sealed Call ID. */
export interface SealedCallReconciliationKey {
  agentWalletAddress: string;
  marketIdHash: string;
  clientNonce: string;
}

/** Already-normalized inputs to a Feed Packet ID. */
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
