import { randomUUID } from "node:crypto";

import type Database from "better-sqlite3";
import { z } from "zod";

import {
  classifyFeedPacketSla,
  inferFeedDeliveryDeadline,
  validateFeedPacketMarket,
} from "./feed-availability.js";
import { Hex20Schema, Hex32Schema } from "./fhenix-common.js";
import {
  feedPacketsRepo,
  type FeedContractRow,
  type FeedPacketRow,
} from "./repos/feed-availability-repo.js";
import {
  ERROR_CODES,
  type FeedPacketKind,
  VerdictError,
} from "./schema.js";
import { isUniqueViolation } from "./sqlite-errors.js";
import { nowIso, parseIsoMs } from "./time.js";

const FEED_PACKET_FUTURE_SKEW_MS = 5 * 60 * 1000;

export type FeedPacketIdAdapter = () => string;

export const FeedPacketFhenixEventSchema = z
  .object({
    chain_id: z.number().int().positive(),
    contract_address: Hex20Schema,
    onchain_packet_id: Hex32Schema,
    submit_tx_hash: Hex32Schema,
    submit_log_index: z.number().int().nonnegative(),
    packet_ct_hash: Hex32Schema,
    binary_index_ct_hash: Hex32Schema.optional(),
    confidence_ct_hash: Hex32Schema.optional(),
    accepted_at: z.string().datetime({ offset: false }),
    reveal_after: z.string().datetime({ offset: false }),
  })
  .strict();

export type FeedPacketFhenixEventInput = z.infer<
  typeof FeedPacketFhenixEventSchema
>;

interface NormalizedFeedPacketFhenixEvent {
  chain_id: number;
  contract_address: string;
  onchain_packet_id: string;
  submit_tx_hash: string;
  submit_log_index: number;
  packet_ct_hash: string;
  binary_index_ct_hash: string | null;
  confidence_ct_hash: string | null;
  accepted_at: string;
  reveal_after: string;
}

export interface FeedPacketIngestionInput {
  db: Database.Database;
  feed: FeedContractRow;
  packet_kind: FeedPacketKind;
  market_id?: string;
  sequence?: number;
  payload_schema: string;
  submitted_at?: string;
  delivery_deadline_at?: string;
  fhenix: FeedPacketFhenixEventInput;
  newPacketId?: FeedPacketIdAdapter;
  now: () => Date;
}

export type FeedPacketIngestionResult =
  | { kind: "inserted"; packet: FeedPacketRow }
  | { kind: "idempotent"; packet: FeedPacketRow };

export function ingestFeedPacket(
  input: FeedPacketIngestionInput,
): FeedPacketIngestionResult {
  validateFeedPacketMarket(input.db, input.feed, input.market_id ?? null);
  const fhenixEvent = normalizeFeedPacketFhenixEvent(input.fhenix);
  const existing = feedPacketsRepo.byFhenixEvent(input.db, fhenixEvent);
  if (existing) return { kind: "idempotent", packet: existing };

  assertFeedPacketTiming(fhenixEvent, input.now());

  try {
    const txn = input.db.transaction(() => {
      const sequence =
        input.sequence ??
        feedPacketsRepo.nextSequence(input.db, input.feed.feed_id);
      const latest = feedPacketsRepo.latestForFeed(
        input.db,
        input.feed.feed_id,
      );
      const deadline =
        input.delivery_deadline_at ??
        inferFeedDeliveryDeadline(input.feed, latest, sequence);
      const createdAt = nowIso(input.now());
      const packetId = (input.newPacketId ?? randomUUID)();
      feedPacketsRepo.insert(input.db, {
        packet_id: packetId,
        feed_id: input.feed.feed_id,
        agent_id: input.feed.agent_id,
        market_id: input.market_id ?? null,
        packet_kind: input.packet_kind,
        sequence,
        payload_schema: input.payload_schema,
        submitted_at: input.submitted_at ?? fhenixEvent.accepted_at,
        accepted_at: fhenixEvent.accepted_at,
        reveal_after: fhenixEvent.reveal_after,
        delivery_deadline_at: deadline,
        sla_status: classifyFeedPacketSla(fhenixEvent.accepted_at, deadline),
        chain_id: fhenixEvent.chain_id,
        contract_address: fhenixEvent.contract_address,
        onchain_packet_id: fhenixEvent.onchain_packet_id,
        submit_tx_hash: fhenixEvent.submit_tx_hash,
        submit_log_index: fhenixEvent.submit_log_index,
        packet_ct_hash: fhenixEvent.packet_ct_hash,
        binary_index_ct_hash: fhenixEvent.binary_index_ct_hash,
        confidence_ct_hash: fhenixEvent.confidence_ct_hash,
        created_at: createdAt,
      });
      const row = feedPacketsRepo.byFhenixEvent(input.db, fhenixEvent);
      if (!row) {
        throw new Error(
          `feed packet insert did not persist feed_id=${input.feed.feed_id}`,
        );
      }
      return row;
    });
    return { kind: "inserted", packet: txn.immediate() };
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    const duplicate = feedPacketsRepo.byFhenixEvent(input.db, fhenixEvent);
    if (duplicate) return { kind: "idempotent", packet: duplicate };
    throw new VerdictError(
      "duplicate feed packet sequence or Fhenix event",
      ERROR_CODES.duplicate,
      409,
    );
  }
}

function normalizeFeedPacketFhenixEvent(
  input: FeedPacketFhenixEventInput,
): NormalizedFeedPacketFhenixEvent {
  return {
    chain_id: input.chain_id,
    contract_address: input.contract_address.toLowerCase(),
    onchain_packet_id: input.onchain_packet_id.toLowerCase(),
    submit_tx_hash: input.submit_tx_hash.toLowerCase(),
    submit_log_index: input.submit_log_index,
    packet_ct_hash: input.packet_ct_hash.toLowerCase(),
    binary_index_ct_hash: input.binary_index_ct_hash?.toLowerCase() ?? null,
    confidence_ct_hash: input.confidence_ct_hash?.toLowerCase() ?? null,
    accepted_at: input.accepted_at,
    reveal_after: input.reveal_after,
  };
}

function assertFeedPacketTiming(
  event: NormalizedFeedPacketFhenixEvent,
  now: Date,
): void {
  const acceptedAtMs = parseIsoMs(event.accepted_at, "fhenix.accepted_at");
  const revealAfterMs = parseIsoMs(event.reveal_after, "fhenix.reveal_after");
  if (revealAfterMs < acceptedAtMs) {
    throw new VerdictError(
      "fhenix.reveal_after must be at or after fhenix.accepted_at",
      ERROR_CODES.schema_invalid,
      400,
    );
  }
  if (acceptedAtMs > now.getTime() + FEED_PACKET_FUTURE_SKEW_MS) {
    throw new VerdictError(
      "fhenix.accepted_at is too far in the future",
      ERROR_CODES.schema_invalid,
      400,
    );
  }
}
