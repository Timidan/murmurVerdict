import type Database from "better-sqlite3";

import { marketClocksRepo } from "./repos/market-clocks-repo.js";
import {
  marketsRepo,
} from "./repos/market-registry-repo.js";
import type {
  FeedContractRow,
  FeedPacketRow,
} from "./repos/feed-availability-repo.js";
import { coveredMarketIdsForFeed } from "./feed-contract-metadata.js";
import { marketTaxonomyForMarket } from "./market-taxonomy.js";
import { ERROR_CODES, type ResolutionClass, VerdictError } from "./schema.js";
import { isoFromMs, parseIsoMs } from "./time.js";

export * from "./feed-availability-proof.js";

export function validateFeedCoveredMarkets(
  db: Database.Database,
  marketIds: string[],
  venue: string,
  resolutionClasses: readonly ResolutionClass[],
): void {
  for (const marketId of marketIds) {
    const market = marketsRepo.get(db, marketId);
    if (!market) {
      throw new VerdictError(
        `unknown covered market: ${marketId}`,
        ERROR_CODES.asset_not_supported,
        404,
        { market_id: marketId },
      );
    }
    const adapterId = market.adapter_id;
    if (adapterId !== venue) {
      throw new VerdictError(
        `covered market ${marketId} belongs to adapter '${adapterId}', not '${venue}'`,
        ERROR_CODES.schema_invalid,
        400,
        { market_id: marketId, adapter_id: adapterId, venue },
      );
    }
    if (market.status === "retired") {
      throw new VerdictError(
        `covered market ${marketId} is retired`,
        ERROR_CODES.schema_invalid,
        400,
        { market_id: marketId },
      );
    }
    const taxonomy = marketTaxonomyForMarket(market);
    if (!resolutionClasses.includes(taxonomy.resolution_class)) {
      throw new VerdictError(
        `covered market ${marketId} is '${taxonomy.resolution_class}', outside this feed's resolution_classes`,
        ERROR_CODES.schema_invalid,
        400,
        {
          market_id: marketId,
          resolution_class: taxonomy.resolution_class,
          feed_resolution_classes: resolutionClasses,
        },
      );
    }
  }
}

/**
 * Refuses packets unless the feed's reveal policy is `after_resolution`. Reveal time comes from the
 * market's schedule, so other policies can't be honoured; the feed stays quarantined until converted.
 */
export function assertFeedRevealPolicySupported(feed: FeedContractRow): void {
  let kind: unknown;
  try {
    kind = (JSON.parse(feed.reveal_policy_json) as Record<string, unknown>).kind;
  } catch {
    kind = "<unparseable>";
  }
  // Fail closed on unknown too: a malformed or absent policy is not evidence
  // that the feed promised nothing.
  if (kind !== "after_resolution") {
    throw new VerdictError(
      `feed reveal policy '${String(kind)}' is no longer supported`,
      ERROR_CODES.schema_invalid,
      409,
      {
        feed_id: feed.feed_id,
        reveal_policy: kind,
        remedy:
          "a packet's reveal time now comes from its market's immutable schedule, " +
          "so per-packet delays cannot be enforced; convert this feed to " +
          "reveal_policy.kind='after_resolution'",
      },
    );
  }
}

export function validateFeedPacketMarket(
  db: Database.Database,
  feed: FeedContractRow,
  marketId: string | null,
): void {
  if (marketId === null) return;
  const market = marketsRepo.get(db, marketId);
  // Reveal time comes from the market's schedule, so the market must be listed with a frozen clock.
  if (market && market.status !== "listed") {
    throw new VerdictError(
      `packet market is not listed: ${marketId} (status=${market.status})`,
      ERROR_CODES.asset_not_supported,
      400,
      { market_id: marketId, status: market.status },
    );
  }
  if (market && !marketClocksRepo.get(db, marketId)) {
    throw new VerdictError(
      `packet market has no schedule snapshot: ${marketId}`,
      ERROR_CODES.asset_not_supported,
      400,
      { market_id: marketId },
    );
  }
  if (!market) {
    throw new VerdictError(
      `unknown packet market: ${marketId}`,
      ERROR_CODES.asset_not_supported,
      404,
      { market_id: marketId },
    );
  }
  const adapterId = market.adapter_id;
  if (adapterId !== feed.venue) {
    throw new VerdictError(
      `packet market ${marketId} belongs to adapter '${adapterId}', not feed venue '${feed.venue}'`,
      ERROR_CODES.schema_invalid,
      400,
      { market_id: marketId, adapter_id: adapterId, venue: feed.venue },
    );
  }
  const covered = coveredMarketIdsForFeed(feed);
  if (covered.length > 0 && !covered.includes(marketId)) {
    throw new VerdictError(
      `packet market ${marketId} is outside this feed's covered_market_ids`,
      ERROR_CODES.schema_invalid,
      400,
      { market_id: marketId, feed_id: feed.feed_id },
    );
  }
}

export function inferFeedDeliveryDeadline(
  feed: FeedContractRow,
  latest: FeedPacketRow | null,
  sequence: number,
): string | null {
  const cadence = feed.delivery_cadence_seconds;
  if (cadence === null) return null;
  const baseMs =
    latest && sequence === latest.sequence + 1
      ? parseIsoMs(latest.accepted_at, "latest.accepted_at")
      : parseIsoMs(feed.created_at, "feed.created_at") +
        cadence * 1000 * Math.max(0, sequence - 1);
  return isoFromMs(baseMs + cadence * 1000);
}

export function classifyFeedPacketSla(
  acceptedAt: string,
  deliveryDeadlineAt: string | null,
): "on_time" | "late" | "unscheduled" {
  if (deliveryDeadlineAt === null) return "unscheduled";
  return parseIsoMs(acceptedAt, "accepted_at") <=
    parseIsoMs(deliveryDeadlineAt, "delivery_deadline_at")
    ? "on_time"
    : "late";
}
