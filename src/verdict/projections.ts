/**
 * Public projections for committed-mode calls (P2 Phase E).
 *
 * The submissions table still carries plaintext columns (Phase A
 * was additive); the daemon's PUBLIC API surfaces must scrub those
 * columns when (privacy_mode='committed' AND status is pre-horizon).
 *
 * Once the call is resolved, the plaintext was anchored against
 * canonical oracles and is part of the public score record — no
 * point hiding it. Same for legacy_plaintext rows where the agent
 * never committed to anything.
 *
 * Single helper used from every leak surface (feed.ts, api.ts,
 * events.ts, mcp/, calls.xml RSS) so we don't have N implementations
 * drifting apart.
 */

const PENDING_STATUSES = new Set([
  "accepted",
  "pending_t0",
  "pending_t1",
] as const);

export interface CallRowFields {
  call_id: string;
  status: string;
  accepted_at: string;
  privacy_mode?: string | null;
  commit_hash?: string | null;
  acceptance_receipt_hash?: string | null;
  side?: string | null;
  asset_id?: string | null;
  horizon_hours?: number | null;
  confidence?: number | null;
  rationale?: string | null;
  strategy_tag?: string | null;
  outcome?: string | null;
  call_score?: number | null;
  signed_return?: string | null;
  resolved_at?: string | null;
  submitted_at?: string | null;
}

export interface PublicCallProjection {
  call_id: string;
  agent_slug?: string;
  status: string;
  accepted_at: string;
  privacy_mode: string;
  commit_hash: string | null;
  acceptance_receipt_hash: string | null;
  // Plaintext fields — populated only when shouldExposePlaintext() returns true.
  side?: string;
  asset_id?: string;
  horizon_hours?: number;
  confidence?: number;
  rationale?: string;
  strategy_tag?: string;
  outcome?: string | null;
  call_score?: number | null;
  signed_return?: string | null;
  resolved_at?: string | null;
  submitted_at?: string | null;
}

/**
 * True when the projection should include plaintext (side, asset, horizon,
 * confidence, rationale, strategy_tag). False when it must be scrubbed.
 *
 * Rules:
 *   - committed-mode + pending status → SCRUB (the whole point of
 *     committed mode is hiding the call until horizon)
 *   - committed-mode + resolved/disputed/re_resolved → REVEAL (post-
 *     horizon, plaintext is on the public oracle record anyway)
 *   - legacy_plaintext + any status → REVEAL (no commitment was made)
 */
export function shouldExposePlaintext(
  privacy_mode: string | null | undefined,
  status: string,
): boolean {
  if (privacy_mode !== "committed") return true;
  return !PENDING_STATUSES.has(status as never);
}

/**
 * Project a call row for public consumption. `agent_slug` is added
 * when the surface needs it (the SQL caller usually JOINs agents
 * already and passes the slug in).
 */
export function projectCallRow(
  row: CallRowFields,
  agent_slug?: string,
): PublicCallProjection {
  const privacy_mode = row.privacy_mode ?? "legacy_plaintext";
  const projection: PublicCallProjection = {
    call_id: row.call_id,
    ...(agent_slug ? { agent_slug } : {}),
    status: row.status,
    accepted_at: row.accepted_at,
    privacy_mode,
    commit_hash: row.commit_hash ?? null,
    acceptance_receipt_hash: row.acceptance_receipt_hash ?? null,
  };
  if (shouldExposePlaintext(privacy_mode, row.status)) {
    if (row.side) projection.side = row.side;
    if (row.asset_id) projection.asset_id = row.asset_id;
    if (typeof row.horizon_hours === "number") projection.horizon_hours = row.horizon_hours;
    if (typeof row.confidence === "number") projection.confidence = row.confidence;
    if (row.rationale) projection.rationale = row.rationale;
    if (row.strategy_tag) projection.strategy_tag = row.strategy_tag;
    if (typeof row.submitted_at === "string") projection.submitted_at = row.submitted_at;
    // resolution-side fields surface even when scrubbed since they're
    // post-horizon canonical record. But scoped to non-pending statuses
    // by definition (resolved_at only exists for resolved calls).
    if (row.outcome) projection.outcome = row.outcome;
    if (row.call_score !== undefined) projection.call_score = row.call_score;
    if (row.signed_return !== undefined) projection.signed_return = row.signed_return;
    if (row.resolved_at) projection.resolved_at = row.resolved_at;
  }
  return projection;
}
