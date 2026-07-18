/**
 * Public projections for verdict calls.
 *
 * Under sealed Fhenix, every pending submission is operator-blind:
 * plaintext (side / asset_id / horizon_hours / confidence / rationale /
 * strategy_tag) is never surfaced. Resolved-side fields (outcome,
 * call_score, signed_return, resolved_at) come from t1_resolutions and
 * are added by consumers downstream of the projection; this helper
 * returns only the operator-blind core.
 *
 * Single helper used from every leak surface (feed.ts, api.ts,
 * events.ts, calls.xml RSS) so we don't have N implementations drifting
 * apart.
 */

export interface CallRowFields {
  call_id: string;
  status: string;
  accepted_at: string;
  privacy_mode?: string | null;
  commit_hash?: string | null;
  /** Wave 4b — receipts subsystem dropped. Field accepted for back-compat
   *  with callers that still pass it; the projection ignores any value. */
  acceptance_receipt_hash?: string | null;
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
  /** Wave 4b — always null (receipts subsystem dropped). Field stays on
   *  the public projection for one release so already-deployed dashboards
   *  don't crash on missing keys; safe to drop after Wave 5. */
  acceptance_receipt_hash: string | null;
  outcome?: string | null;
  call_score?: number | null;
  signed_return?: string | null;
  resolved_at?: string | null;
  submitted_at?: string;
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
  const privacy_mode = row.privacy_mode ?? "sealed_fhenix";
  // Under sealed Fhenix the projection is operator-blind until the public
  // reveal/resolution path decides what to expose.
  // Plaintext (side / asset_id / horizon_hours / confidence / rationale /
  // strategy_tag) is never surfaced.
  //
  // Codex bundle-review MAJOR fix — resolved-side fields (outcome /
  // call_score / signed_return / resolved_at) are PUBLIC: every public
  // surface (agent calls list, RSS, API views) wants them.
  // The pre-fix projection dropped them, so the agent-calls list rendered
  // "pending" for every resolved row. Forward them through when the
  // input row carries them; they stay undefined for surfaces that only
  // know the submission half (e.g. pending list).
  return {
    call_id: row.call_id,
    ...(agent_slug ? { agent_slug } : {}),
    status: row.status,
    accepted_at: row.accepted_at,
    privacy_mode,
    commit_hash: row.commit_hash ?? null,
    // Wave 4b — receipts subsystem dropped. Always null on the wire.
    acceptance_receipt_hash: null,
    ...(row.submitted_at !== undefined && row.submitted_at !== null
      ? { submitted_at: row.submitted_at }
      : {}),
    ...(row.outcome !== undefined ? { outcome: row.outcome } : {}),
    ...(row.call_score !== undefined ? { call_score: row.call_score } : {}),
    ...(row.signed_return !== undefined
      ? { signed_return: row.signed_return }
      : {}),
    ...(row.resolved_at !== undefined ? { resolved_at: row.resolved_at } : {}),
  };
}
