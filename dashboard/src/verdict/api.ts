// Thin typed client for the Murmur Verdict v1 API.
// Read endpoints are public. Dashboard writes use Privy bearer auth or
// account-scoped API keys depending on the route.

// When VITE_VERDICT_API_URL is unset the client defaults to RELATIVE
// URLs. In `npm run dashboard` (vite dev proxy) those resolve to the
// daemon via the vite.config.ts proxy block. In production hosts that
// serve dashboard/dist statically — Cloudflare Pages, Vercel, your
// own Nginx — relative URLs hit the static-host's own origin and the
// SPA silently fails every API call. ALWAYS set this explicitly for
// any non-local build. Pointing at the deployed daemon's URL is the
// split-deploy contract.
const API_URL = (import.meta.env.VITE_VERDICT_API_URL?.trim() || "") as string;

/**
 * Normalized API base — trailing slash stripped — for the few call sites that
 * build a raw URL string by hand rather than going through the typed
 * `verdictApi.*` methods (SSE EventSource, OG/badge `<img>` src, share links).
 * When VITE_VERDICT_API_URL is unset this is "" — the empty string, which
 * makes those URLs RELATIVE so they resolve against the page's own origin (the
 * split-deploy fallback documented above). Prefer the typed methods for JSON
 * endpoints; reach for API_BASE only where a bare URL string is unavoidable.
 */
export const API_BASE = API_URL.replace(/\/$/, "");

// ─────────────────────────────────────────────────────────────────────────────
// REST wire types.
//
// These DTOs are NO LONGER hand-copied here. They live in the repo's shared
// wire-type modules (src/types/wire-*.ts), imported via the `@shared` alias, so
// the daemon and the dashboard consume the SAME definitions — exactly the way
// the SSE channel already shares src/types/events.ts. The daemon pins each of
// these against its authoritative (zod-inferred / presenter) type at build time
// in src/verdict/wire-contract-guards.ts, so a daemon field rename becomes a
// daemon BUILD failure instead of shipping as `undefined` in production.
//
// Re-exported below under their historical names so every existing dashboard
// import site (`import { type LeaderboardRow } from "../api"`) keeps working.
// ─────────────────────────────────────────────────────────────────────────────

export type {
  WireAgentKind as AgentKind,
  WireAgentProfile as AgentProfile,
  WireAgentGridSummary as AgentGridSummary,
} from "@shared/wire-agent";

export type {
  WireLeaderboardRow as LeaderboardRow,
  WireAgentFamilyRow as AgentFamilyRow,
  WireAgentCrossFamilyRow as AgentCrossFamilyRow,
  WireAgentMarketRow as AgentMarketRow,
} from "@shared/wire-leaderboard";

export type {
  WireAgentCallRow as AgentCallRow,
  WireFullCall as FullCall,
  WireMarketCallRow as MarketCallRow,
} from "@shared/wire-call";

export type {
  WireTodayFeed as TodayFeed,
  WireTodayFeedRow as TodayFeedRow,
  WireTodayMover as TodayMover,
} from "@shared/wire-feed";

export type {
  WireMarketStatus as MarketStatus,
  WireMarketResolutionClass as MarketResolutionClass,
  WireMarketSupportStatus as MarketSupportStatus,
  WireMarketPayoffModel as MarketPayoffModel,
  WireMarketSettlementModel as MarketSettlementModel,
  WireMarketOracleHealth as MarketOracleHealth,
  WireMarketOracleRef as MarketOracleRef,
  WireMarketOracleSummary as MarketOracleSummary,
  WireMarketTaxonomyClass as MarketTaxonomyClass,
  WireMarketTaxonomyAssignment as MarketTaxonomyAssignment,
  WireMarketTaxonomyResponse as MarketTaxonomyResponse,
  WireMarketVenuePricePoint as MarketVenuePricePoint,
  WireMarketVenueSnapshot as MarketVenueSnapshot,
  WireMarketRow as MarketRow,
} from "@shared/wire-market";

export type { WireMetaResponse as MetaResponse } from "@shared/wire-meta";

export type {
  WireAccountSession as AccountSession,
  WireAccountAgent as AccountAgent,
  WireCreateAgentRequest as CreateAgentRequest,
  WireCreateAgentResponse as CreateAgentResponse,
  WireBindWalletResponse as BindWalletResponse,
  WireControllerWalletChallengeResponse as ControllerWalletChallengeResponse,
  WireControllerWalletReattestationChallengeResponse as ControllerWalletReattestationChallengeResponse,
  WireControllerWalletReattestationResponse as ControllerWalletReattestationResponse,
  WireRuntimeKeyPolicy as RuntimeKeyPolicy,
  WireRuntimeKeyRow as RuntimeKeyRow,
  WireRuntimeKeyChallengeResponse as RuntimeKeyChallengeResponse,
  WireRuntimeKeyMintResponse as RuntimeKeyMintResponse,
  WireMintApiKeyResponse as MintApiKeyResponse,
  WireApiKeyRow as ApiKeyRow,
  WireRotateApiKeyResponse as RotateApiKeyResponse,
  WirePatchDestinationResponse as PatchDestinationResponse,
  WireDestinationCooldownError as DestinationCooldownError,
  WireFunnelEventKind as FunnelEventKind,
  WireAdminRefSender as AdminRefSender,
} from "@shared/wire-account";

export type {
  WireGatewayAttemptStatus as GatewayAttemptStatus,
  WireGatewayOperatorAttempt as GatewayOperatorAttempt,
  WireGatewayOperatorFeedAttempt as GatewayOperatorFeedAttempt,
  WireGatewayTelemetrySummary as GatewayTelemetrySummary,
  WireGatewayOperatorSnapshot as GatewayOperatorSnapshot,
  WireGatewayTickResponse as GatewayTickResponse,
  WireGatewayRetryResponse as GatewayRetryResponse,
  WireLiveCanaryStatus as LiveCanaryStatus,
  WireLiveCanaryName as LiveCanaryName,
  WireLiveCanaryCheck as LiveCanaryCheck,
  WireLiveCanarySnapshot as LiveCanarySnapshot,
  WireFhenixRevealStatus as FhenixRevealStatus,
  WireFhenixLifecycleRow as FhenixLifecycleRow,
  WireFhenixLifecycleSnapshot as FhenixLifecycleSnapshot,
  WireControllerIdentityStatus as ControllerIdentityStatus,
  WireControllerIdentityRow as ControllerIdentityRow,
  WireControllerIdentitySnapshot as ControllerIdentitySnapshot,
  WireOperatorAlertSeverity as OperatorAlertSeverity,
  WireOperatorAlertStatus as OperatorAlertStatus,
  WireOperatorAlertDeliveryStatus as OperatorAlertDeliveryStatus,
  WireOperatorAlert as OperatorAlert,
  WireOperatorAlertsSnapshot as OperatorAlertsSnapshot,
  WireOperatorAlertTickResponse as OperatorAlertTickResponse,
  WireFeedSlaIncidentStatus as FeedSlaIncidentStatus,
  WireFeedSlaIncident as FeedSlaIncident,
  WireFeedAvailabilitySummary as FeedAvailabilitySummary,
  WireFeedAvailabilityProof as FeedAvailabilityProof,
  WireFeedSlaAdminResponse as FeedSlaAdminResponse,
  WireFeedSlaTickResponse as FeedSlaTickResponse,
} from "@shared/wire-operator";

// Import the aliased names for local use in this module's method signatures.
import type {
  WireAgentKind as AgentKind,
  WireAgentProfile as AgentProfile,
  WireAgentGridSummary as AgentGridSummary,
} from "@shared/wire-agent";
import type {
  WireLeaderboardRow as LeaderboardRow,
  WireAgentFamilyRow as AgentFamilyRow,
  WireAgentCrossFamilyRow as AgentCrossFamilyRow,
  WireAgentMarketRow as AgentMarketRow,
} from "@shared/wire-leaderboard";
import type {
  WireAgentCallRow as AgentCallRow,
  WireFullCall as FullCall,
  WireMarketCallRow as MarketCallRow,
} from "@shared/wire-call";
import type { WireTodayFeed as TodayFeed } from "@shared/wire-feed";
import type {
  WireMarketRow as MarketRow,
  WireMarketTaxonomyResponse as MarketTaxonomyResponse,
} from "@shared/wire-market";
import type { WireMetaResponse as MetaResponse } from "@shared/wire-meta";
import type {
  WireAccountSession as AccountSession,
  WireAccountAgent as AccountAgent,
  WireCreateAgentRequest as CreateAgentRequest,
  WireCreateAgentResponse as CreateAgentResponse,
  WireBindWalletResponse as BindWalletResponse,
  WireControllerWalletChallengeResponse as ControllerWalletChallengeResponse,
  WireControllerWalletReattestationChallengeResponse as ControllerWalletReattestationChallengeResponse,
  WireControllerWalletReattestationResponse as ControllerWalletReattestationResponse,
  WireRuntimeKeyPolicy as RuntimeKeyPolicy,
  WireRuntimeKeyRow as RuntimeKeyRow,
  WireRuntimeKeyChallengeResponse as RuntimeKeyChallengeResponse,
  WireRuntimeKeyMintResponse as RuntimeKeyMintResponse,
  WireMintApiKeyResponse as MintApiKeyResponse,
  WireApiKeyRow as ApiKeyRow,
  WireRotateApiKeyResponse as RotateApiKeyResponse,
  WirePatchDestinationResponse as PatchDestinationResponse,
  WireFunnelEventKind as FunnelEventKind,
  WireAdminRefSender as AdminRefSender,
} from "@shared/wire-account";
import type {
  WireGatewayAttemptStatus as GatewayAttemptStatus,
  WireGatewayOperatorSnapshot as GatewayOperatorSnapshot,
  WireGatewayTickResponse as GatewayTickResponse,
  WireGatewayRetryResponse as GatewayRetryResponse,
  WireLiveCanarySnapshot as LiveCanarySnapshot,
  WireFhenixRevealStatus as FhenixRevealStatus,
  WireFhenixLifecycleSnapshot as FhenixLifecycleSnapshot,
  WireControllerIdentitySnapshot as ControllerIdentitySnapshot,
  WireOperatorAlertStatus as OperatorAlertStatus,
  WireOperatorAlertDeliveryStatus as OperatorAlertDeliveryStatus,
  WireOperatorAlertsSnapshot as OperatorAlertsSnapshot,
  WireOperatorAlertTickResponse as OperatorAlertTickResponse,
  WireFeedSlaIncidentStatus as FeedSlaIncidentStatus,
  WireFeedAvailabilityProof as FeedAvailabilityProof,
  WireFeedSlaAdminResponse as FeedSlaAdminResponse,
  WireFeedSlaTickResponse as FeedSlaTickResponse,
} from "@shared/wire-operator";

// Phase 7a — `get`/`post` accept optional extra headers so account-area
// callers can attach `Authorization: Bearer <privy_jwt>` without breaking
// the existing call-sites (they continue to omit the second arg).
type HeaderMap = Record<string, string>;

export interface AccountActivityRow {
  attempt_id: string;
  kind: "sealed_call" | "feed_packet";
  agent_id: string;
  agent_slug: string | null;
  market_id: string | null;
  feed_id: string | null;
  status: string;
  runtime_key_id: string | null;
  runtime_key_prefix: string | null;
  runtime_key_label: string | null;
  auth_proof: string | null;
  tx_hash: string | null;
  call_id: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

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
    throw new ApiError(`POST ${path} → ${res.status}: ${text}`, res.status, text);
  }
  return (await res.json()) as T;
}

// Phase 7c — PATCH + DELETE helpers, mirroring `post`/`get` so the
// account-settings page can issue payout updates + key rotations through
// the same headers-aware client surface.
async function patch<T>(path: string, body: unknown, headers?: HeaderMap): Promise<T> {
  const merged: HeaderMap = { "content-type": "application/json", ...(headers ?? {}) };
  const res = await fetch(`${API_URL}${path}`, {
    method: "PATCH",
    headers: merged,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new ApiError(`PATCH ${path} → ${res.status}: ${text}`, res.status, text);
  }
  return (await res.json()) as T;
}

/**
 * Phase 7d — POST helper for endpoints that return 204 No Content. The
 * generic `post<T>` always calls `.json()`, which throws on an empty
 * body. The funnel-emit route is the only 204-returning caller today.
 */
async function postNoContent(
  path: string,
  body: unknown,
  headers?: HeaderMap,
): Promise<void> {
  const merged: HeaderMap = { "content-type": "application/json", ...(headers ?? {}) };
  const res = await fetch(`${API_URL}${path}`, {
    method: "POST",
    headers: merged,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new ApiError(`POST ${path} → ${res.status}: ${text}`, res.status, text);
  }
}

async function del<T>(path: string, headers?: HeaderMap, body?: unknown): Promise<T> {
  const merged: HeaderMap | undefined = body === undefined
    ? headers
    : { "content-type": "application/json", ...(headers ?? {}) };
  const init: RequestInit = {
    method: "DELETE",
    ...(merged ? { headers: merged } : {}),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
  const res = await fetch(`${API_URL}${path}`, init);
  if (!res.ok) {
    const text = await res.text();
    throw new ApiError(`DELETE ${path} → ${res.status}: ${text}`, res.status, text);
  }
  return (await res.json()) as T;
}

export class ApiError extends Error {
  /**
   * Raw response body. Carried alongside the formatted message so callers
   * can JSON.parse it for structured fields (e.g. `retry_after_seconds`
   * on a 429 from PATCH /destination-address) without re-fetching.
   */
  readonly rawBody: string;
  constructor(message: string, public readonly status: number, rawBody = "") {
    super(message);
    this.name = "ApiError";
    this.rawBody = rawBody;
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
  // Wave 1 — claimInit / claimFinalize verdictApi methods removed
  // alongside the deleted /v1/agents/:slug/claim/* routes.
  todayFeed: () => get<TodayFeed>(`/v1/feed/today`),
  feedAvailability: (feed_id: string) =>
    get<{
      schema_version: number;
      served_at: string;
      proof: FeedAvailabilityProof;
    }>(`/v1/feeds/${encodeURIComponent(feed_id)}/availability`),
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
  /**
   * Admin sender board — full unfiltered list, token-gated. Sent through the
   * shared client so a rejected token surfaces as ApiError(403) like every
   * other admin read, rather than a hand-rolled fetch outside ApiError.
   */
  adminRefs: (token: string, opts: { limit?: number } = {}) => {
    const params = new URLSearchParams();
    if (opts.limit) params.set("limit", String(opts.limit));
    const q = params.toString();
    return get<{ senders: AdminRefSender[] }>(
      `/v1/refs${q ? `?${q}` : ""}`,
      { "X-Admin-Token": token },
    );
  },
  /** Delete one sender's ref bucket (admin-only). Returns the deleted row count. */
  adminDeleteRef: (token: string, ref: string) =>
    del<{ deleted: number }>(
      `/v1/refs/${encodeURIComponent(ref)}`,
      { "X-Admin-Token": token },
    ),
  adminGateway: (
    token: string,
    opts: { status?: GatewayAttemptStatus; limit?: number; stuck_after_sec?: number } = {},
  ) => {
    const params = new URLSearchParams();
    if (opts.status) params.set("status", opts.status);
    if (opts.limit) params.set("limit", String(opts.limit));
    if (opts.stuck_after_sec) params.set("stuck_after_sec", String(opts.stuck_after_sec));
    const q = params.toString();
    return get<GatewayOperatorSnapshot>(
      `/v1/admin/fhenix/gateway${q ? `?${q}` : ""}`,
      { "X-Admin-Token": token },
    );
  },
  adminGatewayTick: (token: string) =>
    post<GatewayTickResponse>(
      "/v1/admin/fhenix/gateway/tick",
      {},
      { "X-Admin-Token": token },
    ),
  adminGatewayRetry: (token: string, attemptId: string) =>
    post<GatewayRetryResponse>(
      `/v1/admin/fhenix/gateway/attempts/${encodeURIComponent(attemptId)}/retry`,
      {},
      { "X-Admin-Token": token },
    ),
  adminCanaries: (token: string) =>
    get<LiveCanarySnapshot>(
      "/v1/admin/canaries",
      { "X-Admin-Token": token },
    ),
  adminCanariesTick: (token: string) =>
    post<LiveCanarySnapshot>(
      "/v1/admin/canaries/tick",
      {},
      { "X-Admin-Token": token },
    ),
  adminFhenixLifecycle: (
    token: string,
    opts: { status?: FhenixRevealStatus; limit?: number; grace_sec?: number } = {},
  ) => {
    const params = new URLSearchParams();
    if (opts.status) params.set("status", opts.status);
    if (opts.limit) params.set("limit", String(opts.limit));
    if (opts.grace_sec) params.set("grace_sec", String(opts.grace_sec));
    const q = params.toString();
    return get<FhenixLifecycleSnapshot>(
      `/v1/admin/fhenix/lifecycle${q ? `?${q}` : ""}`,
      { "X-Admin-Token": token },
    );
  },
  adminIdentityControllers: (
    token: string,
    opts: { limit?: number; due_soon_hours?: number } = {},
  ) => {
    const params = new URLSearchParams();
    if (opts.limit) params.set("limit", String(opts.limit));
    if (opts.due_soon_hours) params.set("due_soon_hours", String(opts.due_soon_hours));
    const q = params.toString();
    return get<ControllerIdentitySnapshot>(
      `/v1/admin/identity/controllers${q ? `?${q}` : ""}`,
      { "X-Admin-Token": token },
    );
  },
  adminOperatorAlerts: (
    token: string,
    opts: {
      status?: OperatorAlertStatus;
      source?: string;
      delivery_status?: OperatorAlertDeliveryStatus;
      limit?: number;
    } = {},
  ) => {
    const params = new URLSearchParams();
    if (opts.status) params.set("status", opts.status);
    if (opts.source) params.set("source", opts.source);
    if (opts.delivery_status) params.set("delivery_status", opts.delivery_status);
    if (opts.limit) params.set("limit", String(opts.limit));
    const q = params.toString();
    return get<OperatorAlertsSnapshot>(
      `/v1/admin/alerts${q ? `?${q}` : ""}`,
      { "X-Admin-Token": token },
    );
  },
  adminOperatorAlertsTick: (
    token: string,
    opts: {
      gateway_stuck_after_sec?: number;
      fhenix_reveal_grace_sec?: number;
      identity_due_soon_hours?: number;
    } = {},
  ) =>
    post<OperatorAlertTickResponse>(
      "/v1/admin/alerts/tick",
      opts,
      { "X-Admin-Token": token },
    ),
  adminFeedSla: (
    token: string,
    opts: { status?: FeedSlaIncidentStatus; feed_id?: string; limit?: number } = {},
  ) => {
    const params = new URLSearchParams();
    if (opts.status) params.set("status", opts.status);
    if (opts.feed_id) params.set("feed_id", opts.feed_id);
    if (opts.limit) params.set("limit", String(opts.limit));
    const q = params.toString();
    return get<FeedSlaAdminResponse>(
      `/v1/admin/feeds/sla${q ? `?${q}` : ""}`,
      { "X-Admin-Token": token },
    );
  },
  adminFeedSlaTick: (
    token: string,
    opts: { max_incidents?: number; feed_limit?: number } = {},
  ) =>
    post<FeedSlaTickResponse>(
      "/v1/admin/feeds/sla/tick",
      opts,
      { "X-Admin-Token": token },
    ),
  markets: (opts: { status?: string; asset_id?: string } = {}) => {
    const params = new URLSearchParams();
    if (opts.status) params.set("status", opts.status);
    if (opts.asset_id) params.set("asset_id", opts.asset_id);
    const q = params.toString();
    return get<{
      markets: MarketRow[];
      taxonomy: MarketTaxonomyResponse;
      served_at: string;
    }>(
      `/v1/markets${q ? `?${q}` : ""}`,
    );
  },
  /**
   * Single market read — same enriched row shape as the list, plus the
   * live `venue` snapshot on venue-adapter rows. Unknown id → 404
   * `market_not_found`; malformed id → 400 `schema_invalid`. Both throw
   * ApiError with the status carried.
   */
  market: (market_id: string) =>
    get<{ market: MarketRow; served_at: string }>(
      `/v1/markets/${encodeURIComponent(market_id)}`,
    ),
  marketTaxonomy: () =>
    get<{
      schema_version: number;
      served_at: string;
      taxonomy: MarketTaxonomyResponse;
    }>("/v1/markets/taxonomy"),
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
  /**
   * Batched per-market top rows for the markets grid — GET /v1/markets/grid.
   * One request returns each market's ranked top-`limit` rows (default 3),
   * collapsing the grid's former per-market leaderboard fan-out. `limit` caps
   * rows PER MARKET. Only markets with scoring calls appear.
   */
  marketsGrid: (opts: { limit?: number; tier?: string } = {}) => {
    const params = new URLSearchParams();
    if (opts.limit) params.set("limit", String(opts.limit));
    if (opts.tier) params.set("tier", opts.tier);
    const q = params.toString();
    return get<{
      markets: Array<{ market_id: string; agents: AgentMarketRow[] }>;
      served_at: string;
    }>(`/v1/markets/grid${q ? `?${q}` : ""}`);
  },
  /**
   * Recent calls on one market, newest first. Default limit 50, server
   * cap 500. Same 404 `market_not_found` / 400 `schema_invalid` contract
   * as `market`.
   */
  marketCalls: (market_id: string, opts: { limit?: number } = {}) => {
    const params = new URLSearchParams();
    if (opts.limit) params.set("limit", String(opts.limit));
    const q = params.toString();
    return get<{ market_id: string; calls: MarketCallRow[]; served_at: string }>(
      `/v1/markets/${encodeURIComponent(market_id)}/calls${q ? `?${q}` : ""}`,
    );
  },
  // Phase 10 — family + cross-family LBs.
  families: () =>
    get<{
      families: Array<{
        market_family: string;
        submissions: number;
        resolved: number;
      }>;
      served_at: string;
    }>(`/v1/families`),
  familyLeaderboard: (
    family: string,
    opts: { limit?: number; tier?: "main" | "provisional" } = {},
  ) => {
    const params = new URLSearchParams();
    if (opts.limit) params.set("limit", String(opts.limit));
    if (opts.tier) params.set("tier", opts.tier);
    const q = params.toString();
    return get<{
      market_family: string;
      agents: AgentFamilyRow[];
      served_at: string;
    }>(
      `/v1/families/${encodeURIComponent(family)}/leaderboard${q ? `?${q}` : ""}`,
    );
  },
  crossFamilyLeaderboard: (opts: { limit?: number } = {}) => {
    const params = new URLSearchParams();
    if (opts.limit) params.set("limit", String(opts.limit));
    const q = params.toString();
    return get<{ agents: AgentCrossFamilyRow[]; served_at: string }>(
      `/v1/leaderboard/general${q ? `?${q}` : ""}`,
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
   * user hasn't onboarded any agent yet — AccountPage's empty state
   * routes to #/agent/onboard, where the bot itself drives /v1/account/agents.
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

  /* ── Phase 7c — settings page (payout + key rotation) ──────────────── */

  /**
   * List API keys for an agent (metadata only — no plaintext). Returns
   * both active and rotated keys so the panel can show full history;
   * the caller decides what to render. Backed by the additive Phase 7c
   * GET /v1/account/agents/:slug/api-keys route.
   */
  getApiKeys: (privyToken: string, slug: string) =>
    get<{ keys: ApiKeyRow[] }>(
      `/v1/account/agents/${encodeURIComponent(slug)}/api-keys`,
      { Authorization: `Bearer ${privyToken}` },
    ),

  /**
   * Soft-rotate (invalidate) an API key by id. Idempotent — a second
   * call returns rotated=false but does NOT throw. Old keys 401 within
   * ~1s of this returning (the verify path checks rotated_at IS NULL).
   */
  deleteApiKey: (privyToken: string, key_id: string) =>
    del<RotateApiKeyResponse>(
      `/v1/account/api-keys/${encodeURIComponent(key_id)}`,
      { Authorization: `Bearer ${privyToken}` },
    ),

  /**
   * Set/update the casual-tier payout destination. Surfaces 429 with
   * `retry_after_seconds` when the §7.4 24h cooldown is still active;
   * caller should parse ApiError.rawBody for the JSON body.
   */
  patchDestinationAddress: (
    privyToken: string,
    slug: string,
    destination_address: string,
  ) =>
    patch<PatchDestinationResponse>(
      `/v1/account/agents/${encodeURIComponent(slug)}/destination-address`,
      { destination_address },
      { Authorization: `Bearer ${privyToken}` },
    ),

  postControllerWalletChallenge: (
    privyToken: string,
    slug: string,
    body: {
      wallet_address: string;
      chain_id: string;
      wallet_kind?: "embedded" | "external";
      provider?: string;
    },
  ) =>
    post<ControllerWalletChallengeResponse>(
      `/v1/account/agents/${encodeURIComponent(slug)}/wallet/challenge`,
      body,
      { Authorization: `Bearer ${privyToken}` },
    ),

  /**
   * Bind the human-controlled Controller Wallet once. The signature is
   * produced from postControllerWalletChallenge().message.
   */
  patchAgentWallet: (
    privyToken: string,
    slug: string,
    body: {
      wallet_address: string;
      chain_id: string;
      wallet_kind?: "embedded" | "external";
      provider?: string;
      authorization_issued_at: string;
      signature: string;
    },
  ) =>
    patch<BindWalletResponse>(
      `/v1/account/agents/${encodeURIComponent(slug)}/wallet`,
      body,
      { Authorization: `Bearer ${privyToken}` },
    ),

  postControllerWalletReattestationChallenge: (
    privyToken: string,
    slug: string,
  ) =>
    post<ControllerWalletReattestationChallengeResponse>(
      `/v1/account/agents/${encodeURIComponent(slug)}/wallet/reattest/challenge`,
      {},
      { Authorization: `Bearer ${privyToken}` },
    ),

  postControllerWalletReattestation: (
    privyToken: string,
    slug: string,
    body: {
      attestation_nonce: string;
      authorization_issued_at: string;
      signature: string;
    },
  ) =>
    post<ControllerWalletReattestationResponse>(
      `/v1/account/agents/${encodeURIComponent(slug)}/wallet/reattest`,
      body,
      { Authorization: `Bearer ${privyToken}` },
    ),

  getRuntimeKeys: (privyToken: string, slug: string) =>
    get<{ keys: RuntimeKeyRow[] }>(
      `/v1/account/agents/${encodeURIComponent(slug)}/runtime-keys`,
      { Authorization: `Bearer ${privyToken}` },
    ),

  getKillSwitch: (privyToken: string) =>
    get<{ engaged: boolean; disabled_at: string | null }>(
      `/v1/account/kill-switch`,
      { Authorization: `Bearer ${privyToken}` },
    ),

  postKillSwitch: (privyToken: string) =>
    post<{
      engaged: boolean;
      already_engaged: boolean;
      disabled_at: string;
      runtime_keys_revoked: number;
      api_keys_rotated: number;
    }>(`/v1/account/kill-switch`, {}, { Authorization: `Bearer ${privyToken}` }),

  postKillSwitchRelease: (privyToken: string) =>
    post<{ engaged: boolean; was_engaged: boolean; released_at: string | null }>(
      `/v1/account/kill-switch/release`,
      { confirm: "release-agent-access" },
      { Authorization: `Bearer ${privyToken}` },
    ),

  getAccountActivity: (
    privyToken: string,
    params?: { limit?: number; before?: string; before_id?: string },
  ) => {
    const qs = new URLSearchParams();
    if (params?.limit) qs.set("limit", String(params.limit));
    if (params?.before) qs.set("before", params.before);
    if (params?.before_id) qs.set("before_id", params.before_id);
    const suffix = qs.size > 0 ? `?${qs.toString()}` : "";
    return get<{
      activity: AccountActivityRow[];
      next: { before: string; before_id: string } | null;
    }>(`/v1/account/activity${suffix}`, {
      Authorization: `Bearer ${privyToken}`,
    });
  },

  postRuntimeKeyChallenge: (
    privyToken: string,
    slug: string,
    body: { policy?: RuntimeKeyPolicy; expires_at?: string },
  ) =>
    post<RuntimeKeyChallengeResponse>(
      `/v1/account/agents/${encodeURIComponent(slug)}/runtime-keys/challenge`,
      body,
      { Authorization: `Bearer ${privyToken}` },
    ),

  postRuntimeKey: (
    privyToken: string,
    slug: string,
    body: {
      label?: string;
      policy?: RuntimeKeyPolicy;
      expires_at?: string;
      authorization_nonce: string;
      authorization_issued_at: string;
      signature: string;
    },
  ) =>
    post<RuntimeKeyMintResponse>(
      `/v1/account/agents/${encodeURIComponent(slug)}/runtime-keys`,
      body,
      { Authorization: `Bearer ${privyToken}` },
    ),

  deleteRuntimeKey: (privyToken: string, key_id: string, reason?: string) =>
    del<{ revoked: boolean }>(
      `/v1/account/runtime-keys/${encodeURIComponent(key_id)}`,
      { Authorization: `Bearer ${privyToken}` },
      reason ? { reason } : {},
    ),

  /* ── Phase 7d — onboarding funnel emit (account-scoped audit trail) ──── */

  /**
   * Emit a single funnel event. Server-side allowlist rejects anything
   * outside FunnelEventKind with 400. The dashboard NEVER renders errors
   * from this endpoint — useFunnelEmit swallows ApiError so analytics
   * issues can't bubble into the UI.
   */
  postFunnelEvent: (
    privyToken: string,
    kind: FunnelEventKind,
    attributes?: Record<string, unknown>,
  ) =>
    postNoContent(
      "/v1/account/events",
      attributes ? { kind, attributes } : { kind },
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

/**
 * Single market read — GET /v1/markets/:market_id. Venue-adapter rows carry
 * the live `venue` odds/volume snapshot (60s server-side TTL); native rows
 * never have a `venue` key. Throws ApiError(404) on unknown ids
 * (`market_not_found`) and ApiError(400) on malformed ids (`schema_invalid`).
 */
export async function fetchMarket(market_id: string): Promise<MarketRow> {
  const r = await verdictApi.market(market_id);
  return r.market;
}

/**
 * Recent calls on one market, newest first — GET /v1/markets/:id/calls.
 * Same ApiError 404/400 contract as fetchMarket.
 */
export async function fetchMarketCalls(
  market_id: string,
  opts: { limit?: number } = {},
): Promise<MarketCallRow[]> {
  const r = await verdictApi.marketCalls(market_id, opts);
  return r.calls;
}

export async function fetchMarketLeaderboard(
  market_id: string,
  opts: { limit?: number; tier?: string } = {},
): Promise<{ market_id: string; agents: AgentMarketRow[] }> {
  const r = await verdictApi.marketLeaderboard(market_id, opts);
  return { market_id: r.market_id, agents: r.agents };
}

/**
 * Batched markets-grid leaderboard — GET /v1/markets/grid. Returns each
 * market's ranked top-`limit` rows (default 3) in ONE request, replacing the
 * grid's former per-market fan-out. Markets with no scoring calls are omitted;
 * the grid defaults them to an empty top-3.
 */
export async function fetchMarketsGrid(
  opts: { limit?: number; tier?: string } = {},
): Promise<Array<{ market_id: string; agents: AgentMarketRow[] }>> {
  const r = await verdictApi.marketsGrid(opts);
  return r.markets;
}

export async function fetchAgentGrid(
  slug: string,
): Promise<{ agent: AgentGridSummary; grid: AgentMarketRow[] }> {
  const r = await verdictApi.agentGrid(slug);
  return { agent: r.agent, grid: r.grid };
}
