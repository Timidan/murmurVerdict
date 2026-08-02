/**
 * Pure mapping — Polymarket CLOB market → universal Outcome.
 *
 * Fallback-only: this runs when a market has vanished from Gamma after its
 * endDate (5-minute micro-markets get dropped from `/markets?condition_ids`
 * minutes after close) while the public CLOB `GET /markets/{conditionId}`
 * still serves `closed` + per-token `winner` flags.
 *
 * Fail-closed contract (per the CLOB-fallback review):
 *   - Labels match ONLY as a trim+lowercase bijection: exactly two unique
 *     stored labels, exactly two unique CLOB labels, every CLOB label maps
 *     to exactly one stored label. No semantic aliasing (never `Yes → Up`).
 *   - When registration persisted a `normalized label → clob token_id` map,
 *     token-ID identity is preferred; a mismatch there is a hard `pending`.
 *   - Zero winners, `archived:true`, and `is_50_50_outcome:true` all hold
 *     `pending` in this release (never `invalid` — Gamma owns invalid /
 *     dispute mapping whenever it is available).
 *   - More than one winner or winner/loser prices inconsistent with 1/0 →
 *     `pending` plus an error code (inconsistent CLOB state, do not score).
 *   - `resolvedAt` comes from the STORED endDate (the CLOB row has no close
 *     stamp we trust), matching Gamma's endDate fallback in transform.ts.
 *
 * Side-effect-free and NEVER throws — same posture as transform.ts.
 */

import type { Outcome } from "../../verdict/markets-core.js";
import type { ClobMarketSnapshot } from "./clob-client.js";

export const CLOB_SOURCE_PROTOCOL = "polymarket-clob-fallback" as const;

/** Canonical label normalization for the stored↔CLOB bijection. */
export function normalizeOutcomeLabel(label: string): string {
  return label.trim().toLowerCase();
}

export interface ClobOutcomeInput {
  /** The conditionId the caller is resolving (from the stored market row). */
  conditionId: string;
  /** Stored `config_json.outcomes` — the canonical payout-vector order. */
  storedOutcomes: readonly string[];
  /** Optional stored `normalized label → clob token_id` map (config.ts). */
  storedClobTokenIds?: Record<string, string> | undefined;
  /** Stored `config_json.endDate` — the resolvedAt source. */
  endDate: string | null | undefined;
  snapshot: ClobMarketSnapshot;
}

export type ClobOutcomeResult =
  | { kind: "outcome"; outcome: Outcome }
  | { kind: "pending"; error: string | null };

const pending = (error: string | null): ClobOutcomeResult => ({
  kind: "pending",
  error,
});

/**
 * Map a CLOB snapshot to a binary one-hot {@link Outcome} aligned to the
 * STORED outcomes order, or a `pending` sentinel with an error code.
 */
export function clobMarketToOutcome(input: ClobOutcomeInput): ClobOutcomeResult {
  const snapshot = input.snapshot;
  if (
    snapshot.condition_id.toLowerCase() !== input.conditionId.toLowerCase()
  ) {
    return pending("condition_id_mismatch");
  }
  if (snapshot.closed !== true) return pending(null);
  // Held-pending states: no invalid/cancelled inference from CLOB in this
  // release — a real fixture (or the on-chain CTF payout) must confirm the
  // representation first.
  if (snapshot.archived === true) return pending("archived_held_pending");
  if (snapshot.is_50_50_outcome === true) {
    return pending("is_50_50_held_pending");
  }

  const tokens = snapshot.tokens;
  if (tokens.length !== 2) return pending("token_cardinality");
  if (tokens[0]!.token_id === tokens[1]!.token_id) {
    return pending("duplicate_token_id");
  }

  const winners = tokens.filter((t) => t.winner === true);
  if (winners.length === 0) return pending(null); // UMA not sealed yet
  if (winners.length > 1) return pending("multiple_winners");
  const winner = winners[0]!;
  const loser = tokens.find((t) => t !== winner)!;
  if (winner.price !== 1 || loser.price !== 0) {
    return pending("price_winner_inconsistent");
  }

  const winnerStoredIndex = storedIndexForWinner(input, tokens, winner);
  if (typeof winnerStoredIndex === "string") return pending(winnerStoredIndex);

  const endDateMs =
    typeof input.endDate === "string" ? Date.parse(input.endDate) : Number.NaN;
  if (!Number.isFinite(endDateMs)) return pending("missing_end_date");

  return {
    kind: "outcome",
    outcome: {
      kind: "binary",
      payoutNumerators: winnerStoredIndex === 0 ? [1n, 0n] : [0n, 1n],
      payoutDenominator: 1n,
      resolvedAt: Math.floor(endDateMs / 1000),
      evidence: {
        sourceProtocol: CLOB_SOURCE_PROTOCOL,
        sourceId: snapshot.condition_id,
        raw: snapshot,
      },
    },
  };
}

/**
 * Resolve the winner token to a stored-outcomes index (0 | 1), or an error
 * code string on any bijection failure.
 */
function storedIndexForWinner(
  input: ClobOutcomeInput,
  tokens: ClobMarketSnapshot["tokens"],
  winner: ClobMarketSnapshot["tokens"][number],
): 0 | 1 | string {
  const stored = input.storedOutcomes;
  if (
    stored.length !== 2 ||
    stored.some((label) => typeof label !== "string" || label.trim().length === 0)
  ) {
    return "stored_labels_invalid";
  }
  const storedNorm = stored.map((label) => normalizeOutcomeLabel(label));
  if (storedNorm[0] === storedNorm[1]) return "stored_labels_not_unique";

  // Preferred path: immutable token-ID identity persisted at registration.
  const idMap = input.storedClobTokenIds;
  if (idMap && typeof idMap === "object") {
    const id0 = idMap[storedNorm[0]!];
    const id1 = idMap[storedNorm[1]!];
    if (
      typeof id0 === "string" &&
      id0.length > 0 &&
      typeof id1 === "string" &&
      id1.length > 0
    ) {
      if (id0 === id1) return "token_id_map_not_unique";
      // Fail closed: a stored map that doesn't cover BOTH response tokens
      // means the response belongs to a different token pair.
      const ids = tokens.map((t) => t.token_id);
      if (!ids.includes(id0) || !ids.includes(id1)) {
        return "token_id_mismatch";
      }
      if (winner.token_id === id0) return 0;
      if (winner.token_id === id1) return 1;
      return "token_id_mismatch";
    }
    // Incomplete map (legacy row / drifted labels) → fall through to labels.
  }

  const clobNorm = tokens.map((t) => normalizeOutcomeLabel(t.outcome));
  if (
    clobNorm.some((label) => label.length === 0) ||
    clobNorm[0] === clobNorm[1]
  ) {
    return "clob_labels_not_unique";
  }
  // Full 1:1 match — every CLOB label must equal exactly one stored label.
  if (
    !clobNorm.every((label) => storedNorm.includes(label)) ||
    !storedNorm.every((label) => clobNorm.includes(label))
  ) {
    return "label_bijection_failed";
  }
  const winnerNorm = normalizeOutcomeLabel(winner.outcome);
  return storedNorm[0] === winnerNorm ? 0 : 1;
}
