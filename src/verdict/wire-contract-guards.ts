// Compile-time producer guards for the shared REST wire types.
//
// This module contains NO runtime code. It pins every browser-safe wire type
// (src/types/wire-*.ts, consumed by the dashboard via the `@shared` alias)
// against the daemon's AUTHORITATIVE type — the zod-inferred type, the exported
// presenter/row type, or the surface function's return type. It follows the
// exact idiom already used for the SSE channel in src/verdict/events.ts:
//
//   type _X = Assert<Equals<WireX, DaemonX>>;
//
// If the daemon renames / removes / retypes a field the wire contract depends
// on, one of these assertions stops being `true` and the DAEMON build fails —
// forcing the shared wire type (and therefore the dashboard) to be updated in
// lockstep, instead of the rename silently shipping as `undefined` to the SPA.
//
// Two relations are used:
//   • Equals<A, B>   — bidirectional (the strong pin; matches events.ts).
//   • Conforms<D, W> — one-directional "the daemon's output D is assignable to
//                      the wire contract W". Used where the wire type is a
//                      deliberate permissive superset (e.g. MarketRow's index
//                      signature, the call projections' optional post-reveal
//                      plaintext keys, snapshots the dashboard reads a subset
//                      of). It still fails on any rename/removal/retype of a
//                      field the wire contract REQUIRES.

/* eslint-disable @typescript-eslint/no-unused-vars */

// ── Relations (identical idiom to src/verdict/events.ts) ────────────────────
type Equals<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Conforms<Daemon, Wire> = [Daemon] extends [Wire] ? true : false;
type Assert<T extends true> = T;
/** Extract the success (2xx) body from a surface function's return union. */
type OkBody<T> = Extract<T, { status: 200 | 201 | 202 }> extends { body: infer B }
  ? B
  : never;

// ── Wire types (the shared contract) ────────────────────────────────────────
import type { WireAgentKind, WireAgentProfile, WireAgentGridSummary } from "../types/wire-agent.js";
import type {
  WireLeaderboardRow,
  WireAgentFamilyRow,
  WireAgentCrossFamilyRow,
  WireAgentMarketRow,
} from "../types/wire-leaderboard.js";
import type { WireAgentCallRow, WireFullCall, WireMarketCallRow } from "../types/wire-call.js";
import type { WireCallStatus } from "../types/wire-call-status.js";
import type { WireTodayFeed, WireTodayFeedRow, WireTodayMover } from "../types/wire-feed.js";
import type {
  WireMarketRow,
  WireMarketTaxonomyResponse,
  WireMarketTaxonomyClass,
  WireMarketTaxonomyAssignment,
  WireMarketOracleSummary,
  WireMarketOracleRef,
  WireMarketOracleHealth,
  WireMarketVenueSnapshot,
  WireMarketVenuePricePoint,
  WireMarketClock,
} from "../types/wire-market.js";
import type { WireMetaResponse } from "../types/wire-meta.js";
import type {
  WireMarketplaceSeries,
  WireMarketplaceTrackRecord,
  WireMarketplaceCurrentTerms,
  WireMarketplaceListings,
  WireInventoryStatus,
  WireLockedTerms,
  WireSellableCall,
} from "../types/wire-marketplace.js";
import type {
  WireAccountSession,
  WireAccountAgent,
  WireControllerWalletSummary,
  WireCreateAgentResponse,
  WireBindWalletResponse,
  WireControllerWalletChallengeResponse,
  WireControllerWalletReattestationChallengeResponse,
  WireControllerWalletReattestationResponse,
  WireRuntimeKeyPolicy,
  WireRuntimeKeyRow,
  WireRuntimeKeyChallengeResponse,
  WireRuntimeKeyMintResponse,
  WireMintApiKeyResponse,
  WireApiKeyRow,
  WireRotateApiKeyResponse,
  WirePatchDestinationResponse,
  WireDestinationCooldownError,
  WireAdminRefSender,
} from "../types/wire-account.js";
import type {
  WireGatewayAttemptStatus,
  WireGatewayOperatorAttempt,
  WireGatewayOperatorFeedAttempt,
  WireGatewayTelemetrySummary,
  WireGatewayOperatorSnapshot,
  WireLiveCanaryStatus,
  WireLiveCanaryName,
  WireLiveCanaryCheck,
  WireLiveCanarySnapshot,
  WireFhenixRevealStatus,
  WireFhenixLifecycleSnapshot,
  WireControllerIdentityStatus,
  WireControllerIdentitySnapshot,
  WireOperatorAlertSeverity,
  WireOperatorAlertStatus,
  WireOperatorAlertDeliveryStatus,
  WireOperatorAlert,
  WireOperatorAlertsSnapshot,
  WireOperatorAlertTickResponse,
  WireFeedSlaIncidentStatus,
  WireFeedSlaIncident,
  WireFeedAvailabilitySummary,
  WireFeedAvailabilityProof,
} from "../types/wire-operator.js";

// ── Daemon authoritative types ──────────────────────────────────────────────
import type { AgentKind, CallStatus, LeaderboardRow } from "./schema.js";
import type { PublicMurmurAgentProfile } from "./murmur-agent-public-profile.js";
import type { AgentFamilyRow, AgentCrossFamilyRow } from "./leaderboard-families.js";
import type { AgentMarketRow } from "./leaderboard-markets.js";
import type {
  PublicAgentCallProjection,
  PublicMarketCallProjection,
  PublicSealedCallView,
} from "./sealed-call-public-projection.js";
import type { TodayFeed, TodayFeedRow, TodayMover } from "./feed.js";
import type {
  MarketClockSnapshot,
  VenueEnrichedMarketRegistryRow,
} from "./market-read-surface.js";
import type {
  PublicMarketOracleSummary,
  PublicMarketOracleRef,
  PublicMarketOracleHealth,
} from "./market-registry-public.js";
import type {
  MarketTaxonomyClass,
  MarketTaxonomyAssignment,
  marketTaxonomyResponse,
} from "./market-taxonomy.js";
import type {
  MarketVenueSnapshot,
  MarketVenuePricePoint,
} from "../markets/polymarket-gamma/venue-snapshot.js";
import type { publicMetaSurface } from "./public-system-surface.js";
import type {
  MarketplaceListingsBody,
  MarketplaceTrackRecord,
  MarketplaceCurrentTerms,
} from "./marketplace-listings-surface.js";
import type { MarketplaceSeriesRow } from "./marketplace-listings-query.js";
import type {
  InventoryStatus,
  LockedTerms,
  SellableCallRow,
} from "./gateway-sellable-surface.js";

import type { accountSessionResponse } from "./account-session-surface.js";
import type {
  listAccountAgentsResponse,
  createAccountAgentResponse,
} from "./account-agent-surface.js";
import type {
  mintAgentApiKeyResponse,
  listAgentApiKeysResponse,
  rotateAccountApiKeyResponse,
} from "./account-api-key-surface.js";
import type { setAccountDestinationAddressResponse } from "./account-destination-surface.js";
import type {
  controllerWalletChallengeResponse,
  controllerWalletReattestationChallengeResponse,
} from "./account-controller-wallet-surface.js";
import type {
  runtimeKeyChallengeResponse,
  mintAccountRuntimeKeyResponse,
} from "./account-runtime-key-surface.js";
import type { publicControllerWalletRow, publicRuntimeKeyRow } from "./agent-identity.js";
import type { RuntimeKeyPolicy as DaemonRuntimeKeyPolicy } from "./auth/runtime-key-policy.js";

import type {
  GatewayOperatorAttempt,
  GatewayOperatorFeedAttempt,
  GatewayOperatorSnapshot,
} from "./operator-gateway-snapshot.js";
import type {
  FhenixGatewayTelemetrySummary,
  FhenixGatewayTxStatus,
} from "./repos/fhenix-gateway-attempt-lifecycle.js";
import type {
  LiveCanarySnapshot,
  LiveCanaryCheck,
  LiveCanaryStatus,
  LiveCanaryName,
} from "../integrations/live-canaries.js";
import type { FhenixRevealStatus } from "./repos/fhenix-sealed-calls-repo.js";
import type { fhenixLifecycleSnapshot } from "./operator-fhenix-lifecycle-snapshot.js";
import type { controllerIdentitySnapshot } from "./operator-controller-identity-snapshot.js";
import type { ControllerWalletReattestationHealthStatus } from "./auth/controller-wallets.js";
import type {
  OperatorAlertsSnapshot,
  PublicOperatorAlert,
} from "./operator-alert-presenters.js";
import type {
  OperatorAlertSeverity,
  OperatorAlertStatus,
  OperatorAlertDeliveryStatus,
} from "./repos/operator-alerts-repo.js";
import type { OperatorAlertTickResult } from "./operator-alerts.js";
import type {
  FeedAvailabilitySummary,
  FeedAvailabilityProof,
} from "./feed-availability-proof.js";
import type { FeedSlaIncidentStatus } from "./repos/feed-availability-repo.js";
import type { publicFeedSlaIncident } from "./feed-presenters.js";
import type { RefTopSenderRow } from "./repos/ref-attribution-repo.js";

// ── Public read surface ─────────────────────────────────────────────────────
type _AgentKind = Assert<Equals<WireAgentKind, AgentKind>>;
type _AgentProfile = Assert<Equals<WireAgentProfile, PublicMurmurAgentProfile>>;
type _AgentGridSummary = Assert<
  Conforms<
    { agent_id: string; display_slug: string; display_name: string; kind: AgentKind },
    WireAgentGridSummary
  >
>;

// LeaderboardRow / AgentMarketRow are pinned with `Conforms` (not `Equals`)
// because the wire type marks a few daemon-always-present fields optional so
// the dashboard's SSE-delta merge path can build partial rows.
type _LeaderboardRow = Assert<Conforms<LeaderboardRow, WireLeaderboardRow>>;
type _AgentFamilyRow = Assert<Equals<WireAgentFamilyRow, AgentFamilyRow>>;
type _AgentCrossFamilyRow = Assert<Equals<WireAgentCrossFamilyRow, AgentCrossFamilyRow>>;
type _AgentMarketRow = Assert<Conforms<AgentMarketRow, WireAgentMarketRow>>;

type _AgentCallRow = Assert<Conforms<PublicAgentCallProjection, WireAgentCallRow>>;
type _FullCall = Assert<Conforms<PublicSealedCallView, WireFullCall>>;
type _MarketCallRow = Assert<Conforms<PublicMarketCallProjection, WireMarketCallRow>>;

// The dashboard's shared call-status union (src/types/wire-call-status.ts,
// consumed by AgentPage / MarketDetailPage predicates) is pinned to the
// daemon's authoritative CallStatus enum with the strong bidirectional relation
// — a daemon-side add/rename/removal of a lifecycle status fails THIS build
// until the shared union (and the dashboard classifiers) are updated in lockstep.
type _CallStatus = Assert<Equals<WireCallStatus, CallStatus>>;

type _TodayFeed = Assert<Conforms<TodayFeed, WireTodayFeed>>;
type _TodayFeedRow = Assert<Conforms<TodayFeedRow, WireTodayFeedRow>>;
type _TodayMover = Assert<Equals<WireTodayMover, TodayMover>>;

// ── Markets ─────────────────────────────────────────────────────────────────
type _MarketRow = Assert<Conforms<VenueEnrichedMarketRegistryRow, WireMarketRow>>;
type _MarketTaxonomyResponse = Assert<
  Conforms<ReturnType<typeof marketTaxonomyResponse>, WireMarketTaxonomyResponse>
>;
type _MarketTaxonomyClass = Assert<Conforms<MarketTaxonomyClass, WireMarketTaxonomyClass>>;
type _MarketTaxonomyAssignment = Assert<
  Conforms<MarketTaxonomyAssignment, WireMarketTaxonomyAssignment>
>;
type _MarketOracleSummary = Assert<Conforms<PublicMarketOracleSummary, WireMarketOracleSummary>>;
type _MarketOracleRef = Assert<Conforms<PublicMarketOracleRef, WireMarketOracleRef>>;
type _MarketOracleHealth = Assert<Equals<WireMarketOracleHealth, PublicMarketOracleHealth>>;
type _MarketVenueSnapshot = Assert<Conforms<MarketVenueSnapshot, WireMarketVenueSnapshot>>;
type _MarketVenuePricePoint = Assert<Conforms<MarketVenuePricePoint, WireMarketVenuePricePoint>>;
// Strong relation: the matrix's window grouping and phase machine are driven
// entirely by these instants, so a daemon-side rename must break this build
// rather than reach the dashboard as `undefined` and silently collapse every
// market into one untimed group.
type _MarketClock = Assert<Equals<WireMarketClock, MarketClockSnapshot>>;

// ── Meta ────────────────────────────────────────────────────────────────────
type _MetaResponse = Assert<Conforms<ReturnType<typeof publicMetaSurface>, WireMetaResponse>>;

// ── Marketplace ─────────────────────────────────────────────────────────────
// The catalog body is pinned WHOLE, so a rename anywhere inside series /
// agents / listings / track_record fails this build. `marketplaceListingsResponse`
// itself types `status` as plain `number`, so OkBody<> cannot narrow its union —
// the exported body type IS the authoritative shape and is pinned directly.
type _MarketplaceSeries = Assert<Conforms<MarketplaceSeriesRow, WireMarketplaceSeries>>;
type _MarketplaceTrackRecord = Assert<
  Conforms<MarketplaceTrackRecord, WireMarketplaceTrackRecord>
>;
type _MarketplaceCurrentTerms = Assert<
  Conforms<MarketplaceCurrentTerms, WireMarketplaceCurrentTerms>
>;
type _MarketplaceListings = Assert<Conforms<MarketplaceListingsBody, WireMarketplaceListings>>;

// The sellable envelope is typed `body: unknown` on the daemon side, so only
// the ROW is pinnable — and the row is what carries the money. `locked_terms`
// gets the strong bidirectional relation because a UI that loses it silently
// falls back to quoting the standing `current_terms` beside a buy affordance,
// which is the single most expensive bug this pair of surfaces can produce.
// The row relation stays one-directional: it also carries deprecated top-level
// price aliases the wire contract deliberately does not mirror.
type _InventoryStatus = Assert<Equals<WireInventoryStatus, InventoryStatus>>;
type _LockedTerms = Assert<Equals<WireLockedTerms, LockedTerms>>;
type _SellableCall = Assert<Conforms<SellableCallRow, WireSellableCall>>;

// ── Account surface ─────────────────────────────────────────────────────────
type _ControllerWalletSummary = Assert<
  Conforms<ReturnType<typeof publicControllerWalletRow>, WireControllerWalletSummary>
>;
type _RuntimeKeyRow = Assert<Conforms<ReturnType<typeof publicRuntimeKeyRow>, WireRuntimeKeyRow>>;
type _RuntimeKeyPolicy = Assert<Conforms<DaemonRuntimeKeyPolicy, WireRuntimeKeyPolicy>>;

type _AccountSession = Assert<
  Conforms<OkBody<ReturnType<typeof accountSessionResponse>>, WireAccountSession>
>;
type _AccountAgent = Assert<
  Conforms<
    OkBody<ReturnType<typeof listAccountAgentsResponse>>["agents"][number],
    WireAccountAgent
  >
>;
type _CreateAgentResponse = Assert<
  Conforms<OkBody<ReturnType<typeof createAccountAgentResponse>>, WireCreateAgentResponse>
>;
type _MintApiKeyResponse = Assert<
  Conforms<OkBody<ReturnType<typeof mintAgentApiKeyResponse>>, WireMintApiKeyResponse>
>;
type _ApiKeyRow = Assert<
  Conforms<OkBody<ReturnType<typeof listAgentApiKeysResponse>>["keys"][number], WireApiKeyRow>
>;
type _RotateApiKeyResponse = Assert<
  Conforms<OkBody<ReturnType<typeof rotateAccountApiKeyResponse>>, WireRotateApiKeyResponse>
>;
type _PatchDestinationResponse = Assert<
  Conforms<
    OkBody<ReturnType<typeof setAccountDestinationAddressResponse>>,
    WirePatchDestinationResponse
  >
>;
type _DestinationCooldownError = Assert<
  Conforms<
    Extract<ReturnType<typeof setAccountDestinationAddressResponse>, { status: 429 }>["body"],
    WireDestinationCooldownError
  >
>;
type _ControllerWalletChallengeResponse = Assert<
  Conforms<
    OkBody<ReturnType<typeof controllerWalletChallengeResponse>>,
    WireControllerWalletChallengeResponse
  >
>;
type _ControllerWalletReattestationChallengeResponse = Assert<
  Conforms<
    OkBody<ReturnType<typeof controllerWalletReattestationChallengeResponse>>,
    WireControllerWalletReattestationChallengeResponse
  >
>;
type _RuntimeKeyChallengeResponse = Assert<
  Conforms<
    OkBody<ReturnType<typeof runtimeKeyChallengeResponse>>,
    WireRuntimeKeyChallengeResponse
  >
>;
type _RuntimeKeyMintResponse = Assert<
  Conforms<
    OkBody<Awaited<ReturnType<typeof mintAccountRuntimeKeyResponse>>>,
    WireRuntimeKeyMintResponse
  >
>;
// Bind wallet + reattestation responses spread publicControllerWalletRow; the
// drift-prone controller-wallet fields are pinned via that presenter above.
type _BindWalletResponse = Assert<
  Conforms<
    ReturnType<typeof publicControllerWalletRow> & {
      agent_id: string;
      display_slug: string;
      idempotent_hit: boolean;
    },
    WireBindWalletResponse
  >
>;
type _ControllerWalletReattestationResponse = Assert<
  Conforms<
    {
      agent_id: string;
      display_slug: string;
      attestation_id: string;
      controller_wallet: ReturnType<typeof publicControllerWalletRow>;
    },
    WireControllerWalletReattestationResponse
  >
>;

// ── Operator / admin surface ────────────────────────────────────────────────
type _GatewayAttemptStatus = Assert<Equals<WireGatewayAttemptStatus, FhenixGatewayTxStatus>>;
type _GatewayOperatorAttempt = Assert<
  Conforms<GatewayOperatorAttempt, WireGatewayOperatorAttempt>
>;
type _GatewayOperatorFeedAttempt = Assert<
  Conforms<GatewayOperatorFeedAttempt, WireGatewayOperatorFeedAttempt>
>;
type _GatewayTelemetrySummary = Assert<
  Conforms<FhenixGatewayTelemetrySummary, WireGatewayTelemetrySummary>
>;
type _GatewayOperatorSnapshot = Assert<
  Conforms<{ schema_version: number } & GatewayOperatorSnapshot, WireGatewayOperatorSnapshot>
>;

type _LiveCanaryStatus = Assert<Equals<WireLiveCanaryStatus, LiveCanaryStatus>>;
type _LiveCanaryName = Assert<Equals<WireLiveCanaryName, LiveCanaryName>>;
type _LiveCanaryCheck = Assert<Conforms<LiveCanaryCheck, WireLiveCanaryCheck>>;
type _LiveCanarySnapshot = Assert<Conforms<LiveCanarySnapshot, WireLiveCanarySnapshot>>;

type _FhenixRevealStatus = Assert<Equals<WireFhenixRevealStatus, FhenixRevealStatus>>;
type _FhenixLifecycleSnapshot = Assert<
  Conforms<
    { schema_version: number } & ReturnType<typeof fhenixLifecycleSnapshot>,
    WireFhenixLifecycleSnapshot
  >
>;

type _ControllerIdentityStatus = Assert<
  Conforms<ControllerWalletReattestationHealthStatus, WireControllerIdentityStatus>
>;
type _ControllerIdentitySnapshot = Assert<
  Conforms<
    { schema_version: number } & ReturnType<typeof controllerIdentitySnapshot>,
    WireControllerIdentitySnapshot
  >
>;

type _OperatorAlertSeverity = Assert<Equals<WireOperatorAlertSeverity, OperatorAlertSeverity>>;
type _OperatorAlertStatus = Assert<Equals<WireOperatorAlertStatus, OperatorAlertStatus>>;
type _OperatorAlertDeliveryStatus = Assert<
  Equals<WireOperatorAlertDeliveryStatus, OperatorAlertDeliveryStatus>
>;
type _OperatorAlert = Assert<Conforms<PublicOperatorAlert, WireOperatorAlert>>;
type _OperatorAlertsSnapshot = Assert<
  Conforms<{ schema_version: number } & OperatorAlertsSnapshot, WireOperatorAlertsSnapshot>
>;
// The nested `snapshot` inside the tick result is the RAW OperatorAlertsSnapshot
// (no top-level schema_version — that wrapper is only added on the GET path,
// pinned by _OperatorAlertsSnapshot above), so it is excluded here and the
// schema_version + scan + delivery envelope is pinned instead.
type _OperatorAlertTickResponse = Assert<
  Conforms<
    { schema_version: number } & Omit<OperatorAlertTickResult, "snapshot">,
    Omit<WireOperatorAlertTickResponse, "snapshot">
  >
>;

type _FeedSlaIncidentStatus = Assert<Equals<WireFeedSlaIncidentStatus, FeedSlaIncidentStatus>>;
type _FeedSlaIncident = Assert<
  Conforms<ReturnType<typeof publicFeedSlaIncident>, WireFeedSlaIncident>
>;
// refund_recommendations / slash_recommendations are a daemon-private
// ActionCounts object; the dashboard's long-standing wire type models them as a
// number-map and reads them as counts. That is a pre-existing dashboard/daemon
// disagreement, and resolving it would mean editing out-of-scope dashboard
// files — so those two fields are excluded and every other field is pinned.
type FeedRecFields = "refund_recommendations" | "slash_recommendations";
type _FeedAvailabilitySummary = Assert<
  Conforms<Omit<FeedAvailabilitySummary, FeedRecFields>, Omit<WireFeedAvailabilitySummary, FeedRecFields>>
>;
type _FeedAvailabilityProof = Assert<
  Conforms<Omit<FeedAvailabilityProof, FeedRecFields>, Omit<WireFeedAvailabilityProof, FeedRecFields>>
>;

type _AdminRefSender = Assert<Conforms<RefTopSenderRow, WireAdminRefSender>>;
