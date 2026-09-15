// Browser-safe call status set plus pure predicates that bucket a call by lifecycle/outcome.
// `WireCallStatus` is pinned to the daemon's `CallStatus` in wire-contract-guards.ts.

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

/** Settled outcome from t1_resolutions; not a status. */
export type WireCallOutcome = "win" | "loss" | "void" | "oracle_unavailable";

/** Only `win`/`loss` are scored; `void` covers void + oracle_unavailable. */
export type WireCallOutcomeClass = "win" | "loss" | "void";

// Must equal the leaderboard's pending set (isPendingLeaderboardStatus).
const PENDING_CALL_STATUSES: ReadonlySet<string> = new Set<WireCallStatus>([
  "accepted",
  "pending_t0",
  "pending_t1",
]);

// Terminal statuses with no outcome: neither pending nor scored.
const TERMINAL_FAILURE_STATUSES: ReadonlySet<string> = new Set<WireCallStatus>([
  "rejected",
  "invalid_reveal",
  "missed_reveal",
]);

export function isPendingCallStatus(status: string): boolean {
  return PENDING_CALL_STATUSES.has(status);
}

export function isTerminalFailureStatus(status: string): boolean {
  return TERMINAL_FAILURE_STATUSES.has(status);
}

/** Coarse scoring bucket, or null when the call has no settled outcome yet. */
export function classifyCallOutcome(
  outcome: string | null | undefined,
): WireCallOutcomeClass | null {
  if (outcome === "win") return "win";
  if (outcome === "loss") return "loss";
  if (outcome === "void" || outcome === "oracle_unavailable") return "void";
  return null;
}
