/**
 * Public projections for verdict calls.
 *
 * Wave 2b — under FHE-mandatory every submission is operator-blind:
 * plaintext (side / asset_id / horizon_hours / confidence / rationale /
 * strategy_tag) is never surfaced. Resolved-side fields (outcome,
 * call_score, signed_return, resolved_at) come from t1_resolutions and
 * are added by consumers downstream of the projection; this helper
 * returns only the operator-blind core.
 *
 * Single helper used from every leak surface (feed.ts, api.ts,
 * events.ts, mcp/, calls.xml RSS) so we don't have N implementations
 * drifting apart.
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
  // Legacy plaintext columns on `submissions`. Under FHE-mandatory these
  // are NULL on every row; the projection no longer surfaces them, but the
  // shape is kept so SQL callers can still forward arbitrary row payloads
  // without rewriting their type cast at every call site.
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
  /** Wave 4b — always null (receipts subsystem dropped). Field stays on
   *  the public projection for one release so already-deployed dashboards
   *  don't crash on missing keys; safe to drop after Wave 5. */
  acceptance_receipt_hash: string | null;
  // Wave 2b — under FHE-mandatory the projection never populates these.
  // Fields kept on the interface so already-deployed consumers that
  // read `projected.side` etc. compile cleanly (the read is undefined).
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
  submitted_at?: string;
}

/**
 * Wave 2b — under FHE-mandatory, every submission is operator-blind and
 * plaintext is never surfaced through public projections. This helper is
 * retained as a stub for back-compat with consumers that still call it,
 * but the answer is always `false`.
 */
export function shouldExposePlaintext(
  _privacy_mode: string | null | undefined,
  _status: string,
  _reveal_hash_valid?: number | boolean | null,
): boolean {
  return false;
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
  const privacy_mode = row.privacy_mode ?? "fhe_direct";
  // Wave 2b — under FHE-mandatory the projection is always operator-blind.
  // Plaintext (side / asset_id / horizon_hours / confidence / rationale /
  // strategy_tag) is never surfaced. The projection returns only the
  // operator-blind core: identifier, status, timestamps, privacy_mode,
  // commit_hash, acceptance_receipt_hash.
  return {
    call_id: row.call_id,
    ...(agent_slug ? { agent_slug } : {}),
    status: row.status,
    accepted_at: row.accepted_at,
    privacy_mode,
    commit_hash: row.commit_hash ?? null,
    // Wave 4b — receipts subsystem dropped. Always null on the wire.
    acceptance_receipt_hash: null,
  };
}
