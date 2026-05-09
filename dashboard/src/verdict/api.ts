// Thin typed client for the Murmur Verdict v1 API.
// All read endpoints are unauthenticated. Writes are HMAC-only and not
// performed from the dashboard in v0.1.

// Codex audit follow-up (post-9ae92a4): default to RELATIVE URLs when
// VITE_VERDICT_API_URL is unset. The Vite dev proxy + Vercel prod
// rewrites carry /v1/*, /share, /embed.js to the daemon. Setting
// VITE_VERDICT_API_URL to an absolute URL is still the escape hatch
// for split-deploy setups (different origin for dashboard vs daemon).
const API_URL = (import.meta.env.VITE_VERDICT_API_URL?.trim() || "") as string;

export type AgentKind = "verified" | "benchmark" | "shadow" | "internal_test" | "wallet_only";

export interface LeaderboardRow {
  agent_id: string;
  display_slug: string;
  display_name: string;
  kind: AgentKind;
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
  /** Lowercase 0x+40hex; top-level since P1.5 phase-1. */
  wallet_address?: string;
  /** CAIP-2, e.g. eip155:8453. */
  chain_id?: string;
}

export interface AgentCallRow {
  call_id: string;
  status: string;
  privacy_mode?: string;
  commit_hash?: string | null;
  acceptance_receipt_hash?: string | null;
  asset_id?: string;
  side?: "BUY" | "SELL";
  horizon_hours?: number;
  confidence?: number;
  submitted_at?: string;
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
  // Wave 4b — receipts subsystem dropped (acceptance_receipt no longer
  // returned by the daemon). Wave 4b-2 — preflight metadata
  // (murmur_score / murmur_playbook / risk_flags / market_regime /
  // data_freshness_seconds) was Santiment-derived and is no longer
  // emitted by the daemon either.
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

// Wave 4b-2 — MarketPreflightSnapshot dropped alongside the Santiment
// integration. The /v1/market/preflight endpoint no longer exists.

export interface ClaimInitResponse {
  challenge_id: string;
  nonce: string;
  challenge_text: string;
  /**
   * Canonical claim message — bind to (origin, slug, agent_id, challenge_id,
   * wallet, nonce, expires_at). The wallet must sign THIS, not the raw nonce.
   * Replaces the older "sign the nonce" path.
   */
  sign_message: string;
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
  privacy_mode: string;
  commit_hash?: string | null;
  acceptance_receipt_hash?: string | null;
  side?: "BUY" | "SELL";
  asset_id?: string;
  horizon_hours?: number;
  confidence?: number;
  submitted_at?: string;
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
  stored: string | number | boolean | null;
  recomputed: string | number | boolean | null;
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

/* ── Phase 3b — markets registry + per-(agent, market) grid ─────────────── */

export type MarketStatus = "draft" | "listed" | "frozen" | "retired";

export interface MarketRow {
  market_id: string; // e.g., "eth.1h"
  asset_id: string; // e.g., "base:ETH:USD"
  market_kind: string; // "direction_binary"
  horizon_seconds: number;
  primary_oracle_id: string;
  fallback_oracle_id: string | null;
  void_band: string; // decimal as string
  status: MarketStatus;
  market_config_version: number;
  // Backend may include additional fields; preserve them through.
  [extra: string]: unknown;
}

export interface AgentMarketRow {
  agent_id: string;
  display_slug: string;
  display_name: string;
  kind: AgentKind;
  market_id: string;
  verdict_score: number | null;
  verdict_score_lb: number | null;
  resolved_calls: number;
  pending_calls: number;
  win_rate: number | null;
  last_resolved_at: string | null;
  /** resolved_calls >= 20 */
  market_main_tier: boolean;
}

export interface AgentGridSummary {
  agent_id: string;
  display_slug: string;
  display_name: string;
  kind: AgentKind;
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
  leaderboard: (opts: { tier?: "main" | "provisional"; limit?: number } = {}) => {
    const params = new URLSearchParams();
    if (opts.tier) params.set("tier", opts.tier);
    if (opts.limit) params.set("limit", String(opts.limit));
    const q = params.toString();
    return get<{ schema_version: number; scoring_version: number; served_at: string; rows: LeaderboardRow[] }>(
      `/v1/leaderboard${q ? `?${q}` : ""}`,
    );
  },
  agentsByKind: (kind: AgentKind, limit = 50) =>
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
  claimFinalize: (
    slug: string,
    body: { challenge_id: string; signature: string; post_url: string; ref?: string },
  ) => post<ClaimFinalizeResponse>(`/v1/agents/${encodeURIComponent(slug)}/claim/finalize`, body),
  todayFeed: () => get<TodayFeed>(`/v1/feed/today`),
  verifyCall: (call_id: string) => get<VerifyResult>(`/v1/calls/${encodeURIComponent(call_id)}/verify`),
  discoverers: (slug: string, limit = 5) =>
    get<{
      schema_version: number;
      slug: string;
      discoverers: Array<{
        ref: string;
        agent_slug: string | null;
        total: number;
        first_at: string;
        last_at: string;
      }>;
    }>(`/v1/agents/${encodeURIComponent(slug)}/discoverers?limit=${limit}`),
  topRefs: (limit = 20) =>
    get<{
      schema_version: number;
      served_at: string;
      senders: Array<{
        ref: string;
        total: number;
        agents_touched: number;
        converted: number;
        last_at: string;
      }>;
    }>(`/v1/refs/top?limit=${limit}`),
  markets: (opts: { status?: string; asset_id?: string } = {}) => {
    const params = new URLSearchParams();
    if (opts.status) params.set("status", opts.status);
    if (opts.asset_id) params.set("asset_id", opts.asset_id);
    const q = params.toString();
    return get<{ markets: MarketRow[]; served_at: string }>(
      `/v1/markets${q ? `?${q}` : ""}`,
    );
  },
  marketLeaderboard: (
    market_id: string,
    opts: { limit?: number; tier?: string } = {},
  ) => {
    const params = new URLSearchParams();
    if (opts.limit) params.set("limit", String(opts.limit));
    if (opts.tier) params.set("tier", opts.tier);
    const q = params.toString();
    return get<{ market_id: string; agents: AgentMarketRow[]; served_at: string }>(
      `/v1/markets/${encodeURIComponent(market_id)}/leaderboard${q ? `?${q}` : ""}`,
    );
  },
  agentGrid: (slug: string) =>
    get<{ agent: AgentGridSummary; grid: AgentMarketRow[]; served_at: string }>(
      `/v1/agents/${encodeURIComponent(slug)}/grid`,
    ),
};

/* ── Top-level convenience exports ─────────────────────────────────────── */
// Mirror the daemon-facing names from V14_HANDOFF so subagent-driven code
// can `import { fetchMarkets } from "../api"` without going through the
// `verdictApi.markets(…)` namespace. Both paths return the same payload.

export async function fetchMarkets(
  opts: { status?: string; asset_id?: string } = {},
): Promise<MarketRow[]> {
  const r = await verdictApi.markets(opts);
  return r.markets;
}

export async function fetchMarketLeaderboard(
  market_id: string,
  opts: { limit?: number; tier?: string } = {},
): Promise<{ market_id: string; agents: AgentMarketRow[] }> {
  const r = await verdictApi.marketLeaderboard(market_id, opts);
  return { market_id: r.market_id, agents: r.agents };
}

export async function fetchAgentGrid(
  slug: string,
): Promise<{ agent: AgentGridSummary; grid: AgentMarketRow[] }> {
  const r = await verdictApi.agentGrid(slug);
  return { agent: r.agent, grid: r.grid };
}
