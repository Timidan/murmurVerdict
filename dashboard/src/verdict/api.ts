// Thin typed client for the Murmur Verdict v1 API.
// All read endpoints are unauthenticated. Writes are HMAC-only and not
// performed from the dashboard in v0.1.

const API_URL = (import.meta.env.VITE_VERDICT_API_URL?.trim() ||
  "http://localhost:8080") as string;

export interface LeaderboardRow {
  agent_id: string;
  display_slug: string;
  display_name: string;
  kind: "verified" | "benchmark" | "shadow" | "internal_test";
  tier: "main" | "provisional";
  rank: number | null;
  verdict_score: number | null;
  resolved_calls: number;
  win_rate: number | null;
  pending_calls: number;
  last_resolved_at: string | null;
}

export interface MetaResponse {
  schema_version: number;
  scoring_version: number;
  strategy_tags: string[];
  assets: string[];
  verified_volume_24h: { count: number; since_iso: string };
}

export interface AgentProfile {
  agent_id: string;
  display_slug: string;
  display_name: string;
  kind: LeaderboardRow["kind"];
  bio?: string;
  verified_identities: Array<{ kind: string; value: string; verified_at: string }>;
  created_at: string;
}

export interface AgentCallRow {
  call_id: string;
  status: string;
  asset_id: string;
  side: "BUY" | "SELL";
  horizon_hours: number;
  confidence: number;
  submitted_at: string;
  accepted_at: string;
  outcome: string | null;
  call_score: number | null;
  signed_return: string | null;
  resolved_at: string | null;
}

export interface FullCall {
  submission: {
    call_id: string;
    agent_id: string;
    client_order_id: string;
    asset_id: string;
    side: "BUY" | "SELL";
    horizon_hours: number;
    confidence: number;
    submitted_at: string;
    accepted_at: string;
    status: string;
    rationale: string | null;
    strategy_tag: string | null;
  };
  preflight: {
    murmur_score: number;
    murmur_playbook: string;
    risk_flags: string[];
    data_freshness_seconds: number;
    market_regime: string;
  };
  acceptance_receipt: { hash: string; filecoin_cid: string | null };
  t0: { t0: string; p0: string; feed: string } | null;
  resolution: {
    t1: string;
    p1: string;
    t1_feed: string;
    signed_return: string;
    outcome: string;
    call_score: number | null;
    resolved_at: string;
    receipt_hash: string;
    filecoin_cid: string | null;
  } | null;
}

export interface MarketPreflightSnapshot {
  asset_id: string;
  composite_score: number;
  top_playbook: string;
  regime: string;
  data_freshness_seconds: number;
  served_at: string;
}

export interface ClaimInitResponse {
  challenge_id: string;
  nonce: string;
  challenge_text: string;
  expires_at: string;
  target_identity: { kind: string; value: string };
  wallet_to_bind: string;
  agent_id: string;
  display_slug: string;
  instructions: string[];
}

export interface ClaimFinalizeResponse {
  agent_id: string;
  display_slug: string;
  imported_call_ids: string[];
  api_key: string;
  api_key_hash: string;
  verified_at: string;
}

export interface TodayFeedRow {
  call_id: string;
  agent_id: string;
  agent_slug: string;
  agent_kind: string;
  side: "BUY" | "SELL";
  asset_id: string;
  horizon_hours: number;
  confidence: number;
  submitted_at: string;
  accepted_at: string;
  status: string;
  outcome?: string | null;
  signed_return?: string | null;
  call_score?: number | null;
  resolved_at?: string | null;
  t1_estimate?: string | null;
}

export interface TodayMover {
  agent_id: string;
  agent_slug: string;
  display_name: string;
  rank: number | null;
  verdict_score: number | null;
  delta_24h_calls: number;
  delta_24h_wins: number;
}

export interface TodayFeed {
  schema_version: 1;
  served_at: string;
  accepted_recent: TodayFeedRow[];
  pending_resolution: TodayFeedRow[];
  resolved_recent: TodayFeedRow[];
  movers: TodayMover[];
  totals: {
    accepted_24h: number;
    resolved_24h: number;
    wins_24h: number;
    losses_24h: number;
    void_24h: number;
  };
}

export interface VerifyCheck {
  name: string;
  status: "match" | "mismatch" | "skipped";
  stored: string | number | null;
  recomputed: string | number | null;
  note?: string;
}

export interface VerifyResult {
  call_id: string;
  passes: boolean;
  checks: VerifyCheck[];
  scoring_version: number;
  schema_version: number;
  verified_at: string;
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${API_URL}${path}`);
  if (!res.ok) throw new ApiError(`GET ${path} → ${res.status}`, res.status);
  return (await res.json()) as T;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new ApiError(`POST ${path} → ${res.status}: ${text}`, res.status);
  }
  return (await res.json()) as T;
}

export class ApiError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = "ApiError";
  }
}

export const verdictApi = {
  apiUrl: API_URL,
  meta: () => get<MetaResponse>("/v1/meta"),
  health: () => get<{ ok: boolean; schema_version: number; scoring_version: number; now: string }>("/v1/health"),
  marketPreflight: () => get<MarketPreflightSnapshot>("/v1/market/preflight"),
  leaderboard: (opts: { tier?: "main" | "provisional"; limit?: number } = {}) => {
    const params = new URLSearchParams();
    if (opts.tier) params.set("tier", opts.tier);
    if (opts.limit) params.set("limit", String(opts.limit));
    const q = params.toString();
    return get<{ schema_version: number; scoring_version: number; served_at: string; rows: LeaderboardRow[] }>(
      `/v1/leaderboard${q ? `?${q}` : ""}`,
    );
  },
  agentsByKind: (kind: "verified" | "benchmark" | "shadow" | "internal_test", limit = 50) =>
    get<{
      schema_version: number;
      served_at: string;
      kind: string;
      count: number;
      rows: AgentProfile[];
    }>(`/v1/agents?kind=${kind}&limit=${limit}`),
  agent: (slug: string) => get<AgentProfile>(`/v1/agents/${encodeURIComponent(slug)}`),
  agentCalls: (slug: string, limit = 50) =>
    get<{ agent_id: string; display_slug: string; kind: string; calls: AgentCallRow[] }>(
      `/v1/agents/${encodeURIComponent(slug)}/calls?limit=${limit}`,
    ),
  call: (call_id: string) => get<FullCall>(`/v1/calls/${encodeURIComponent(call_id)}`),
  claimInit: (slug: string, body: { target_identity: { kind: string; value: string }; wallet_to_bind: string }) =>
    post<ClaimInitResponse>(`/v1/agents/${encodeURIComponent(slug)}/claim/init`, body),
  claimFinalize: (slug: string, body: { challenge_id: string; signature: string; post_url: string }) =>
    post<ClaimFinalizeResponse>(`/v1/agents/${encodeURIComponent(slug)}/claim/finalize`, body),
  todayFeed: () => get<TodayFeed>(`/v1/feed/today`),
  verifyCall: (call_id: string) => get<VerifyResult>(`/v1/calls/${encodeURIComponent(call_id)}/verify`),
};
