import type Database from "better-sqlite3";
import type { Request, Response } from "express";
import type { FeedPacketIdAdapter } from "../feed-packet-ingestion.js";
import type { FeedSlaIncidentIdAdapter } from "../feed-sla.js";

export interface FeedAdminRouterDeps {
  db: Database.Database;
  newFeedPacketId?: FeedPacketIdAdapter;
  newFeedSlaIncidentId?: FeedSlaIncidentIdAdapter;
  /**
   * MURMUR_ACK_FEED_REVEAL_MANUAL. The packet backfill route lands packets in
   * SLA and public feed state, so it is gated on the same acknowledgement as
   * live submission — otherwise turning feeds off would still leave a way to
   * publish delivery evidence for a lane with no reveal path.
   */
  feedRevealAcknowledged?: boolean;
  now: () => Date;
  requireAdmin: (req: Request, res: Response) => boolean;
}
