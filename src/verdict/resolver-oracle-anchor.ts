import type Database from "better-sqlite3";

import type {
  OracleFeed,
  T0Policy,
} from "./schema.js";
import { feedToOracleId } from "./oracle-routing.js";
import {
  OracleClient,
  OracleError,
  type OracleObservation,
} from "../integrations/oracle.js";
import {
  isOracleAdapterRegistryRefusal,
  observeOracle,
} from "../integrations/oracles/registry.js";
import {
  AdapterError,
  type OracleObservation as AdapterObservation,
} from "../integrations/oracles/types.js";

export type ResolverAnchorOutcome =
  | { kind: "anchored"; observation: OracleObservation }
  | { kind: "oracle_unavailable" }
  | { kind: "pending"; reason: string };

export async function tryAnchorOracleFeed(args: {
  db: Database.Database;
  oracle: OracleClient;
  mustBeAfterIso: string;
  elapsedSec: number;
  policy: T0Policy;
}): Promise<ResolverAnchorOutcome> {
  if (args.elapsedSec > args.policy.t0_extended_grace_seconds) {
    return { kind: "oracle_unavailable" };
  }
  // Phase 2d: T0Policy fallback fields are optional. For sub-hour Pyth-only
  // markets we have no second oracle to walk to. Retry primary until
  // t0_extended_grace_seconds expires, then mark oracle_unavailable.
  const wantFallback = args.elapsedSec > args.policy.t0_grace_seconds;
  const fallbackConfigured =
    args.policy.fallback_feed !== undefined &&
    args.policy.fallback_max_staleness_sec !== undefined;
  const useFallback = wantFallback && fallbackConfigured;
  const feed = useFallback
    ? args.policy.fallback_feed!
    : args.policy.primary_feed;
  const maxStaleness = useFallback
    ? args.policy.fallback_max_staleness_sec!
    : args.policy.primary_max_staleness_sec;
  let obs: OracleObservation;
  try {
    obs = await observeResolverFeed(args.db, args.oracle, feed);
  } catch (err) {
    if (err instanceof OracleError || err instanceof AdapterError) {
      const kind = err instanceof OracleError ? err.cause_kind : err.cause_kind;
      return { kind: "pending", reason: `oracle_error:${kind}` };
    }
    throw err;
  }
  const feedMs = Date.parse(obs.feed_timestamp);
  const afterMs = Date.parse(args.mustBeAfterIso);
  if (feedMs < afterMs) {
    return { kind: "pending", reason: "feed_not_yet_advanced" };
  }
  if (obs.source_age_seconds > maxStaleness) {
    return {
      kind: "pending",
      reason: `feed_stale:${obs.source_age_seconds}s>${maxStaleness}s`,
    };
  }
  return { kind: "anchored", observation: obs };
}

// OracleClient still presents the legacy Chainlink/Pyth feed Interface. The
// adapter registry is data-driven. Route through the registry first with the
// daemon-owned oracle context. Keep the legacy reader only as a compatibility
// fallback when the registry configuration itself refuses the feed; runtime
// Adapter failures must keep their AdapterError shape for resolver policy.
export async function observeResolverFeed(
  db: Database.Database,
  oracle: OracleClient,
  feed: OracleFeed,
): Promise<OracleObservation> {
  const oracle_id = feedToOracleId(feed);
  try {
    const obs = await observeOracle(db, oracle_id, oracle.adapterContext());
    return adapterToLegacyObservation(obs, feed);
  } catch (err) {
    if (!(err instanceof AdapterError)) {
      throw err;
    }
    if (!allowsLegacyOracleFallback(err)) {
      throw err;
    }
  }
  return oracle.getLatestPrice(feed);
}

function allowsLegacyOracleFallback(err: AdapterError): boolean {
  return isOracleAdapterRegistryRefusal(err);
}

// Adapter observations carry `oracle_id` + `asset_id`; the resolver still
// expects the legacy shape (`feed`). Re-shape without losing fields the
// resolver actually consumes.
export function adapterToLegacyObservation(
  obs: AdapterObservation,
  feed: OracleFeed,
): OracleObservation {
  return {
    feed,
    price: obs.price,
    feed_timestamp: obs.feed_timestamp,
    observed_at: obs.observed_at,
    source_id: obs.source_id,
    source_age_seconds: obs.source_age_seconds,
  };
}
