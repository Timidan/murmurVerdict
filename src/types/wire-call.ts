// Shared REST wire types: call projections. Browser-safe; see wire-agent.ts.
// Operator-blind: a PENDING sealed call never carries plaintext; those fields are optional
// because they can appear after reveal.

/** One row of GET /v1/agents/:slug/calls. Mirrors PublicAgentCallProjection. */
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

/** GET /v1/calls/:call_id. Mirrors PublicSealedCallView ("public-call-detail"). */
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
    // Null for adapter and oracle-unavailable resolutions.
    p1: string | null;
    t1_feed: string | null;
    signed_return: string | null;
    outcome: string;
    call_score: number | null;
    resolved_at: string;
  } | null;
  // Only for "sealed_fhenix". Ciphertext handles pre-reveal; `revealed_verdict` after publish.
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

/** One row of GET /v1/markets/:market_id/calls. Mirrors PublicMarketCallProjection. */
export interface WireMarketCallRow {
  call_id: string;
  agent_slug?: string;
  display_name: string;
  status: string;
  accepted_at: string;
  submitted_at?: string;
  privacy_mode: string;
  commit_hash: string | null;
  /** Always null on the wire. */
  acceptance_receipt_hash: string | null;
  adapter_id: string;
  market_family: string;
  market_id?: string;
  outcome?: string | null;
  call_score?: number | null;
  signed_return?: string | null;
  resolved_at?: string | null;
}
