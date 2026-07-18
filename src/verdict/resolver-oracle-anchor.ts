import type Database from "better-sqlite3";

import type {
  OracleFeed,
  T0Policy,
} from "./schema.js";
import { feedToOracleId } from "./oracle-routing.js";
import {
  OracleClient,
  type OracleObservation,
} from "../integrations/oracle.js";
import { observeOracle } from "../integrations/oracles/registry.js";
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
    // Single seam ⇒ single taxonomy. The oracle Adapter Registry is now the
    // sole observation source, so every classified failure arrives as an
    // AdapterError. Resolver policy reads the pending reason to retry, defer,
    // or eventually mark oracle-unavailable past extended grace.
    if (err instanceof AdapterError) {
      return { kind: "pending", reason: `oracle_error:${err.cause_kind}` };
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

// The oracle Adapter Registry is the SOLE observation seam. Route the feed's
// canonical oracle_id through the registry with the daemon-owned Adapter
// context (OracleClient here is only the construction-time context provider),
// then reshape into the legacy receipt Records shape the Resolution Lifecycle
// persists. There is no second reader to fall back to: registry, config, and
// runtime failures all surface as AdapterError so resolver policy can retry,
// defer, or mark oracle-unavailable consistently.
export async function observeResolverFeed(
  db: Database.Database,
  oracle: OracleClient,
  feed: OracleFeed,
): Promise<OracleObservation> {
  const oracle_id = feedToOracleId(feed);
  const obs = await observeOracle(db, oracle_id, oracle.adapterContext());
  return adapterToLegacyObservation(obs, feed);
}

// Persistence-edge reshape: Adapter observations carry `oracle_id` +
// `asset_id` (the canonical identity), but already-issued receipts and the
// resolutions Records embed the legacy `feed` string. Stamp `feed` from the
// caller's mapping and carry the price/timestamp fields through unchanged.
// (Full retirement of this reshape is blocked by out-of-scope consumers that
// read `.feed` — see resolution-native-price.ts / resolver.ts re-export.)
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
