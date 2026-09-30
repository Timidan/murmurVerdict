// ─── Was this call actually published, and was it valid? ────────────────────
//
// The delivery sweep may only accept a sale on a silent buyer's behalf once
// the call is independently checkable by anyone. That is a fact about the
// chain, and murmur already ingests it: the Fhenix watcher writes
// `reveal_status` onto each sealed call as reveals land.
//
// So this reads murmur's own confirmed ingestion rather than asking an RPC
// again. Two reasons that is the right source. It is the SAME record the
// public pages are rendered from, so a buyer and the sweep cannot disagree
// about whether a call was revealed. And the ingestor already applies the
// confirmation depth, so a reveal that has not survived reorg depth is not yet
// `revealed` here.
//
// `invalid` is NOT a reveal for this purpose. A call the contract rejected was
// never delivered as a usable prediction, so it falls to the longstop and the
// buyer is refunded — the provider is not paid for it.
//
// `pending` is only an answer when the WATCHER is in a position to know. A
// call that reads pending because the reveal ingestor has not run since the
// horizon opened, or has stopped running altogether, is not "unrevealed"; it
// is "unobserved". Reporting false there would let a stalled watcher turn a
// delivered call into a refund at the longstop.
//
// "In a position to know" is `head_synced_at` — stamped only when a scan
// reaches the safe head — NOT the cursor's `updated_at`, which refreshes on
// every mid-catch-up batch. After downtime, a restarted watcher writes fresh
// `updated_at` values while its scan is still far behind the reveal block;
// deciding on that turned delivered calls into refunds (audit F-3).

import type Database from "better-sqlite3";

import { prep } from "./db-statements.js";
import type { RevealVerifier } from "./entitlement-delivery.js";

/** How long the head-sync watermark may age before pending reads as unknown. */
export const WATCHER_STALE_MS = 60 * 60 * 1000;

/** The safe head lags the chain head by the confirmation depth, so a scan that
 *  reached it at T has only covered blocks mined a few seconds earlier. One
 *  minute comfortably covers that lag on any chain murmur targets. */
export const HEAD_SYNC_HORIZON_MARGIN_MS = 60 * 1000;

export interface RevealFacts {
  reveal_status: string | null;
  revealed_at: string | null;
  /** When the call's public reveal window opened. */
  reveal_open_at: string;
}

/**
 * The decision, as a pure function, so it can be checked in node.
 *
 * `cursorHeadSyncedAt` is when the VerdictRevealed ingestor last completed a
 * scan to the safe head; null when it never has (including mid-catch-up after
 * downtime, when only `updated_at` moves).
 */
export function decideReveal(
  row: RevealFacts | null,
  cursorHeadSyncedAt: string | null,
  nowMs: number,
): boolean | null {
  // No row at all is not "no reveal" — it is "murmur does not know about this
  // call", which is a different thing and must not settle anything.
  if (!row) return null;
  if (row.reveal_status === "revealed" && row.revealed_at) return true;
  // Explicitly terminal and NOT a valid reveal.
  if (row.reveal_status === "invalid" || row.reveal_status === "missed") return false;

  // Pending. Only a head-complete scan proves the chain was checked past the
  // horizon; a fresh-but-catching-up cursor cannot say, and must not refund.
  if (!cursorHeadSyncedAt) return null;
  const headSyncedMs = Date.parse(cursorHeadSyncedAt);
  const horizonMs = Date.parse(row.reveal_open_at);
  if (!Number.isFinite(headSyncedMs) || !Number.isFinite(horizonMs)) return null;
  if (headSyncedMs < horizonMs + HEAD_SYNC_HORIZON_MARGIN_MS) return null;
  if (nowMs - headSyncedMs > WATCHER_STALE_MS) return null;
  // The watcher has scanned the whole chain past the horizon and is alive:
  // nothing was published.
  return false;
}

export function createDbRevealVerifier(
  db: Database.Database,
  now: () => Date,
): RevealVerifier {
  return {
    async hasValidPublicReveal({ chainId, contractAddress, onchainCallId }) {
      const row = prep(
        db,
        `SELECT reveal_status, revealed_at, reveal_open_at FROM fhenix_sealed_calls
          WHERE chain_id = @chain_id
            AND lower(contract_address) = lower(@contract_address)
            AND lower(onchain_call_id) = lower(@onchain_call_id)`,
      ).get({
        chain_id: chainId,
        contract_address: contractAddress,
        onchain_call_id: onchainCallId,
      }) as RevealFacts | undefined;

      const cursor = prep(
        db,
        `SELECT head_synced_at FROM fhenix_event_cursors
          WHERE chain_id = @chain_id
            AND lower(contract_address) = lower(@contract_address)
            AND event_name = 'VerdictRevealed'`,
      ).get({ chain_id: chainId, contract_address: contractAddress }) as
        | { head_synced_at: string | null }
        | undefined;

      return decideReveal(row ?? null, cursor?.head_synced_at ?? null, now().getTime());
    },
  };
}
