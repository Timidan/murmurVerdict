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

/* ── Phase 7a — casual-tier account session + agent list ────────────────── */

/** Response shape for POST /v1/account/session (see src/verdict/routes/account.ts). */
export interface AccountSession {
  account_id: string;
  created: boolean;
  privy_user_id: string;
}

/**
 * One row from GET /v1/account/agents. Fields are nullable because the
 * agents bridge may exist before the agent row is fully hydrated, but
 * after Phase 4 the only nullable case in practice is `display_name`.
 */
export interface AccountAgent {
  agent_id: string;
  linked_at: string;
  display_slug: string | null;
  display_name: string | null;
  /**
   * In v2 this is "casual" for accounts created via this flow. Older
   * legacy bridges may surface other AgentKind values; UI should treat
   * null defensively.
   */
  kind: string | null;
}

/* ── Phase 7b — agent creation + api-key mint request/response shapes ───── */

/**
 * Request body for POST /v1/account/agents. Validation mirrors the
 * server-side zod schema in src/verdict/routes/account.ts:CreateAgentSchema —
 *   · `display_slug` matches AgentSlugSchema (3–32 chars, lowercase alphanum
 *     segments joined by single dashes)
 *   · `display_name` 1–120 chars (UI clamps to 64 per design guidance)
 *   · `bio` optional, ≤500 chars on the server (UI clamps to 280)
 */
export interface CreateAgentRequest {
  display_slug: string;
  display_name: string;
  bio?: string;
}

/**
 * Response body for POST /v1/account/agents. The handler responds 201 with
 * the freshly-inserted row; the client uses `display_slug` to navigate
 * to the agent's integration page.
 */
export interface CreateAgentResponse {
  agent_id: string;
  display_slug: string;
  display_name: string;
  kind: "casual";
  created_at: string;
}

/**
 * Response body for POST /v1/account/agents/:slug/api-keys.
 *
 * SECURITY: `secret` is the ONE place this plaintext is ever returned by
 * the API. Subsequent reads return only the metadata (api_key_id,
 * created_at, label). UI MUST display this once and warn the user the
 * value is not recoverable.
 */
export interface MintApiKeyResponse {
  api_key_id: string;
  secret: string;
  created_at: string;
  warning?: string;
}

// Phase 7a — `get`/`post` accept optional extra headers so account-area
// callers can attach `Authorization: Bearer <privy_jwt>` without breaking
// the existing call-sites (they continue to omit the second arg).
type HeaderMap = Record<string, string>;

async function get<T>(path: string, headers?: HeaderMap): Promise<T> {
  const init: RequestInit = headers ? { headers } : {};
  const res = await fetch(`${API_URL}${path}`, init);
  if (!res.ok) throw new ApiError(`GET ${path} → ${res.status}`, res.status);
  return (await res.json()) as T;
}

async function post<T>(path: string, body: unknown, headers?: HeaderMap): Promise<T> {
  const merged: HeaderMap = { "content-type": "application/json", ...(headers ?? {}) };
  const res = await fetch(`${API_URL}${path}`, {
    method: "POST",
    headers: merged,
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

  /* ── Phase 7a — account-area endpoints (Privy bearer required) ─────── */

  /**
   * Exchange a Privy access token for a Murmur account session. Idempotent:
   * `created` is true only on the first call per Privy user. The dashboard
   * uses this to branch onboarding ("welcome" vs "back so soon").
   */
  postAccountSession: (privyToken: string) =>
    post<AccountSession>(
      "/v1/account/session",
      {},
      { Authorization: `Bearer ${privyToken}` },
    ),

  /**
   * List agents owned by the authenticated account. Empty array when the
   * user hasn't declared an agent yet — Phase 7b's AgentNewPage handles
   * that case.
   */
  getAccountAgents: (privyToken: string) =>
    get<{ agents: AccountAgent[] }>("/v1/account/agents", {
      Authorization: `Bearer ${privyToken}`,
    }),

  /* ── Phase 7b — agent creation + one-time api-key mint ───────────────── */

  /**
   * Create a casual-tier agent under the authenticated account. Backend
   * returns 409 with code `duplicate` if the slug is taken or reserved
   * (the reserved-slug check lives behind the same UNIQUE constraint
   * path in v0.2). Surfaces as ApiError(status=409) so the UI can swap
   * in an inline "× taken" error.
   */
  postCreateAgent: (privyToken: string, body: CreateAgentRequest) =>
    post<CreateAgentResponse>(
      "/v1/account/agents",
      body,
      { Authorization: `Bearer ${privyToken}` },
    ),

  /**
   * Mint a new API key for the given slug. The plaintext `secret` is the
   * ONLY field that ever returns the cleartext key; it is hashed at rest
   * and not retrievable later. Caller MUST display it once + warn the
   * user that it will not be shown again (see ApiKeyMintModal).
   */
  postMintApiKey: (privyToken: string, slug: string, label?: string) =>
    post<MintApiKeyResponse>(
      `/v1/account/agents/${encodeURIComponent(slug)}/api-keys`,
      label ? { label } : {},
      { Authorization: `Bearer ${privyToken}` },
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
