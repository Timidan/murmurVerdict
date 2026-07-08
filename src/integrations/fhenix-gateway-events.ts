import {
  decodeEventLog,
  getAddress,
  isAddressEqual,
  type Address,
  type Hex,
} from "viem";

import {
  FEED_PACKET_SUBMITTED_EVENT,
  SEALED_CALL_SUBMITTED_EVENT,
} from "./fhenix-events.js";
import type { GatewayReceipt } from "./fhenix-gateway-contract.js";
import {
  safeBlockNumber,
  unixSecondsToIso,
} from "./fhenix-gateway-runtime.js";
import type { FhenixGatewayTxAttemptRow } from "../verdict/repos/fhenix-gateway-tx-repo.js";
import type { FhenixGatewayFeedPacketTxAttemptRow } from "../verdict/repos/fhenix-gateway-feed-packet-tx-repo.js";

export type GatewaySealedCallSubmitEvent = {
  logIndex: number;
  blockNumber: number | null;
  onchain_call_id: string;
  binary_index_ct_hash: string;
  confidence_ct_hash: string;
  accepted_at: string;
  reveal_open_at: string;
};

export type GatewayFeedPacketSubmitEvent = {
  logIndex: number;
  blockNumber: number | null;
  onchain_packet_id: string;
  action_ct_hash: string;
  signal_ct_hash: string;
  accepted_at: string;
};

export function extractSealedCallSubmitEvent(
  attempt: FhenixGatewayTxAttemptRow,
  receipt: GatewayReceipt,
): GatewaySealedCallSubmitEvent | null {
  for (const log of receipt.logs) {
    if (!isAddressEqual(getAddress(log.address), getAddress(attempt.contract_address as Address))) {
      continue;
    }
    try {
      const decoded = decodeEventLog({
        abi: [SEALED_CALL_SUBMITTED_EVENT],
        data: log.data,
        topics: log.topics as [Hex, ...Hex[]],
      });
      const args = decoded.args as {
        callId: Hex;
        agent: Address;
        marketId: Hex;
        acceptedAt: bigint;
        revealOpenAt: bigint;
        binaryIndexCtHash: Hex;
        confidenceCtHash: Hex;
        clientNonce: Hex;
      };
      if (decoded.eventName !== "SealedCallSubmitted") continue;
      if (!isAddressEqual(args.agent, attempt.agent_wallet_address as Address)) continue;
      if (args.marketId.toLowerCase() !== attempt.market_id_hash) continue;
      if (args.clientNonce.toLowerCase() !== attempt.client_nonce) continue;
      return {
        logIndex: log.logIndex,
        blockNumber: safeBlockNumber(log.blockNumber ?? receipt.blockNumber),
        onchain_call_id: args.callId.toLowerCase(),
        binary_index_ct_hash: args.binaryIndexCtHash.toLowerCase(),
        confidence_ct_hash: args.confidenceCtHash.toLowerCase(),
        accepted_at: unixSecondsToIso(args.acceptedAt),
        reveal_open_at: unixSecondsToIso(args.revealOpenAt),
      };
    } catch {
      continue;
    }
  }
  return null;
}

export function extractFeedPacketSubmitEvent(
  attempt: FhenixGatewayFeedPacketTxAttemptRow,
  receipt: GatewayReceipt,
): GatewayFeedPacketSubmitEvent | null {
  for (const log of receipt.logs) {
    if (!isAddressEqual(getAddress(log.address), getAddress(attempt.contract_address as Address))) {
      continue;
    }
    try {
      const decoded = decodeEventLog({
        abi: [FEED_PACKET_SUBMITTED_EVENT],
        data: log.data,
        topics: log.topics as [Hex, ...Hex[]],
      });
      const args = decoded.args as {
        packetId: Hex;
        agent: Address;
        feedId: Hex;
        marketId: Hex;
        acceptedAt: bigint;
        revealAfter: bigint;
        actionCtHash: Hex;
        signalCtHash: Hex;
        clientNonce: Hex;
      };
      if (decoded.eventName !== "FeedPacketSubmitted") continue;
      if (!isAddressEqual(args.agent, attempt.agent_wallet_address as Address)) continue;
      if (args.feedId.toLowerCase() !== attempt.feed_id_hash) continue;
      if (args.marketId.toLowerCase() !== attempt.market_id_hash) continue;
      if (args.clientNonce.toLowerCase() !== attempt.client_nonce) continue;
      const revealAfter = unixSecondsToIso(args.revealAfter);
      if (revealAfter !== attempt.reveal_after) continue;
      return {
        logIndex: log.logIndex,
        blockNumber: safeBlockNumber(log.blockNumber ?? receipt.blockNumber),
        onchain_packet_id: args.packetId.toLowerCase(),
        action_ct_hash: args.actionCtHash.toLowerCase(),
        signal_ct_hash: args.signalCtHash.toLowerCase(),
        accepted_at: unixSecondsToIso(args.acceptedAt),
      };
    } catch {
      continue;
    }
  }
  return null;
}
