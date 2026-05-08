// P3 Phase 2b — bridge between the legacy "feed string" world and the
// data-driven oracles registry.
//
// History: v0.1 modeled oracle providers as opaque strings ("chainlink:base:
// ETH-USD"). T0Policy stamped these strings on each call's oracle_policies
// row, the resolver dispatched to the OracleClient by string. Phase 2a
// rewired the resolver to route observations through the adapter registry
// using a feedToOracleId() map. Phase 2b finishes the loop: submitCall now
// DERIVES the T0Policy from the resolved market row, mapping
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
      | "fallback_oracle_unknown"
      | "fallback_oracle_not_listed"
      | "fallback_feed_unmapped"
      | "fallback_required_at_v0_2_5",
    public readonly context?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "PolicyDerivationError";
  }
}

function loadListedOracle(
  db: Database.Database,
  oracle_id: string,
  market_id: string,
  side: "primary" | "fallback",
): OracleRow {
  const row = oraclesRepo.get(db, oracle_id);
  if (!row) {
    throw new PolicyDerivationError(
      `market ${market_id} ${side} oracle ${oracle_id} not in registry`,
      market_id,
      side === "primary" ? "primary_oracle_unknown" : "fallback_oracle_unknown",
    );
  }
  if (row.status !== "listed") {
    throw new PolicyDerivationError(
      `market ${market_id} ${side} oracle ${oracle_id} status=${row.status}; needed 'listed'`,
      market_id,
      side === "primary" ? "primary_oracle_not_listed" : "fallback_oracle_not_listed",
      { status: row.status },
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
 * registry. Fail-closed if either referenced oracle isn't 'listed' — closes
 * the Codex-flagged silent-wrong-oracle footgun where a `markets.status`
 * flip on a market whose oracle was draft would let calls mint and resolve
 * against the wrong feed.
 *
 * Phase 2b requires both primary and fallback. Markets without a
 * fallback_oracle_id (e.g., BNB at every horizon since there's no
 * Chainlink Base feed) cannot derive a policy — they stay 'draft' until
 * the fallback story is settled (probably by adding a second Pyth path
 * or relaxing T0PolicySchema to make fallback_feed optional).
 */
export function derivePolicyFromMarket(
  db: Database.Database,
  market: MarketRow,
): T0Policy {
  // Primary
  const primary = loadListedOracle(
    db,
    market.primary_oracle_id,
    market.market_id,
    "primary",
  );
  const primary_feed = feedForOracle(primary, market.market_id, "primary");

  // Fallback (required at v0.2.5)
  if (!market.fallback_oracle_id || market.fallback_max_staleness_sec === null) {
    throw new PolicyDerivationError(
      `market ${market.market_id} has no fallback_oracle_id; v0.2.5 requires both primary and fallback`,
      market.market_id,
      "fallback_required_at_v0_2_5",
    );
  }
  const fallback = loadListedOracle(
    db,
    market.fallback_oracle_id,
    market.market_id,
    "fallback",
  );
  const fallback_feed = feedForOracle(fallback, market.market_id, "fallback");

  return {
    primary_feed,
    fallback_feed,
    primary_max_staleness_sec: market.primary_max_staleness_sec,
    fallback_max_staleness_sec: market.fallback_max_staleness_sec,
    t0_grace_seconds: market.t0_grace_seconds,
    t0_extended_grace_seconds: market.t0_extended_grace_seconds,
  };
}
