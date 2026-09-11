// Shared REST wire types — call projections (agent calls list, single call
// detail, per-market calls feed). Browser-safe; see wire-agent.ts for rules.
//
// These operator-blind projections never surface plaintext (side / asset_id /
// horizon_hours / confidence / rationale) for a PENDING sealed call. The
// plaintext fields kept below are optional because they can appear post-reveal
// via the fhenix.revealed_verdict path / legacy rows; the daemon guard pins
// the fields the daemon actually guarantees.

/** One row of GET /v1/agents/:slug/calls. Mirrors the daemon's
 *  PublicAgentCallProjection (src/verdict/sealed-call-public-projection.ts).
 *  Resolution fields are optional — the daemon only forwards them when the
 *  underlying row carries them. */
export interface WireAgentCallRow {
  call_id: string;
  status: string;
  privacy_mode?: string;
  commit_hash?: string | null;
  acceptance_receipt_hash?: string | null;
  adapter_id?: string;
  market_family?: string;
  market_id?: string;
  // Pre-reveal-absent plaintext; can appear post-reveal / on legacy rows.
  asset_id?: string;
  side?: "BUY" | "SELL";
  horizon_hours?: number;
  confidence?: number;
  submitted_at?: string;
  accepted_at: string;
  outcome?: string | null;
  call_score?: number | null;
  signed_return?: string | null;
  resolved_at?: string | null;
}

/** GET /v1/calls/:call_id. Mirrors the daemon's PublicSealedCallView
 *  (src/verdict/sealed-call-public-projection.ts, audience
 *  "public-call-detail"). The submission block keeps a few optional legacy
 *  plaintext keys the detail page still renders defensively; the daemon guard
 *  pins the operator-blind core. */
export interface WireFullCall {
  submission: {
    call_id: string;
    agent_id: string;
    client_order_id?: string;
    privacy_mode?: string;
    commit_hash?: string | null;
    asset_id?: string;
    side?: "BUY" | "SELL";
    horizon_hours?: number;
    confidence?: number;
    submitted_at?: string;
    accepted_at: string;
    status: string;
    rationale?: string | null;
    strategy_tag?: string | null;
  };
  t0: { t0: string; p0: string; feed: string } | null;
  resolution: {
    t1: string;
    // Native-price price-anchor evidence; null for adapter /
    // oracle-unavailable resolutions (daemon migration 055).
    p1: string | null;
    t1_feed: string | null;
    signed_return: string | null;
    outcome: string;
    call_score: number | null;
    resolved_at: string;
  } | null;
  // Sealed-Fhenix lifecycle projection. Present only when privacy_mode is
  // "sealed_fhenix". Pre-reveal it carries opaque ciphertext handles +
  // lifecycle timestamps; post-publish it gains `revealed_verdict`.
  fhenix?: {
    chain_id: number;
    contract_address: string;
    onchain_call_id: string;
    binary_index_ct_hash: string;
    confidence_ct_hash: string;
    reveal_open_at: string;
    reveal_status: string;
    invalid_reason: string | null;
    terminal_at: string | null;
    revealed_at: string | null;
    revealed_verdict?: {
      binary_index: number;
      confidence_bps: number;
      confidence: number;
      /** The venue's own word for this outcome. Absent when the venue named none. */
      outcome_label?: string;
    };
  };
}

/** One row of GET /v1/markets/:market_id/calls. Mirrors the daemon's
 *  PublicMarketCallProjection (src/verdict/sealed-call-public-projection.ts) —
 *  the per-market twin of WireAgentCallRow with the agent display_name. */
export interface WireMarketCallRow {
  call_id: string;
  agent_slug?: string;
  display_name: string;
  status: string;
  accepted_at: string;
  submitted_at?: string;
  privacy_mode: string;
  commit_hash: string | null;
  /** Wave 4b — receipts subsystem dropped; always null on the wire. */
  acceptance_receipt_hash: string | null;
  adapter_id: string;
  market_family: string;
  market_id?: string;
  outcome?: string | null;
  call_score?: number | null;
  signed_return?: string | null;
  resolved_at?: string | null;
}
