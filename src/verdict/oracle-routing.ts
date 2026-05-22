// Bridge between feed strings and the data-driven oracles registry.
//
// History: v0.1 modeled oracle providers as opaque strings ("chainlink:base:
// ETH-USD"). T0Policy stamped these strings on each call's oracle_policies
// row, the resolver dispatched to the OracleClient by string. Phase 2a
// rewired the resolver to route observations through the adapter registry
// using a feedToOracleId() map. The sealed Fhenix submit path derives
// T0Policy from the resolved market row, mapping
// `markets.{primary,fallback}_oracle_id` (registry oracle_id) back to the
// canonical feed string for receipt/oracle_policies persistence.
//
// Why preserve feed strings at all? Two reasons:
//   1. Receipts already issued embed `oracle_policy.primary_feed` as a
//      literal string. Backwards compatibility means we keep emitting that
//      shape; verifiers re-parse it under the wider enum without trouble.
//   2. The /verify path and downstream consumers read feed strings directly
//      from the receipt subject. Migrating those to oracle_id is a separate
//      reframe (Codex's "ResolutionSubject end-to-end") that we're
//      explicitly deferring per option C of the audit response.
//
// Adding a new feed: insert a row in `oracles` registry, append the
// canonical feed string to OracleFeedSchema's enum, and add a line to both
// maps below. The enum stays closed so a typo in `markets.primary_oracle_id`
// surfaces here at submit time, not during the resolver tick.

import type Database from "better-sqlite3";
import { oraclesRepo, type MarketRow, type OracleRow } from "./db.js";
import type { OracleFeed, T0Policy } from "./schema.js";

// ─── Bidirectional feed ↔ oracle_id map ─────────────────────────────────────

const FEED_TO_ORACLE_ID = {
  "chainlink:base:ETH-USD": "chainlink-base-eth-usd",
  "chainlink:base:BTC-USD": "chainlink-base-btc-usd",
  "chainlink:base:SOL-USD": "chainlink-base-sol-usd",
  "pyth:base:ETH-USD": "pyth-base-eth-usd",
  "pyth:base:BTC-USD": "pyth-base-btc-usd",
  "pyth:base:SOL-USD": "pyth-base-sol-usd",
  "pyth:base:BNB-USD": "pyth-base-bnb-usd",
} as const satisfies Record<OracleFeed, string>;

const ORACLE_ID_TO_FEED: Readonly<Record<string, OracleFeed>> = (() => {
  const inverse: Record<string, OracleFeed> = {};
  for (const [feed, id] of Object.entries(FEED_TO_ORACLE_ID)) {
    inverse[id] = feed as OracleFeed;
  }
  return inverse;
})();

export function feedToOracleId(feed: OracleFeed): string {
  return FEED_TO_ORACLE_ID[feed];
}

export function oracleIdToFeed(oracle_id: string): OracleFeed | null {
  return ORACLE_ID_TO_FEED[oracle_id] ?? null;
}

// ─── Policy derivation ──────────────────────────────────────────────────────

export class PolicyDerivationError extends Error {
  constructor(
    message: string,
    public readonly market_id: string,
    public readonly cause:
      | "primary_oracle_unknown"
      | "primary_oracle_not_listed"
      | "primary_feed_unmapped"
      | "primary_oracle_asset_mismatch"
      | "fallback_oracle_unknown"
      | "fallback_oracle_not_listed"
      | "fallback_feed_unmapped"
      | "fallback_oracle_asset_mismatch"
      | "fallback_max_staleness_missing",
    public readonly context?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "PolicyDerivationError";
  }
}

function loadListedOracle(
  db: Database.Database,
  oracle_id: string,
  market: MarketRow,
  side: "primary" | "fallback",
): OracleRow {
  const row = oraclesRepo.get(db, oracle_id);
  if (!row) {
    throw new PolicyDerivationError(
      `market ${market.market_id} ${side} oracle ${oracle_id} not in registry`,
      market.market_id,
      side === "primary" ? "primary_oracle_unknown" : "fallback_oracle_unknown",
    );
  }
  if (row.status !== "listed") {
    throw new PolicyDerivationError(
      `market ${market.market_id} ${side} oracle ${oracle_id} status=${row.status}; needed 'listed'`,
      market.market_id,
      side === "primary" ? "primary_oracle_not_listed" : "fallback_oracle_not_listed",
      { status: row.status },
    );
  }
  // P3 Phase 2d hardening (Codex audit Bug 3): ensure the oracle row's
  // asset_id matches the market's. A miswired registry row (operator typo
  // setting a market's primary_oracle_id to an oracle that prices a
  // different asset) would otherwise silently stamp the wrong feed.
  if (row.asset_id !== market.asset_id) {
    throw new PolicyDerivationError(
      `market ${market.market_id} ${side} oracle ${oracle_id} prices ${row.asset_id}, market is ${market.asset_id}`,
      market.market_id,
      side === "primary"
        ? "primary_oracle_asset_mismatch"
        : "fallback_oracle_asset_mismatch",
      { oracle_asset_id: row.asset_id, market_asset_id: market.asset_id },
    );
  }
  return row;
}

function feedForOracle(
  oracle: OracleRow,
  market_id: string,
  side: "primary" | "fallback",
): OracleFeed {
  const feed = oracleIdToFeed(oracle.oracle_id);
  if (!feed) {
    throw new PolicyDerivationError(
      `oracle ${oracle.oracle_id} has no feed-string mapping (FEED_TO_ORACLE_ID)`,
      market_id,
      side === "primary" ? "primary_feed_unmapped" : "fallback_feed_unmapped",
    );
  }
  return feed;
}

/**
 * Derive a per-call T0Policy from the resolved market row + the oracles
 * registry. Fail-closed if any referenced oracle isn't 'listed' — closes
 * the Codex-flagged silent-wrong-oracle footgun where a `markets.status`
 * flip on a market whose oracle was draft would let calls mint and resolve
 * against the wrong feed.
 *
 * Phase 2d: fallback is OPTIONAL. Codex's audit recommended sub-hour
 * markets be Pyth-only (Chainlink Base heartbeat is too coarse for 5m/15m
 * horizons). If markets.fallback_oracle_id is null, we derive a policy
 * without a fallback path; the resolver will only try the primary feed
 * and mark the call oracle_unavailable past extended grace. The pair
 * (fallback_oracle_id, fallback_max_staleness_sec) MUST travel together
 * — having one without the other is a misconfigured market and we
 * fail closed.
 *
 * Wave 4a: returns `null` for adapter-resolved markets (oracle kind
 * 'external_adapter'). Polymarket Gamma + future event-adapter markets
 * resolve via `adapter.observeResolution(...)`, never anchor against a
 * price feed — there is no T0Policy to derive. The resolver's tick path
 * branches on the same condition (no policy → no T0 anchor; the adapter
 * dispatch reads outcome state directly on each pass).
 */
export function derivePolicyFromMarket(
  db: Database.Database,
  market: MarketRow,
): T0Policy | null {
  // Primary
  const primary = loadListedOracle(
    db,
    market.primary_oracle_id,
    market,
    "primary",
  );
  // Wave 4a — external_adapter oracles short-circuit. They have no
  // price-feed mapping, so feedForOracle would (correctly) throw
  // primary_feed_unmapped. Adapter dispatch handles resolution end-to-
  // end via observeResolution; the resolver tick reads this null and
  // skips T0 anchoring for the call.
  if (primary.kind === "external_adapter") {
    return null;
  }
  const primary_feed = feedForOracle(primary, market.market_id, "primary");

  // Fallback — optional at Phase 2d but the two fields must agree.
  const hasFallbackOracle = market.fallback_oracle_id !== null;
  const hasFallbackStaleness = market.fallback_max_staleness_sec !== null;
  if (hasFallbackOracle !== hasFallbackStaleness) {
    throw new PolicyDerivationError(
      `market ${market.market_id} has fallback_oracle_id without fallback_max_staleness_sec (or vice versa) — both must travel together`,
      market.market_id,
      "fallback_max_staleness_missing",
    );
  }

  if (hasFallbackOracle) {
    const fallback = loadListedOracle(
      db,
      market.fallback_oracle_id!,
      market,
      "fallback",
    );
    const fallback_feed = feedForOracle(
      fallback,
      market.market_id,
      "fallback",
    );
    return {
      primary_feed,
      fallback_feed,
      primary_max_staleness_sec: market.primary_max_staleness_sec,
      fallback_max_staleness_sec: market.fallback_max_staleness_sec!,
      t0_grace_seconds: market.t0_grace_seconds,
      t0_extended_grace_seconds: market.t0_extended_grace_seconds,
    };
  }

  // Pyth-only / no-fallback path — sub-hour markets, BNB markets.
  return {
    primary_feed,
    primary_max_staleness_sec: market.primary_max_staleness_sec,
    t0_grace_seconds: market.t0_grace_seconds,
    t0_extended_grace_seconds: market.t0_extended_grace_seconds,
  };
}
