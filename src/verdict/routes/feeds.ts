import { Router, type Request, type Response } from "express";
import type Database from "better-sqlite3";
import type { PrivyAuthVerifier } from "../auth/privy.js";
import type { FeedContractIdAdapter } from "../feed-contract-surface.js";
import type { FeedPacketIdAdapter } from "../feed-packet-ingestion.js";
import type { FeedSlaIncidentIdAdapter } from "../feed-sla.js";
import { feedAdminRouter } from "./feed-admin.js";
import { feedContractsRouter } from "./feed-contracts.js";
import { feedPublicRouter } from "./feed-public.js";

export interface FeedRouterDeps {
  db: Database.Database;
  newFeedId?: FeedContractIdAdapter;
  newFeedPacketId?: FeedPacketIdAdapter;
  newFeedSlaIncidentId?: FeedSlaIncidentIdAdapter;
  /** MURMUR_ACK_FEED_REVEAL_MANUAL; gates the admin packet backfill. */
  feedRevealAcknowledged?: boolean;
  now: () => Date;
  privyAuth?: PrivyAuthVerifier;
  requireAdmin: (req: Request, res: Response) => boolean;
}

export function feedRouter(deps: FeedRouterDeps): Router {
  const router = Router();

  router.use(feedContractsRouter({
    db: deps.db,
    newFeedId: deps.newFeedId,
    now: deps.now,
    privyAuth: deps.privyAuth,
  }));
  router.use(feedPublicRouter({
    db: deps.db,
    now: deps.now,
  }));

  router.use(feedAdminRouter({
    db: deps.db,
    newFeedPacketId: deps.newFeedPacketId,
    newFeedSlaIncidentId: deps.newFeedSlaIncidentId,
    feedRevealAcknowledged: deps.feedRevealAcknowledged,
    now: deps.now,
    requireAdmin: deps.requireAdmin,
  }));

  return router;
}
