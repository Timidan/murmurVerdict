// Shared call lifecycle vocabulary — the ONE browser-safe copy of the daemon's
// call status set plus the pure classification predicates the dashboard uses to
// bucket a call by lifecycle / outcome. See wire-agent.ts for the rules that
// keep this module browser-safe: no backend imports, no runtime side effects,
// pure functions over the union only.
//
// `WireCallStatus` mirrors the daemon's CallStatusSchema enum
// (src/verdict/schema.ts). The producer guard in
// src/verdict/wire-contract-guards.ts pins it to the daemon's authoritative
// `CallStatus` with Assert<Equals<…>>, so a daemon-side rename/removal fails the
// DAEMON build instead of silently drifting the SPA's classification.

/** The daemon's authoritative call status set (CallStatusSchema). */
export type WireCallStatus =
  | "submitted"
  | "preflighted"
  | "accepted"
  | "pending_t0"
  | "pending_t1"
  | "resolved"
  | "disputed"
  | "re_resolved"
  | "rejected"
  | "invalid_reveal"
  | "missed_reveal";

/** The settled-outcome vocabulary (OutcomeSchema, src/verdict/schema.ts). Not a
 *  status — it rides in from t1_resolutions on a resolved call. */
export type WireCallOutcome = "win" | "loss" | "void" | "oracle_unavailable";

/** Coarse outcome class for scoring/stat buckets: `win`/`loss` are the only
 *  SCORED outcomes; `void` folds the settled-but-unscored pair (void +
 *  oracle_unavailable). */
export type WireCallOutcomeClass = "win" | "loss" | "void";

// Canonical PENDING statuses — EXACTLY the set the leaderboard counts as
// pending_calls (src/verdict/leaderboard-call-summary.ts isPendingLeaderboardStatus).
// Sharing the literal set keeps every consumer's pending tally in lockstep with
// the leaderboard for the same rows.
const PENDING_CALL_STATUSES: ReadonlySet<string> = new Set<WireCallStatus>([
  "accepted",
  "pending_t0",
  "pending_t1",
]);

// Terminal statuses that never carry a win/loss/void outcome — the
// pre-acceptance rejection + the sealed-Fhenix reveal failures. Neither pending
// (they will never resolve) nor scored.
const TERMINAL_FAILURE_STATUSES: ReadonlySet<string> = new Set<WireCallStatus>([
  "rejected",
  "invalid_reveal",
  "missed_reveal",
]);

/** True while the call is still awaiting resolution (accepted / pending_t0 /
 *  pending_t1). */
export function isPendingCallStatus(status: string): boolean {
  return PENDING_CALL_STATUSES.has(status);
}

/** True for the terminal reveal/rejection failures — settled without a scored
 *  or void outcome. */
export function isTerminalFailureStatus(status: string): boolean {
  return TERMINAL_FAILURE_STATUSES.has(status);
}

/**
 * Classify a call's public outcome literal into a coarse scoring bucket, or
 * `null` when the row carries no settled outcome yet (pending / undefined).
 * `win`/`loss` are scored; `void`/`oracle_unavailable` both fold to `void`
 * (settled but unscored).
 */
export function classifyCallOutcome(
  outcome: string | null | undefined,
): WireCallOutcomeClass | null {
  if (outcome === "win") return "win";
  if (outcome === "loss") return "loss";
  if (outcome === "void" || outcome === "oracle_unavailable") return "void";
  return null;
}
