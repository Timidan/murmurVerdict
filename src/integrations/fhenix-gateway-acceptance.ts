import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";

import { errorMessage } from "./fhenix-gateway-runtime.js";
import {
  fhenixGatewayTxRepo,
  type FhenixGatewayTxAttemptRow,
} from "../verdict/repos/fhenix-gateway-tx-repo.js";
import {
  fhenixGatewayFeedPacketTxRepo,
  type FhenixGatewayFeedPacketTxAttemptRow,
} from "../verdict/repos/fhenix-gateway-feed-packet-tx-repo.js";
import { marketsRepo } from "../verdict/repos/market-registry-repo.js";
import { feedPacketsRepo } from "../verdict/repos/feed-availability-repo.js";
import { isUniqueViolation } from "../verdict/sqlite-errors.js";
import { acceptSealedCall } from "../verdict/sealed-call-acceptance.js";
import { nowIso } from "../verdict/time.js";
import { runtimeKeyAcceptanceAuthIdentity } from "../verdict/auth/runtime-authorization.js";
import { classifyFeedPacketSla } from "../verdict/feed-availability.js";
import type { FeedPacketIdAdapter } from "../verdict/feed-packet-ingestion.js";
import type { SealedCallIdAdapter } from "../verdict/sealed-call-acceptance.js";
import type { CallAcceptedEvent } from "../types/events.js";

export async function acceptConfirmedSealedCallGatewayAttempt(params: {
  db: Database.Database;
  attempt: FhenixGatewayTxAttemptRow;
  newCallId?: SealedCallIdAdapter;
  /**
   * The live event bus. Acceptance BUILDS a `call.accepted` event and this
   * path used to drop it on the floor — and since the gateway is the only
   * route an agent can submit through, that meant no agent-submitted call
   * ever reached the bus. Two things silently depended on it: the live tape
   * (which backfills over REST, so it looked merely quiet rather than
   * broken) and `call.accepted` webhook deliveries, which could never fire
   * at all. Optional so tests and the reconciler can accept without one.
   */
  events?: { emit: (event: CallAcceptedEvent) => void };
  now: () => Date;
}): Promise<boolean> {
  const { db, attempt, now } = params;
  if (
    !attempt.tx_hash ||
    attempt.submit_log_index === null ||
    !attempt.onchain_call_id ||
    !attempt.binary_index_ct_hash ||
    !attempt.confidence_ct_hash ||
    !attempt.accepted_at ||
    !attempt.reveal_open_at
  ) {
    fhenixGatewayTxRepo.markTerminalFailure(db, {
      attempt_id: attempt.attempt_id,
      last_error: "confirmed gateway attempt is missing event metadata",
      updated_at: nowIso(now()),
      // POST-broadcast: the row is `confirmed`, so it holds no claim and
      // the pre-claim CAS would match nothing and retry it forever.
      expect_status: "confirmed" as const,
    });
    return false;
  }
  const market = marketsRepo.get(db, attempt.market_id);
  if (!market) {
    fhenixGatewayTxRepo.markTerminalFailure(db, {
      attempt_id: attempt.attempt_id,
      last_error: `confirmed gateway attempt references unknown market ${attempt.market_id}`,
      updated_at: nowIso(now()),
      // POST-broadcast: the row is `confirmed`, so it holds no claim and
      // the pre-claim CAS would match nothing and retry it forever.
      expect_status: "confirmed" as const,
    });
    return false;
  }
  try {
    const result = await acceptSealedCall({
      db,
      authResult: runtimeKeyAcceptanceAuthIdentity({
        agent_id: attempt.agent_id,
        account_id: attempt.account_id,
        runtime_key_id: attempt.runtime_key_id,
        runtime_key_policy_json: attempt.runtime_key_policy_json,
        runtime_key_policy_hash: attempt.runtime_key_policy_hash,
        controller_wallet_address: attempt.agent_wallet_address,
        controller_chain_id: `eip155:${attempt.chain_id}`,
      }),
      market,
      client_order_id: attempt.client_order_id,
      submitted_at: attempt.submitted_at,
      rationale: attempt.rationale ?? undefined,
      strategy_tag: attempt.strategy_tag ?? undefined,
      verifiedSubmit: {
        chain_id: attempt.chain_id,
        contract_address: attempt.contract_address,
        onchain_call_id: attempt.onchain_call_id,
        submit_tx_hash: attempt.tx_hash,
        submit_log_index: attempt.submit_log_index,
        binary_index_ct_hash: attempt.binary_index_ct_hash,
        confidence_ct_hash: attempt.confidence_ct_hash,
        accepted_at: attempt.accepted_at,
        reveal_open_at: attempt.reveal_open_at,
        // NULL on attempts confirmed before submission_class was recorded.
        // 0 (None) is honest — "not decoded" — and is deliberately NOT
        // defaulted to EarlyAccess: eligibility treats a recorded non-early
        // class as unsellable, so inventing 1 here would sell calls the
        // contract then refuses to grant.
        submission_class: attempt.submission_class ?? 0,
        agent_wallet: attempt.agent_wallet_address,
        market_id_hash: attempt.market_id_hash,
        client_nonce: attempt.client_nonce,
      },
      newCallId: params.newCallId,
      now,
    });
    fhenixGatewayTxRepo.markAccepted(db, {
      attempt_id: attempt.attempt_id,
      call_id: result.body.call_id,
      updated_at: nowIso(now()),
    });
    // AFTER the durable write. The bus is in-process and non-durable, so a
    // subscriber that misses this frame recovers by reading REST; a row that
    // never got marked accepted would not.
    if (result.event) params.events?.emit(result.event);
    return true;
  } catch (err) {
    fhenixGatewayTxRepo.markTerminalFailure(db, {
      attempt_id: attempt.attempt_id,
      last_error: errorMessage(err),
      updated_at: nowIso(now()),
      // POST-broadcast: the row is `confirmed`, so it holds no claim and
      // the pre-claim CAS would match nothing and retry it forever.
      expect_status: "confirmed" as const,
    });
    return false;
  }
}

export async function acceptConfirmedFeedPacketGatewayAttempt(params: {
  db: Database.Database;
  attempt: FhenixGatewayFeedPacketTxAttemptRow;
  newPacketId?: FeedPacketIdAdapter;
  now: () => Date;
}): Promise<boolean> {
  const { db, attempt, now } = params;
  if (
    !attempt.tx_hash ||
    attempt.submit_log_index === null ||
    !attempt.onchain_packet_id ||
    !attempt.action_ct_hash ||
    !attempt.signal_ct_hash ||
    !attempt.accepted_at
  ) {
    fhenixGatewayFeedPacketTxRepo.markTerminalFailure(db, {
      attempt_id: attempt.attempt_id,
      last_error: "confirmed gateway feed packet attempt is missing event metadata",
      updated_at: nowIso(now()),
      // POST-broadcast: the row is `confirmed`, so it holds no claim and
      // the pre-claim CAS would match nothing and retry it forever.
      expect_status: "confirmed" as const,
    });
    return false;
  }
  try {
    const existing = feedPacketsRepo.byFhenixEvent(db, {
      chain_id: attempt.chain_id,
      contract_address: attempt.contract_address,
      onchain_packet_id: attempt.onchain_packet_id,
    });
    if (existing) {
      fhenixGatewayFeedPacketTxRepo.markAccepted(db, {
        attempt_id: attempt.attempt_id,
        packet_id: existing.packet_id,
        updated_at: nowIso(now()),
      });
      return true;
    }
    const packetId = (params.newPacketId ?? randomUUID)();
    const slaStatus = classifyFeedPacketSla(
      attempt.accepted_at,
      attempt.delivery_deadline_at,
    );
    db.transaction(() => {
      feedPacketsRepo.insert(db, {
        packet_id: packetId,
        feed_id: attempt.feed_id,
        agent_id: attempt.agent_id,
        market_id: attempt.market_id,
        packet_kind: attempt.packet_kind,
        sequence: attempt.sequence,
        payload_schema: attempt.payload_schema,
        submitted_at: attempt.submitted_at,
        accepted_at: attempt.accepted_at!,
        reveal_after: attempt.reveal_after,
        delivery_deadline_at: attempt.delivery_deadline_at,
        sla_status: slaStatus,
        chain_id: attempt.chain_id,
        contract_address: attempt.contract_address,
        onchain_packet_id: attempt.onchain_packet_id!,
        submit_tx_hash: attempt.tx_hash!,
        submit_log_index: attempt.submit_log_index!,
        packet_ct_hash: attempt.action_ct_hash!,
        binary_index_ct_hash: attempt.action_ct_hash!,
        confidence_ct_hash: attempt.signal_ct_hash!,
        created_at: nowIso(now()),
      });
      fhenixGatewayFeedPacketTxRepo.markAccepted(db, {
        attempt_id: attempt.attempt_id,
        packet_id: packetId,
        updated_at: nowIso(now()),
      });
    })();
    return true;
  } catch (err) {
    if (isUniqueViolation(err)) {
      const existing = feedPacketsRepo.byFhenixEvent(db, {
        chain_id: attempt.chain_id,
        contract_address: attempt.contract_address,
        onchain_packet_id: attempt.onchain_packet_id ?? "",
      });
      if (existing) {
        fhenixGatewayFeedPacketTxRepo.markAccepted(db, {
          attempt_id: attempt.attempt_id,
          packet_id: existing.packet_id,
          updated_at: nowIso(now()),
        });
        return true;
      }
    }
    fhenixGatewayFeedPacketTxRepo.markTerminalFailure(db, {
      attempt_id: attempt.attempt_id,
      last_error: errorMessage(err),
      updated_at: nowIso(now()),
      // POST-broadcast: the row is `confirmed`, so it holds no claim and
      // the pre-claim CAS would match nothing and retry it forever.
      expect_status: "confirmed" as const,
    });
    return false;
  }
}
