import type Database from "better-sqlite3";
import { z } from "zod";

import {
  type AgentSecurityEventIdAdapter,
  makeAgentSecurityEvent,
} from "./agent-security-event.js";
import { feedReliabilityEnvelope } from "./feed-availability.js";
import {
  FeedPacketFhenixEventSchema,
  ingestFeedPacket,
  type FeedPacketIdAdapter,
} from "./feed-packet-ingestion.js";
import { publicFeedPacket } from "./feed-presenters.js";
import { agentSecurityEventsRepo } from "./repos/agent-security-events-repo.js";
import { feedContractsRepo } from "./repos/feed-availability-repo.js";
import {
  ERROR_CODES,
  FeedPacketKindSchema,
  MarketIdSchema,
  SCHEMA_VERSION,
  VerdictError,
} from "./schema.js";

export const FeedPacketBackfillBodySchema = z
  .object({
    packet_kind: FeedPacketKindSchema,
    market_id: MarketIdSchema.optional(),
    sequence: z.number().int().positive().optional(),
    payload_schema: z
      .string()
      .min(3)
      .max(64)
      .regex(/^[a-z0-9_.-]+$/)
      .default("murmur-feed-packet-v1"),
    submitted_at: z.string().datetime({ offset: false }).optional(),
    delivery_deadline_at: z.string().datetime({ offset: false }).optional(),
    fhenix: FeedPacketFhenixEventSchema,
  })
  .strict();

export interface FeedPacketAdminClock {
  now: () => Date;
}

export interface FeedPacketAdminAdapters {
  newPacketId?: FeedPacketIdAdapter;
  /**
   * Optional adapter for the `admin_fhenix_feed_packet_backfill` audit
   * event id. Defaults to randomUUID() inside makeAgentSecurityEvent.
   */
  newAgentSecurityEventId?: AgentSecurityEventIdAdapter;
}

export type FeedPacketBackfillResponse =
  | {
      status: 404;
      body: { code: "not_found"; message: "feed not found" };
    }
  | {
      status: 200;
      body: {
        schema_version: typeof SCHEMA_VERSION;
        packet: ReturnType<typeof publicFeedPacket>;
        idempotent_hit: true;
      };
    }
  | {
      status: 201;
      body: {
        schema_version: typeof SCHEMA_VERSION;
        packet: ReturnType<typeof publicFeedPacket>;
        reliability: ReturnType<typeof feedReliabilityEnvelope>;
        idempotent_hit: false;
      };
    };

export interface FeedPacketAdminJsonResponseTarget {
  status(code: number): { json(body: unknown): unknown };
}

export function sendFeedPacketAdminJsonResponse(
  res: FeedPacketAdminJsonResponseTarget,
  result: FeedPacketBackfillResponse,
): void {
  res.status(result.status).json(result.body);
}

export function feedPacketBackfillResponse(input: {
  db: Database.Database;
  feedId: string;
  body: unknown;
} & FeedPacketAdminClock & FeedPacketAdminAdapters): FeedPacketBackfillResponse {
  const feed = feedContractsRepo.byId(input.db, input.feedId);
  if (!feed) {
    return {
      status: 404,
      body: { code: "not_found", message: "feed not found" },
    };
  }
  if (feed.status === "retired") {
    throw new VerdictError(
      "retired feeds do not accept new sealed packets",
      ERROR_CODES.schema_invalid,
      409,
    );
  }

  const parsed = FeedPacketBackfillBodySchema.safeParse(input.body ?? {});
  if (!parsed.success) {
    throw new VerdictError(
      "feed packet failed schema validation",
      ERROR_CODES.schema_invalid,
      400,
      { issues: parsed.error.format() },
    );
  }
  const body = parsed.data;
  // Fix 3 — emit `admin_fhenix_feed_packet_backfill` audit alongside the
  // ingest insert in ONE transaction. Idempotent hits skip the emit so
  // the forensic log stays free of replay noise. Atomicity matters: if
  // the audit emit fails the ingest must roll back; otherwise we ship
  // an unaudited operator backfill.
  const result = input.db.transaction(() => {
    const ingest = ingestFeedPacket({
      db: input.db,
      feed,
      packet_kind: body.packet_kind,
      market_id: body.market_id,
      sequence: body.sequence,
      payload_schema: body.payload_schema,
      submitted_at: body.submitted_at,
      delivery_deadline_at: body.delivery_deadline_at,
      fhenix: body.fhenix,
      newPacketId: input.newPacketId,
      now: input.now,
    });
    if (ingest.kind === "inserted") {
      agentSecurityEventsRepo.emit(
        input.db,
        makeAgentSecurityEvent({
          kind: "admin_fhenix_feed_packet_backfill",
          actor: "admin_token",
          agent_id: ingest.packet.agent_id,
          newEventId: input.newAgentSecurityEventId,
          payload: {
            feed_id: input.feedId,
            packet_id: ingest.packet.packet_id,
            onchain_packet_id: ingest.packet.onchain_packet_id,
            submit_tx_hash: ingest.packet.submit_tx_hash,
            submit_log_index: ingest.packet.submit_log_index,
            sequence: ingest.packet.sequence,
            packet_kind: ingest.packet.packet_kind,
          },
          createdAt: input.now(),
        }),
      );
    }
    return ingest;
  })();

  if (result.kind === "idempotent") {
    return {
      status: 200,
      body: {
        schema_version: SCHEMA_VERSION,
        packet: publicFeedPacket(result.packet),
        idempotent_hit: true,
      },
    };
  }
  return {
    status: 201,
    body: {
      schema_version: SCHEMA_VERSION,
      packet: publicFeedPacket(result.packet),
      reliability: feedReliabilityEnvelope(
        feedContractsRepo.reliability(input.db, input.feedId),
      ),
      idempotent_hit: false,
    },
  };
}
