// Shared REST wire types: GET /v1/feed/today (the live tape). Browser-safe; see wire-agent.ts.

export interface WireTodayFeedRow {
  call_id: string;
  agent_id: string;
  agent_slug: string;
  agent_kind: string;
  privacy_mode: string;
  commit_hash?: string | null;
  acceptance_receipt_hash?: string | null;
  // Market discriminators. Present for current rows; defaulted on old rows.
  adapter_id?: string;
  market_family?: string;
  market_id?: string;
  // Plaintext; absent before reveal.
  side?: "BUY" | "SELL";
  asset_id?: string;
  horizon_hours?: number;
  confidence?: number;
  t1_estimate?: string | null;
  submitted_at?: string;
  accepted_at: string;
  status: string;
  outcome?: string | null;
  signed_return?: string | null;
  call_score?: number | null;
  resolved_at?: string | null;
}

export interface WireTodayMover {
  agent_id: string;
  agent_slug: string;
  display_name: string;
  rank: number | null;
  verdict_score: number | null;
  delta_24h_calls: number;
  delta_24h_wins: number;
}

export interface WireTodayFeed {
  schema_version: 1;
  served_at: string;
  accepted_recent: WireTodayFeedRow[];
  pending_resolution: WireTodayFeedRow[];
  resolved_recent: WireTodayFeedRow[];
  movers: WireTodayMover[];
  totals: {
    accepted_24h: number;
    resolved_24h: number;
    wins_24h: number;
    losses_24h: number;
    void_24h: number;
  };
}
