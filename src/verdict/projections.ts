/**
 * Public projections for committed-mode calls (P2 Phase E).
 *
 * The submissions table still carries plaintext columns (Phase A
 * was additive); the daemon's PUBLIC API surfaces must scrub those
 * columns when privacy_mode='committed' until a valid reveal row exists.
 *
 * Normally a resolved committed call has a call_reveals row because the
 * resolver cannot score without one. The exception is terminal oracle
 * unavailability, which can happen before horizon and without a reveal.
 * Status alone is therefore not enough to unhide plaintext.
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
  /** Wave 4b — receipts subsystem dropped. Field accepted for back-compat
   *  with callers that still pass it; the projection ignores any value. */
  acceptance_receipt_hash?: string | null;
  // Legacy plaintext columns on `submissions`. After Phase E scrub these are
  // NULL on committed-mode rows even when reveal_hash_valid=1.
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
  reveal_hash_valid?: number | boolean | null;
  // Mirror columns from `call_reveals`. Read paths LEFT JOIN call_reveals and
  // forward these so the projection can hydrate post-Phase-E rows whose
  // submissions plaintext was NULL'd. When reveal_hash_valid is truthy we
  // prefer the revealed_* values over the (now-NULL) submission columns.
  revealed_side?: string | null;
  revealed_asset_id?: string | null;
  revealed_horizon_hours?: number | null;
  revealed_confidence?: number | null;
  revealed_rationale?: string | null;
  revealed_strategy_tag?: string | null;
}

export interface PublicCallProjection {
  call_id: string;
  agent_slug?: string;
  status: string;
  accepted_at: string;
  privacy_mode: string;
  commit_hash: string | null;
  /** Wave 4b — always null (receipts subsystem dropped). Field stays on
   *  the public projection for one release so already-deployed dashboards
   *  don't crash on missing keys; safe to drop after Wave 5. */
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
 *   - committed-mode + non-pending status → REVEAL only when a valid
 *     call_reveals row exists. This prevents oracle_unavailable terminal
 *     rows from leaking before horizon.
 *   - legacy_plaintext + any status → REVEAL (no commitment was made)
 */
export function shouldExposePlaintext(
  privacy_mode: string | null | undefined,
  status: string,
  reveal_hash_valid?: number | boolean | null,
): boolean {
  if (privacy_mode !== "committed") return true;
  if (PENDING_STATUSES.has(status as never)) return false;
  return reveal_hash_valid === true || reveal_hash_valid === 1;
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
    // Wave 4b — receipts subsystem dropped. Always null on the wire.
    acceptance_receipt_hash: null,
  };
  if (shouldExposePlaintext(privacy_mode, row.status, row.reveal_hash_valid)) {
    // Phase E scrubs side/asset_id/horizon_hours/confidence/rationale/
    // strategy_tag on submissions for committed-mode rows. The plaintext
    // still lives in call_reveals when reveal_hash_valid=1, so we prefer
    // the legacy submission columns when present and fall back to the
    // call_reveals mirror columns. COALESCE is done at the projection
    // layer so every read path stays consistent without each one knowing
    // about Phase E.
    const side = row.side ?? row.revealed_side ?? null;
    const asset_id = row.asset_id ?? row.revealed_asset_id ?? null;
    const horizon_hours =
      typeof row.horizon_hours === "number"
        ? row.horizon_hours
        : typeof row.revealed_horizon_hours === "number"
          ? row.revealed_horizon_hours
          : null;
    const confidence =
      typeof row.confidence === "number"
        ? row.confidence
        : typeof row.revealed_confidence === "number"
          ? row.revealed_confidence
          : null;
    const rationale = row.rationale ?? row.revealed_rationale ?? null;
    const strategy_tag = row.strategy_tag ?? row.revealed_strategy_tag ?? null;
    if (side) projection.side = side;
    if (asset_id) projection.asset_id = asset_id;
    if (typeof horizon_hours === "number") projection.horizon_hours = horizon_hours;
    if (typeof confidence === "number") projection.confidence = confidence;
    if (rationale) projection.rationale = rationale;
    if (strategy_tag) projection.strategy_tag = strategy_tag;
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
