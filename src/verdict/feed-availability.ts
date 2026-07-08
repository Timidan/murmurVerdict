import type Database from "better-sqlite3";

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
    const adapterId = market.adapter_id ?? "native-price";
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

export function validateFeedPacketMarket(
  db: Database.Database,
  feed: FeedContractRow,
  marketId: string | null,
): void {
  if (marketId === null) return;
  const market = marketsRepo.get(db, marketId);
  if (!market) {
    throw new VerdictError(
      `unknown packet market: ${marketId}`,
      ERROR_CODES.asset_not_supported,
      404,
      { market_id: marketId },
    );
  }
  const adapterId = market.adapter_id ?? "native-price";
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
