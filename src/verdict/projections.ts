/**
 * Public call projection, shared by every public surface so they can't drift.
 * Plaintext (side, asset, confidence, rationale, strategy) is never surfaced.
 */

export interface CallRowFields {
  call_id: string;
  status: string;
  accepted_at: string;
  privacy_mode?: string | null;
  commit_hash?: string | null;
  /** Accepted from callers but ignored. */
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
  /** Always null; kept so deployed dashboards don't break on a missing key. */
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
  // Resolved-side fields are public and forwarded when the row carries them.
  return {
    call_id: row.call_id,
    ...(agent_slug ? { agent_slug } : {}),
    status: row.status,
    accepted_at: row.accepted_at,
    privacy_mode,
    commit_hash: row.commit_hash ?? null,
    // Always null on the wire.
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
