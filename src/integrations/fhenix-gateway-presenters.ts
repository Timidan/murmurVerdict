import type Database from "better-sqlite3";

import type { FhenixGatewayTxAttemptRow } from "../verdict/repos/fhenix-gateway-tx-repo.js";
import type { FhenixGatewayFeedPacketTxAttemptRow } from "../verdict/repos/fhenix-gateway-feed-packet-tx-repo.js";
import { feedPacketsRepo } from "../verdict/repos/feed-availability-repo.js";

export {
  buildGatewayOperatorSnapshot,
} from "../verdict/operator-gateway-snapshot.js";
export type {
  GatewayOperatorAttempt,
  GatewayOperatorFeedAttempt,
  GatewayOperatorSnapshot,
} from "../verdict/operator-gateway-snapshot.js";

export interface GatewaySubmitResult {
  status: 200 | 202;
  body: {
    attempt_id: string;
    status: string;
    tx_hash: string | null;
    call_id: string | null;
    next_attempt_at: string;
    idempotent_hit: boolean;
  };
}

export interface GatewayFeedPacketSubmitResult {
  status: 200 | 202;
  body: {
    attempt_id: string;
    status: string;
    tx_hash: string | null;
    packet_id: string | null;
    sequence: number;
    sla_status: string | null;
    next_attempt_at: string;
    idempotent_hit: boolean;
  };
}

export function gatewaySubmissionResult(
  attempt: FhenixGatewayTxAttemptRow,
  idempotent_hit: boolean,
): GatewaySubmitResult {
  return {
    status: attempt.status === "accepted" ? 200 : 202,
    body: {
      attempt_id: attempt.attempt_id,
      status: attempt.status,
      tx_hash: attempt.tx_hash,
      call_id: attempt.call_id,
      next_attempt_at: attempt.next_attempt_at,
      idempotent_hit,
    },
  };
}

export function gatewayFeedPacketResult(
  attempt: FhenixGatewayFeedPacketTxAttemptRow,
  idempotent_hit: boolean,
  db: Database.Database,
): GatewayFeedPacketSubmitResult {
  const packet = attempt.packet_id ? feedPacketsRepo.byFhenixEvent(db, {
    chain_id: attempt.chain_id,
    contract_address: attempt.contract_address,
    onchain_packet_id: attempt.onchain_packet_id ?? "",
  }) : null;
  return {
    status: attempt.status === "accepted" ? 200 : 202,
    body: {
      attempt_id: attempt.attempt_id,
      status: attempt.status,
      tx_hash: attempt.tx_hash,
      packet_id: attempt.packet_id,
      sequence: attempt.sequence,
      sla_status: packet?.sla_status ?? null,
      next_attempt_at: attempt.next_attempt_at,
      idempotent_hit,
    },
  };
}
