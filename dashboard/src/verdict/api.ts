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

// The two PUBLIC marketplace surfaces. `MarketplaceCurrentTerms` (the standing
// listing) and `LockedTerms` (a sealed call's frozen snapshot) are separate
// types on purpose — see src/types/wire-marketplace.ts for why collapsing them
// into "price" is the expensive bug here.
export type {
  WireMarketplaceSeries as MarketplaceSeries,
  WireMarketplaceTrackRecord as MarketplaceTrackRecord,
  WireMarketplaceCurrentTerms as MarketplaceCurrentTerms,
  WireMarketplaceListing as MarketplaceListing,
  WireMarketplaceAgent as MarketplaceAgent,
  WireMarketplaceListings as MarketplaceListings,
  WireInventoryStatus as InventoryStatus,
  WireLockedTerms as LockedTerms,
  WireSellableCall as SellableCall,
  WireSellableCalls as SellableCalls,
} from "@shared/wire-marketplace";

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
  WireRuntimeKeyConnection as RuntimeKeyConnection,
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

export type RuntimeKeysResponse = import("@shared/wire-account").WireRuntimeKeysResponse;

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
  WireMarketplaceListings as MarketplaceListings,
  WireSellableCalls as SellableCalls,
} from "@shared/wire-marketplace";
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

// `get`/`post` accept optional extra headers so account-area
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

/**
 * `signal` lets a caller cancel an in-flight read. Required by anything that
 * re-issues on every keystroke (the archive search): without it, a slow early
 * response resolves after a fast later one and overwrites fresher results.
 * An aborted fetch rejects with a DOMException named "AbortError" — callers
 * swallow that name rather than rendering it as a failure.
 *
 * The failure body is carried on `ApiError.rawBody` (same as `post`) so
 * structured server codes like `archive_query_invalid` are readable by the
 * caller. The MESSAGE format is unchanged on purpose — existing call sites
 * match on it.
 */
async function get<T>(
  path: string,
  headers?: HeaderMap,
  signal?: AbortSignal,
): Promise<T> {
  const init: RequestInit = {
    ...(headers ? { headers } : {}),
    ...(signal ? { signal } : {}),
  };
  const res = await fetch(`${API_URL}${path}`, init);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new ApiError(`GET ${path} → ${res.status}`, res.status, text);
  }
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

// PATCH + DELETE helpers, mirroring `post`/`get` so the
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
 * POST helper for endpoints that return 204 No Content. The
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

async function put<T>(path: string, body: unknown, headers?: HeaderMap): Promise<T> {
  const merged: HeaderMap = { "content-type": "application/json", ...(headers ?? {}) };
  const res = await fetch(`${API_URL}${path}`, {
    method: "PUT",
    headers: merged,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new ApiError(`PUT ${path} → ${res.status}: ${text}`, res.status, text);
  }
  return (await res.json()) as T;
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

/**
 * A response whose STATUS is part of the answer.
 *
 * `get`/`post` above throw on any non-2xx, which is right for reads: a 404 on
 * a leaderboard is a failure. It is wrong for the x402 checkout, where 402 is
 * not an error at all — it is the price list, and 409 tells a buyer precisely
 * why a call cannot be bought. Throwing those away and re-parsing the message
 * string is how a checkout starts guessing.
 */
export interface RawResponse {
  status: number;
  /** Parsed JSON, or null when the body was empty or unparseable. */
  body: unknown;
}

async function rawResponse(path: string, init: RequestInit): Promise<RawResponse> {
  const res = await fetch(`${API_URL}${path}`, init);
  const text = await res.text().catch(() => "");
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // A non-JSON body from a proxy or a gateway is itself the diagnosis; the
    // caller classifies on status and gets `null` rather than a throw.
    body = null;
  }
  return { status: res.status, body };
}

async function rawPost(path: string, headers?: HeaderMap): Promise<RawResponse> {
  return rawResponse(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...(headers ?? {}) },
  });
}

async function rawGet(path: string, headers?: HeaderMap): Promise<RawResponse> {
  return rawResponse(path, { method: "GET", ...(headers ? { headers } : {}) });
}

/**
 * The ABSOLUTE url of a call's access endpoint.
 *
 * Circle's payment envelope carries a `resource` naming what is being bought,
 * and it has to be absolute — `API_BASE` is the empty string on a same-origin
 * deploy, which would make it a bare path. Resolving against the page's own
 * origin is exactly what the browser would do with that request anyway.
 */
export function callAccessUrl(onchainCallId: string): string {
  const path = `/v2/gateway/calls/${encodeURIComponent(onchainCallId)}/access`;
  const base = API_BASE || (typeof window === "undefined" ? "" : window.location.origin);
  return `${base}${path}`;
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

/**
 * One archived market from GET /v2/markets/archive.
 *
 * Shaped by the endpoint, not by the registry: an archived market is a
 * question, a slug, the instant it ended and its venue artwork. It carries no
 * odds, no leaderboard and no config blob — this is a search result, and
 * anything more is a click away on the market page.
 */
export interface ArchivedMarketRow {
  market_id: string;
  question: string | null;
  slug: string | null;
  /** ISO instant the venue's window ended. */
  ended_at: string;
  icon_url: string | null;
  /** True when murmur actually ran a sealed window on this market. */
  sealed_window: boolean;
  /** Provider key ("polymarket-gamma"). Archive is Polymarket-only today. */
  provider?: string;
  /** The venue's own top-level category, or null when it published none. */
  category_label?: string | null;
}

export interface MarketArchivePage {
  schema_version: number;
  results: ArchivedMarketRow[];
  /** Feed back as `cursor` for the next page; null when this is the last. */
  next_cursor: string | null;
  has_more: boolean;
  returned: number;
}

export interface ProviderTermsView {
  schema_version: number;
  /** False when the owner has not set terms — no access is sold. */
  selling: boolean;
  price_atoms?: string;
  currency?: string;
  pricing_version?: string;
  /** The owner's ceiling; null means "as many as murmur can serve". */
  max_subscribers_per_call?: number | null;
  /** What this deployment can grant inside the delivery budget. */
  deliverable_max_subscribers_per_call: number | null;
  /** min(owner, deliverable) — what is actually sold. */
  effective_max_subscribers_per_call?: number | null;
  clamped_by_deliverability?: boolean;
  notice?: string;
  updated_at?: string;
}

/* ── Market registrations ───────────────────────────────────────────────── */

/** An owner's price for ONE series. Echoed on the registration row. */
export interface MarketRegistrationTerms {
  price_atoms: string;
  currency: string;
  pricing_version: string;
  /** The owner's ceiling; null means "as many as murmur can serve". */
  max_subscribers_per_call: number | null;
}

/**
 * One venue series with THIS agent's state on it. A registration is the
 * precondition for a price (the terms table FKs to it), so `terms` is non-null
 * only under `registered: true`.
 */
export interface MarketRegistrationRow {
  venue_series_id: string;
  series_title: string;
  series_slug: string;
  venue_category: string | null;
  registered: boolean;
  terms: MarketRegistrationTerms | null;
}

export interface MarketRegistrationsView {
  schema_version: number;
  series: MarketRegistrationRow[];
}

/** Echo of a single register/unregister write. */
export interface MarketRegistrationWriteView {
  schema_version: number;
  venue_series_id: string;
  registered: boolean;
  series_title?: string;
  series_slug?: string;
  venue_category?: string | null;
}

/* ── Earnings + payouts ─────────────────────────────────────────────────── */

/** One early-access sale of this agent's calls. */
export interface ProviderEarningRow {
  entitlement_id: number;
  onchain_call_id: string;
  chain_id: number;
  contract_address: string;
  gross_atoms: string;
  fee_atoms: string;
  net_atoms: string;
  fee_bps: number;
  currency: string;
  accrual_source: "sale_snapshot" | "legacy_fallback";
  accrued_at: string;
}

/**
 * Per-currency money, both sides.
 *
 * `balance_atoms` is SIGNED. `owed_atoms` and `overpaid_atoms` are its two
 * halves, split so a caller cannot accidentally render a negative balance as
 * zero: exactly one of them is ever non-zero.
 */
export interface ProviderEarningsTotal {
  currency: string;
  sales: number;
  lifetime_accrued_gross: string;
  lifetime_accrued_fee: string;
  lifetime_accrued_net: string;
  payout_entries: number;
  lifetime_paid_gross: string;
  lifetime_paid_reversed: string;
  lifetime_paid_net: string;
  balance_atoms: string;
  owed_atoms: string;
  overpaid_atoms: string;
}

export interface ProviderEarningsView {
  schema_version: number;
  agent_slug: string;
  sales: ProviderEarningRow[];
  totals: ProviderEarningsTotal[];
  page: { limit: number; offset: number; returned: number };
  payouts: { automated: boolean; note: string };
}

/** One entry in the payout journal. Amounts are always positive. */
export interface ProviderPayoutRow {
  id: number;
  agent_slug: string;
  /** 'reversal' subtracts. The sign lives here, never in the amount. */
  entry_type: "payout" | "reversal";
  currency: string;
  amount_atoms: string;
  tx_ref: string;
  payout_method: string;
  destination_ref: string;
  note: string | null;
  earnings_cutoff_at: string;
  created_at: string;
}

export interface ProviderPayoutsView {
  schema_version: number;
  agent_slug: string;
  payouts: ProviderPayoutRow[];
  totals: Array<{
    currency: string;
    entries: number;
    net_paid_atoms: string;
    paid_atoms: string;
    reversed_atoms: string;
  }>;
  page: { limit: number; offset: number; returned: number };
}

/* ── Reveals ────────────────────────────────────────────────────────────── */

/**
 * "pending" and "unknown" are NOT the same absence. "pending" means nobody has
 * revealed the call yet, so it is still the agent's job. "unknown" means it
 * WAS revealed and murmur has no record of who did it (a call sealed before
 * reveal attribution existed).
 */
export type AccountRevealSource =
  | "agent"
  | "daemon_fallback"
  | "unattributed_external"
  | "unknown"
  | "pending";

export interface AccountRevealRow {
  call_id: string;
  onchain_call_id: string;
  chain_id: number;
  reveal_open_at: string;
  /** null when this deployment runs no fallback worker. */
  deadline: string | null;
  reveal_status: string;
  revealed_at: string | null;
  reveal_source: AccountRevealSource;
}

export interface AccountRevealsView {
  schema_version: number;
  agent_slug: string;
  reveals: AccountRevealRow[];
  fallback: {
    enabled: boolean;
    grace_seconds: number | null;
    note: string;
  };
  page: { limit: number; offset: number; returned: number };
}

/* ── Profile + lifecycle ────────────────────────────────────────────────── */

export interface AgentProfileUpdateResponse {
  schema_version: number;
  agent: {
    agent_id: string;
    display_slug: string;
    display_name: string;
    bio: string | null;
    retired_at: string | null;
  };
  slug_immutable: boolean;
}

export interface AgentRetirementResponse {
  schema_version: number;
  agent_slug: string;
  retired: boolean;
  already_retired?: boolean;
  already_active?: boolean;
  retired_at: string | null;
  effect?: string;
}

/** GET /v1/account/session — the session plus the closed-account marker. */
export interface AccountSessionState {
  account_id: string;
  created: boolean;
  privy_user_id: string;
  deactivated: boolean;
  deactivated_at: string | null;
}

export interface AccountDeactivateResponse {
  schema_version: number;
  deactivated: boolean;
  already_deactivated: boolean;
  deactivated_at: string;
  runtime_keys_revoked: number;
  api_keys_rotated: number;
  agents_retired: number;
  reactivation: string;
}

/* ── Webhooks ───────────────────────────────────────────────────────────── */

export interface AccountWebhookRow {
  id: string;
  agent_slug: string;
  url: string;
  created_at: string;
  last_delivery_at: string | null;
  last_status: number | null;
  delivery_count: number;
  failure_count: number;
  disabled: boolean;
}

export interface CreateWebhookResponse {
  id: string;
  agent_slug: string | null;
  url: string;
  /** Returned once, at creation. It is never retrievable again. */
  secret: string;
  created_at: string;
  verify_signature: {
    algorithm: string;
    header: string;
    body: string;
    [key: string]: unknown;
  };
}

/* ── Wallet purchases ───────────────────────────────────────────────────── */

export interface WalletPurchaseRow {
  onchain_call_id: string;
  status: string;
  amount: string | null;
  currency: string | null;
  grant_tx_hash: string | null;
  granted_at: string | null;
  created_at: string;
  producer_agent_slug: string | null;
  reveal_open_at: string | null;
  refund_status?: string | null;
  payment_confirmed?: boolean;
  /**
   * 'unknown' means murmur has no settlement receipt for this row — NOT that
   * the payment failed. The UI states it as unknown for that reason.
   */
  payment_status?: "confirmed" | "unknown";
}

export interface WalletPurchasesView {
  schema_version: number;
  chain_id: number;
  contract_address: string;
  subscriber: string;
  authenticated: boolean;
  /** 'granted_only' says WHY rows may be missing from an unsigned read. */
  scope: "full_history" | "granted_only";
  purchases: WalletPurchaseRow[];
  next_cursor: string | null;
  page: { limit: number; returned: number };
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
  // The signal is here for the handle field on the onboarding page, which
  // asks this route on every keystroke and needs the answer to the handle
  // being typed now rather than the one two characters ago.
  agent: (slug: string, signal?: AbortSignal) =>
    get<AgentProfile>(`/v1/agents/${encodeURIComponent(slug)}`, undefined, signal),
  agentCalls: (slug: string, limit = 50) =>
    get<{ agent_id: string; display_slug: string; kind: string; calls: AgentCallRow[] }>(
      `/v1/agents/${encodeURIComponent(slug)}/calls?limit=${limit}`,
    ),
  call: (call_id: string) => get<FullCall>(`/v1/calls/${encodeURIComponent(call_id)}`),
  // claimInit / claimFinalize verdictApi methods removed
  // alongside the deleted /v1/agents/:slug/claim/* routes.
  todayFeed: () => get<TodayFeed>(`/v1/feed/today`),
  /**
   * The durable storefront catalog: who lists which series, at what STANDING
   * price. Public and unauthenticated — an offer nobody can see is not an
   * offer. Every price on this response is a `current_terms`: what the agent's
   * NEXT sealed call would cost, never what an already-sealed call is sold at.
   * Series metadata comes back SEPARATELY from agents, so a series with no
   * sellers still yields a column.
   */
  marketplaceListings: (
    opts: {
      series?: readonly string[];
      /** BigInt-safe decimal strings — atoms exceed what a number can hold. */
      min_list_price_atoms?: string;
      max_list_price_atoms?: string;
      min_resolved_calls?: number;
      min_score_floor?: number;
    } = {},
    signal?: AbortSignal,
  ) => {
    const params = new URLSearchParams();
    for (const id of opts.series ?? []) params.append("series", id);
    if (opts.min_list_price_atoms) params.set("min_list_price_atoms", opts.min_list_price_atoms);
    if (opts.max_list_price_atoms) params.set("max_list_price_atoms", opts.max_list_price_atoms);
    if (opts.min_resolved_calls !== undefined) {
      params.set("min_resolved_calls", String(opts.min_resolved_calls));
    }
    if (opts.min_score_floor !== undefined) {
      params.set("min_score_floor", String(opts.min_score_floor));
    }
    const q = params.toString();
    return get<MarketplaceListings>(
      `/v1/marketplace/listings${q ? `?${q}` : ""}`,
      undefined,
      signal,
    );
  },
  /**
   * Per-call inventory for the storefront. Public. Every price here is a
   * `locked_terms` — the snapshot a buyer actually pays for THAT call.
   *
   * An empty `calls` array is the NORMAL resting state, not a failure: markets
   * roll on a five-minute clock and most of it has nothing sealed inside. Read
   * `purchase_available` before drawing any buy affordance.
   */
  sellableCalls: (
    opts: {
      series?: readonly string[];
      agent_slug?: string;
      limit?: number;
      cursor?: string;
    } = {},
    signal?: AbortSignal,
  ) => {
    const params = new URLSearchParams();
    for (const id of opts.series ?? []) params.append("series", id);
    if (opts.agent_slug) params.set("agent_slug", opts.agent_slug);
    if (opts.limit) params.set("limit", String(opts.limit));
    if (opts.cursor) params.set("cursor", opts.cursor);
    const q = params.toString();
    return get<SellableCalls>(
      `/v2/gateway/calls/sellable${q ? `?${q}` : ""}`,
      undefined,
      signal,
    );
  },
  /**
   * Ask what ONE sealed call costs. Answers 402 with the challenge, which is
   * the SUCCESS case here — hence `rawPost`, not `post`.
   *
   * Sends no payment and no identity. The endpoint takes neither a runtime key
   * nor a Privy session: whoever signs the payment on the second call becomes
   * the subscriber, so there is nothing to authenticate on this one.
   */
  callAccessChallenge: (onchainCallId: string) =>
    rawPost(`/v2/gateway/calls/${encodeURIComponent(onchainCallId)}/access`),
  /**
   * Present a signed x402 authorization for that call.
   *
   * The header is the whole identity. murmur derives the subscriber from the
   * VERIFIED payer inside it and never from anything else on the request, so
   * the wallet that signs is the wallet that receives decrypt access.
   *
   * Idempotent: a repeat for access already held answers 200 `granted: true`
   * without settling again.
   */
  callAccessPurchase: (onchainCallId: string, paymentSignature: string) =>
    rawPost(`/v2/gateway/calls/${encodeURIComponent(onchainCallId)}/access`, {
      "PAYMENT-SIGNATURE": paymentSignature,
    }),
  /** Public chain status; a fresh wallet proof additionally reveals private payment state. */
  callAccessStatus: (
    onchainCallId: string,
    subscriber: string,
    auth?: { unixSeconds: number; signature: string },
  ) =>
    rawGet(
      `/v2/gateway/calls/${encodeURIComponent(onchainCallId)}/access/status` +
        `?subscriber=${encodeURIComponent(subscriber)}`,
      auth
        ? { "X-Murmur-Subscriber-Auth": `${auth.unixSeconds}:${auth.signature}` }
        : undefined,
    ),
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
   * Archive search — GET /v2/markets/archive. Keyset-paged over every market
   * this deployment has frozen, newest end time first.
   *
   * The server REQUIRES either a search term of two or more characters or a
   * date bound, and answers anything else with 400 `archive_query_invalid`
   * (400 `archive_cursor_invalid` for a page token it did not issue). Both
   * arrive as ApiError with the status carried — the search view renders the
   * message inline rather than treating it as a failed request.
   *
   * `signal` is not optional in practice: results update per keystroke, and
   * without an AbortController a slow early response lands after a fast late
   * one and overwrites it.
   */
  marketsArchive: (
    opts: {
      q?: string;
      /** Epoch seconds, or an ISO-8601 instant. */
      from?: number | string;
      to?: number | string;
      cursor?: string;
      limit?: number;
    } = {},
    signal?: AbortSignal,
  ) => {
    const params = new URLSearchParams();
    if (opts.q) params.set("q", opts.q);
    if (opts.from !== undefined) params.set("from", String(opts.from));
    if (opts.to !== undefined) params.set("to", String(opts.to));
    if (opts.cursor) params.set("cursor", opts.cursor);
    if (opts.limit !== undefined) params.set("limit", String(opts.limit));
    const q = params.toString();
    return get<MarketArchivePage>(
      `/v2/markets/archive${q ? `?${q}` : ""}`,
      undefined,
      signal,
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
  // Family + cross-family leaderboards.
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
   * the caller decides what to render. Backed by the additive
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

  getRuntimeKeys: (privyToken: string, slug: string, signal?: AbortSignal) =>
    get<RuntimeKeysResponse>(
      `/v1/account/agents/${encodeURIComponent(slug)}/runtime-keys`,
      { Authorization: `Bearer ${privyToken}` },
      signal,
    ),

  /**
   * The agent owner's own commercial terms for early decrypt access.
   *
   * Terms are per venue series — `?series=` is required, and the daemon
   * answers 400 `series_required` without it rather than guessing a default.
   *
   * `effective_max_subscribers_per_call` is what murmur will actually sell:
   * min(the owner's ceiling, what this deployment can grant inside the
   * delivery budget). When those differ the response carries `notice`.
   */
  getProviderTerms: (privyToken: string, slug: string, venueSeriesId: string) =>
    get<ProviderTermsView>(
      `/v1/account/agents/${encodeURIComponent(slug)}/provider-terms` +
        `?series=${encodeURIComponent(venueSeriesId)}`,
      { Authorization: `Bearer ${privyToken}` },
    ),

  putProviderTerms: (
    privyToken: string,
    slug: string,
    venueSeriesId: string,
    body: {
      price_atoms: string;
      currency: string;
      pricing_version: string;
      max_subscribers_per_call: number | null;
    },
  ) =>
    put<ProviderTermsView>(
      `/v1/account/agents/${encodeURIComponent(slug)}/provider-terms` +
        `?series=${encodeURIComponent(venueSeriesId)}`,
      body,
      { Authorization: `Bearer ${privyToken}` },
    ),

  deleteProviderTerms: (
    privyToken: string,
    slug: string,
    venueSeriesId: string,
  ) =>
    del<ProviderTermsView>(
      `/v1/account/agents/${encodeURIComponent(slug)}/provider-terms` +
        `?series=${encodeURIComponent(venueSeriesId)}`,
      { Authorization: `Bearer ${privyToken}` },
    ),

  /**
   * Every venue series with this agent's registration and pricing state on it —
   * the whole opt-in surface in one read, which is what the pricing panel
   * renders.
   */
  getMarketRegistrations: (privyToken: string, slug: string) =>
    get<MarketRegistrationsView>(
      `/v1/account/agents/${encodeURIComponent(slug)}/market-registrations`,
      { Authorization: `Bearer ${privyToken}` },
    ),

  /** Opt the agent into serving a series. Idempotent — a repeat still answers 200. */
  postMarketRegistration: (
    privyToken: string,
    slug: string,
    venueSeriesId: string,
  ) =>
    post<MarketRegistrationWriteView>(
      `/v1/account/agents/${encodeURIComponent(slug)}/market-registrations`,
      { venue_series_id: venueSeriesId },
      { Authorization: `Bearer ${privyToken}` },
    ),

  /** Drop the registration. Cascades that series' terms away with it. */
  deleteMarketRegistration: (
    privyToken: string,
    slug: string,
    venueSeriesId: string,
  ) =>
    del<MarketRegistrationWriteView>(
      `/v1/account/agents/${encodeURIComponent(slug)}/market-registrations/` +
        `${encodeURIComponent(venueSeriesId)}`,
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

  /* ── Earnings, payouts, reveals, profile, lifecycle ─────────────────── */

  /**
   * What this agent's sales accrued, what murmur recorded as paid, and the
   * balance between them. `balance_atoms` is SIGNED: a negative balance means
   * murmur overpaid, and the UI states that rather than hiding it.
   */
  getAgentEarnings: (privyToken: string, slug: string) =>
    get<ProviderEarningsView>(
      `/v1/account/agents/${encodeURIComponent(slug)}/earnings`,
      { Authorization: `Bearer ${privyToken}` },
    ),

  /** The payout journal for one agent, newest first. Append-only, read-only. */
  getAgentPayouts: (privyToken: string, slug: string) =>
    get<ProviderPayoutsView>(
      `/v1/account/agents/${encodeURIComponent(slug)}/payouts`,
      { Authorization: `Bearer ${privyToken}` },
    ),

  /**
   * The reveal duty list. `fallback.grace_seconds` is what this deployment
   * configured, not a constant — `deadline` is null when no fallback worker
   * runs here.
   */
  getAgentReveals: (privyToken: string, slug: string) =>
    get<AccountRevealsView>(
      `/v1/account/agents/${encodeURIComponent(slug)}/reveals`,
      { Authorization: `Bearer ${privyToken}` },
    ),

  /**
   * Edit the two fields an owner may change. The handle is not one of them:
   * it lives in URLs and receipts, so the backend refuses it outright.
   * `bio: null` clears the bio; an omitted field is left alone.
   */
  patchAgentProfile: (
    privyToken: string,
    slug: string,
    body: { display_name?: string; bio?: string | null },
  ) =>
    patch<AgentProfileUpdateResponse>(
      `/v1/account/agents/${encodeURIComponent(slug)}/profile`,
      body,
      { Authorization: `Bearer ${privyToken}` },
    ),

  postAgentRetire: (privyToken: string, slug: string) =>
    post<AgentRetirementResponse>(
      `/v1/account/agents/${encodeURIComponent(slug)}/retire`,
      {},
      { Authorization: `Bearer ${privyToken}` },
    ),

  postAgentUnretire: (privyToken: string, slug: string) =>
    post<AgentRetirementResponse>(
      `/v1/account/agents/${encodeURIComponent(slug)}/unretire`,
      {},
      { Authorization: `Bearer ${privyToken}` },
    ),

  /**
   * Read the session, INCLUDING whether the account is closed.
   *
   * The one account route a closed account may still call. Every other one
   * answers 403, which on its own is indistinguishable from an outage — this
   * is how the dashboard learns to render the closed screen instead.
   */
  getAccountSession: (privyToken: string) =>
    get<AccountSessionState>("/v1/account/session", {
      Authorization: `Bearer ${privyToken}`,
    }),

  /** Close the account. Terminal — there is no reactivate call to pair with it. */
  postAccountDeactivate: (privyToken: string) =>
    post<AccountDeactivateResponse>(
      "/v1/account/deactivate",
      { confirm: ACCOUNT_DEACTIVATE_CONFIRM },
      { Authorization: `Bearer ${privyToken}` },
    ),

  /* ── Webhooks ─────────────────────────────────────────────────────────── */

  /**
   * Create a subscription. The `secret` in the response is the ONLY time the
   * signing key is ever returned — same one-shot contract as a minted key.
   */
  postWebhook: (privyToken: string, body: { agent_slug: string; url: string }) =>
    post<CreateWebhookResponse>("/v1/webhooks", body, {
      Authorization: `Bearer ${privyToken}`,
    }),

  /** Every subscription on agents this account owns. Never carries the secret. */
  getAccountWebhooks: (privyToken: string) =>
    get<{ webhooks: AccountWebhookRow[] }>("/v1/account/webhooks", {
      Authorization: `Bearer ${privyToken}`,
    }),

  /** Remove one, by ownership rather than by secret. */
  deleteAccountWebhook: (privyToken: string, id: string) =>
    del<{ deleted: boolean; id: string }>(
      `/v1/account/webhooks/${encodeURIComponent(id)}`,
      { Authorization: `Bearer ${privyToken}` },
    ),

  /* ── Purchases made by a controller wallet ────────────────────────────── */

  /**
   * A wallet's own early-access purchases.
   *
   * Unsigned, this returns granted rows only — they mirror on-chain grants
   * anyone can already read. A signature over
   * `murmur:purchases:<address>:<unix>` unlocks the full history, including
   * in-flight and refund-owed rows, because that is a private record of what
   * somebody tried to buy and what went wrong.
   */
  getWalletPurchases: (
    subscriber: string,
    auth?: { unixSeconds: number; signature: string },
    opts: { limit?: number; cursor?: string } = {},
  ) => {
    const params = new URLSearchParams({ subscriber });
    if (opts.limit) params.set("limit", String(opts.limit));
    if (opts.cursor) params.set("cursor", opts.cursor);
    return get<WalletPurchasesView>(
      `/v2/gateway/entitlements?${params.toString()}`,
      auth
        ? { "X-Murmur-Subscriber-Auth": `${auth.unixSeconds}:${auth.signature}` }
        : undefined,
    );
  },
};

/** The phrase POST /v1/account/deactivate requires. Mirrors the backend const. */
export const ACCOUNT_DEACTIVATE_CONFIRM = "close-my-account";

/** The message a wallet signs to unlock its full purchase history. */
export function purchasesAuthMessage(
  address: string,
  unixSeconds: number,
): string {
  return `murmur:purchases:${address.toLowerCase()}:${unixSeconds}`;
}

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

/**
 * Archive search — one page. Pass the previous page's `next_cursor` to walk
 * backwards through time; pass a fresh `AbortSignal` per query so a stale
 * response can never overwrite a newer one.
 */
export async function fetchArchivedMarkets(
  opts: {
    q?: string;
    from?: number | string;
    to?: number | string;
    cursor?: string;
    limit?: number;
  },
  signal?: AbortSignal,
): Promise<MarketArchivePage> {
  return verdictApi.marketsArchive(opts, signal);
}

export async function fetchAgentGrid(
  slug: string,
): Promise<{ agent: AgentGridSummary; grid: AgentMarketRow[] }> {
  const r = await verdictApi.agentGrid(slug);
  return { agent: r.agent, grid: r.grid };
}
