import { Router } from "express";
import type Database from "better-sqlite3";
import type { VerdictEventBus } from "./events.js";
import type { AgentSecurityEventIdAdapter } from "./agent-security-event.js";
import {
  type OperatorAlertSinkConfig,
} from "./operator-alerts.js";
import type { OperatorAlertIdAdapter } from "./operator-alerts.js";
import {
  type MurmurPublicOrigin,
} from "./public-origin.js";
import type { PrivyAuthVerifier } from "./auth/privy.js";
import { accountRouteLimiters } from "./account-rate-limit-surface.js";
import { resolvePolymarketGammaEnabled } from "./env-grammar.js";
import type { FeedContractIdAdapter } from "./feed-contract-surface.js";
import type { FeedPacketIdAdapter } from "./feed-packet-ingestion.js";
import type { FeedSlaIncidentIdAdapter } from "./feed-sla.js";
import type {
  PolymarketMarketRegistrationGammaAdapter,
} from "./polymarket-market-registration.js";
import type { SealedCallIdAdapter } from "./sealed-call-acceptance.js";
import { gatewayRouter } from "./routes/gateway.js";
import { operatorControlRouter } from "./routes/operator-control.js";
import { feedRouter } from "./routes/feeds.js";
import { syndicationRouter } from "./routes/syndication.js";
import { webhookRouter } from "./routes/webhooks.js";
import { refManagementRouter } from "./routes/ref-management.js";
import { publicAgentRouter } from "./routes/public-agents.js";
import { publicCallRouter } from "./routes/public-calls.js";
import { marketReadRouter } from "./routes/market-reads.js";
import { publicSystemRouter } from "./routes/public-system.js";
import { publicRankingRouter } from "./routes/public-rankings.js";
import { marketAdminRouter } from "./routes/market-admin.js";
import { deferredDisputeRouter } from "./routes/deferred-disputes.js";
import {
  type OperatorFhenixLifecycleQueryDefaults,
} from "./operator-fhenix-lifecycle-query.js";
import {
  type FhenixEventVerifier,
} from "../integrations/fhenix-events.js";
import type { FhenixGatewayBroadcaster } from "../integrations/fhenix-gateway.js";
import type { EntitlementAccessSurfaceDeps } from "./entitlement-access-surface.js";
import type { LiveCanaryProvider } from "../integrations/live-canaries.js";
import {
  type WebhookDnsLookup,
  type WebhookUrlPolicy,
} from "./webhook-url.js";
import { createVerdictErrorHandler } from "./verdict-error-surface.js";
import { createVerdictRouterRuntime } from "./verdict-router-runtime.js";

// ─── API surface ─────────────────────────────────────────────────────────────
//
// Public routes (no auth):
//   GET  /v1/health
//   GET  /v1/meta
//   GET  /v1/leaderboard?tier=&limit=
//   GET  /v1/agents/:slug
//   GET  /v1/agents/:slug/calls?limit=
//   GET  /v1/calls/:call_id
//
// Authed routes:
//   POST /v2/gateway/calls
//   POST /v2/gateway/feeds/:feed_id/packets
//   POST /v1/admin/fhenix/backfill/calls
//   POST /v1/admin/fhenix/reveals
//   POST /v1/admin/fhenix/invalid-reveals

export interface ApiDeps {
  db: Database.Database;
  /**
   * Runtime logger for unexpected route failures. Defaults to console for
   * backwards-compatible direct router construction.
   */
  logger?: Pick<Console, "error">;
  /**
   * Probe used by /v1/readyz. Should attempt a real oracle read and return
   * `null` on success or a string describing the failure. When unset, /readyz
   * still checks DB writeability but reports oracle as `disabled`.
   */
  oracleProbe?: () => Promise<string | null>;
  /**
   * Admin bearer token gating administrative routes.
   */
  adminToken?: string;
  /**
   * Optional event bus for live-streaming. When set, exposes `/v1/stream` (SSE).
   * When undefined, that route 404s.
   */
  events?: VerdictEventBus;
  /**
   * Verifies that submitted Fhenix metadata corresponds to real contract
   * events. Tests inject this; production uses FHENIX_RPC_URL when unset.
   */
  fhenixVerifier?: FhenixEventVerifier | null;
  /**
   * Gateway broadcaster for Runtime-Key-authenticated relayed Fhenix submits.
   * When unset, `/v2/gateway/calls` fails closed with 503.
   */
  fhenixGateway?: FhenixGatewayBroadcaster | null;
  /**
   * Flow 2 paid decrypt-access surface. When unset, the access routes under
   * `/v2/gateway/calls/:callId/access` fail closed with 503.
   */
  entitlementAccess?: EntitlementAccessSurfaceDeps | null;
  privyAuth?: PrivyAuthVerifier;
  /**
   * Optional live operator canaries for external dependencies that are not
   * safe to assume from local process health: Fhenix RPC/contract reachability
   * and Polymarket Gamma live market fetches.
   */
  liveCanaries?: LiveCanaryProvider | null;
  publicOrigin?: MurmurPublicOrigin;
  fhenixChainId?: number | null;
  fhenixSealedVerdictsAddress?: string | null;
  /**
   * When true, /readyz fails unless the latest live-canary snapshot is OK.
   * Defaults false so local/dev environments do not become dependent on
   * external RPC/API availability.
   */
  requireLiveCanaries?: boolean;
  /**
   * Optional admin/operator alert sink. Alerts are always persisted in the
   * local DB; when this sink is configured, `/v1/admin/alerts/tick` and the
   * daemon tick can also POST them to the operator's incident channel.
   */
  operatorAlertSink?: OperatorAlertSinkConfig | null;
  webhookDnsLookup?: WebhookDnsLookup;
  webhookSubscriptionId?: () => string;
  webhookSubscriptionSecret?: () => string;
  webhookUrlPolicy?: WebhookUrlPolicy;
  marketRegistrationGammaLookup?: PolymarketMarketRegistrationGammaAdapter;
  nanopayX402Mounted?: boolean;
  newAgentSecurityEventId?: AgentSecurityEventIdAdapter;
  newFeedId?: FeedContractIdAdapter;
  newFeedPacketId?: FeedPacketIdAdapter;
  newFeedSlaIncidentId?: FeedSlaIncidentIdAdapter;
  newOperatorAlertId?: OperatorAlertIdAdapter;
  newSealedCallId?: SealedCallIdAdapter;
  operatorFhenixLifecycleQueryDefaults?: OperatorFhenixLifecycleQueryDefaults;
  /**
   * Explicit Gamma venue-snapshot kill switch. The daemon parses
   * MURMUR_POLYMARKET_GAMMA_ENABLED into DaemonRuntimeConfig and forwards the
   * resulting boolean here, so an env injected via startDaemon({ env }) reaches
   * the market read surface. When unset (direct / test construction) the flag
   * falls back to the `env` → process.env derivation below. Precedence: this
   * boolean > env > process.env.
   */
  polymarketGammaEnabled?: boolean;
  /**
   * Env source used only for backwards-compatible defaults when explicit
   * runtime adapters are not passed. Daemon callers should pass parsed
   * adapters and adminToken instead.
   */
  env?: NodeJS.ProcessEnv;
  /** HTTP route operation clock shared across mounted route Modules. */
  now: () => Date;
}

export function createVerdictRouter(deps: ApiDeps): Router {
  const router = Router();
  const runtime = createVerdictRouterRuntime(deps);
  const { adminAuth, now } = runtime;

  router.use(gatewayRouter({
    db: deps.db,
    fhenixGateway: deps.fhenixGateway,
    now,
    privyAuth: deps.privyAuth,
    requireAdmin: adminAuth.requireAdmin,
    entitlementAccess: deps.entitlementAccess,
  }));

  router.use(operatorControlRouter({
    db: deps.db,
    events: deps.events,
    fhenixVerifier: runtime.fhenixVerifier,
    liveCanaries: deps.liveCanaries,
    newOperatorAlertId: deps.newOperatorAlertId,
    newSealedCallId: deps.newSealedCallId,
    now,
    operatorAlertSink: runtime.operatorAlertSink,
    fhenixLifecycleQueryDefaults: runtime.operatorFhenixLifecycleQueryDefaults,
    requireAdmin: adminAuth.requireAdmin,
    requireAdminBearer: adminAuth.requireAdminBearer,
    requireFhenixVerifier: runtime.requireFhenixVerifier,
  }));

  router.use(publicSystemRouter({
    db: deps.db,
    fhenixChain: runtime.fhenixChain,
    liveCanaries: deps.liveCanaries,
    nanopayX402Mounted: deps.nanopayX402Mounted,
    now,
    oracleProbe: deps.oracleProbe,
    publicOrigin: runtime.publicOrigin,
    requireLiveCanaries: deps.requireLiveCanaries,
  }));

  router.use(publicRankingRouter({
    db: deps.db,
    events: deps.events,
    now,
  }));

  router.use(publicAgentRouter({
    db: deps.db,
    nanopayX402Mounted: deps.nanopayX402Mounted,
    now,
    publicOrigin: runtime.publicOrigin,
  }));

  router.use(feedRouter({
    db: deps.db,
    newFeedId: deps.newFeedId,
    newFeedPacketId: deps.newFeedPacketId,
    newFeedSlaIncidentId: deps.newFeedSlaIncidentId,
    now,
    privyAuth: deps.privyAuth,
    requireAdmin: adminAuth.requireAdmin,
  }));

  const webhookLimiters = accountRouteLimiters();
  router.use(webhookRouter({
    db: deps.db,
    now,
    newSubscriptionId: deps.webhookSubscriptionId,
    newSubscriptionSecret: deps.webhookSubscriptionSecret,
    secretEquals: adminAuth.secretEquals,
    urlDnsLookup: runtime.webhookDnsLookup,
    urlPolicy: runtime.webhookUrlPolicy,
    // FOLLOW-UP 1 — webhook auth + two-stage rate limiter:
    //  privyAuth enforces account ownership of the slug being subscribed.
    //  subscriptionIpLimiter bounds anonymous spam BEFORE auth (30/hr).
    //  subscriptionAccountLimiter bounds per-account creates AFTER auth (10/hr).
    privyAuth: deps.privyAuth,
    subscriptionIpLimiter: webhookLimiters.webhookSubscriptionIpLimiter,
    subscriptionAccountLimiter: webhookLimiters.webhookSubscriptionAccountLimiter,
  }));

  router.use(syndicationRouter({
    db: deps.db,
    events: deps.events,
    now,
    publicOrigin: runtime.publicOrigin,
  }));

  router.use(refManagementRouter({
    db: deps.db,
    adminEnabled: adminAuth.adminEnabled,
    newAgentSecurityEventId: deps.newAgentSecurityEventId,
    now,
    requireAdminHeader: adminAuth.requireAdminHeader,
  }));

  router.use(marketAdminRouter({
    db: deps.db,
    gammaLookup: deps.marketRegistrationGammaLookup,
    newAgentSecurityEventId: deps.newAgentSecurityEventId,
    now,
    requireAdminHeader: adminAuth.requireAdminHeader,
  }));

  router.use(publicCallRouter({ db: deps.db }));

  router.use(deferredDisputeRouter());

  router.use(marketReadRouter({
    db: deps.db,
    now,
    // Gamma kill switch. The daemon parses MURMUR_POLYMARKET_GAMMA_ENABLED into
    // DaemonRuntimeConfig and forwards the resulting boolean as
    // deps.polymarketGammaEnabled, so an env injected via startDaemon({ env })
    // reaches this read surface. When that explicit signal is absent (direct /
    // test construction) the flag derives from the INJECTED env only — no
    // process.env ambient fallback, so tests are deterministic without
    // scrubbing the real environment — via the single shared kill-switch
    // derivation. When false the read surface never constructs the live Gamma
    // snapshot provider.
    polymarketGammaEnabled:
      deps.polymarketGammaEnabled ??
      resolvePolymarketGammaEnabled(deps.env ?? {}),
  }));

  // Wave 4b-2 — /v1/market/preflight endpoint dropped alongside the
  // Santiment scout/analyst pipeline. The endpoint returned composite
  // score / regime / top playbook decoration that the resolver never
  // consulted; nothing on the agent path required it. Murmur is a pure
  // ranking layer over canonical price/event oracles.

  router.use(createVerdictErrorHandler(runtime.logger));

  return router;
}
