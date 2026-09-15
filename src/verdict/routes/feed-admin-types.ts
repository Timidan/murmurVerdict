import type Database from "better-sqlite3";
import type { Request, Response } from "express";
import type { FeedPacketIdAdapter } from "../feed-packet-ingestion.js";
import type { FeedSlaIncidentIdAdapter } from "../feed-sla.js";

export interface FeedAdminRouterDeps {
  db: Database.Database;
  newFeedPacketId?: FeedPacketIdAdapter;
  newFeedSlaIncidentId?: FeedSlaIncidentIdAdapter;
  /**
   * MURMUR_ACK_FEED_REVEAL_MANUAL. Packet backfill publishes delivery evidence, so it needs
   * the same acknowledgement as live submission.
   */
  feedRevealAcknowledged?: boolean;
  now: () => Date;
  requireAdmin: (req: Request, res: Response) => boolean;
}
