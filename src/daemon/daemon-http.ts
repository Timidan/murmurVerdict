import cors from "cors";
import express, { type Express } from "express";
import type Database from "better-sqlite3";

import type { FhenixEventVerifier } from "../integrations/fhenix-events.js";
import type { FhenixGatewayBroadcaster } from "../integrations/fhenix-gateway.js";
import type { FhenixSaleTermsEnv } from "../integrations/fhenix-grant-env.js";
import type { LiveCanaryProvider } from "../integrations/live-canaries.js";
import type { VenueTickerReader } from "../integrations/venue-ticker.js";
import { venueTickerRouter } from "../integrations/venue-ticker-surface.js";
import { createVerdictRouter } from "../verdict/api.js";
import type { EntitlementAccessSurfaceDeps } from "../verdict/entitlement-access-surface.js";
import { createVerdictErrorHandler } from "../verdict/verdict-error-surface.js";
import type { AccountAgentIdAdapter } from "../verdict/account-agent-surface.js";
import type { AgentSecurityEventIdAdapter } from "../verdict/agent-security-event.js";
import type { FeedContractIdAdapter } from "../verdict/feed-contract-surface.js";
import type { FeedPacketIdAdapter } from "../verdict/feed-packet-ingestion.js";
import type { FeedSlaIncidentIdAdapter } from "../verdict/feed-sla.js";
import type { SealedCallIdAdapter } from "../verdict/sealed-call-acceptance.js";
import type {
  AccountIdAdapter,
  ControllerWalletReattestationIdAdapter,
} from "../verdict/auth/accounts.js";
import type { PrivyAuthVerifier } from "../verdict/auth/privy.js";
import type { VerdictEventBus } from "../verdict/events.js";
import type { OperatorAlertSinkConfig } from "../verdict/operator-alerts.js";
import type { OperatorAlertIdAdapter } from "../verdict/operator-alerts.js";
import type {
  PolymarketMarketRegistrationGammaAdapter,
} from "../verdict/polymarket-market-registration.js";
import { accountRouter } from "../verdict/routes/account.js";
import { privyWebhookRouter } from "../verdict/routes/privy-webhooks.js";
import { createPrivyWebhookVerifier } from "../verdict/auth/privy-webhook-verify.js";
import { reparentAccount } from "../verdict/auth/account-reparent.js";
import type { ControllerWalletAuthorizationNonceAdapter } from "../verdict/controller-wallet-authorization.js";
import type { UsageEventIdAdapter } from "../verdict/usage-event.js";
import type { DaemonRuntimeConfig } from "./daemon-config.js";
import {
  mountNanopayRuntime,
  type DaemonNanopayRuntime,
} from "./nanopay-runtime.js";

export interface DaemonHttpSurfaceDeps {
  db: Database.Database;
  config: DaemonRuntimeConfig;
  logger?: Pick<Console, "error">;
  events: VerdictEventBus;
  fhenixVerifier: FhenixEventVerifier | null;
  fhenixGateway: FhenixGatewayBroadcaster | null;
  privyAuth?: PrivyAuthVerifier | null;
  fhenixChainId: number | null;
  fhenixSealedVerdictsAddress: string | null;
  /**
   * Deployment-wide access terms + sales safety margin for the public sellable
   * listing, parsed from the daemon's INJECTED env (the router is handed
   * `env: {}` below, so it cannot derive these itself).
   */
  fhenixSaleTerms?: FhenixSaleTermsEnv;
  liveCanaries: LiveCanaryProvider;
  marketRegistrationGammaLookup?: PolymarketMarketRegistrationGammaAdapter;
  newAccountId?: AccountIdAdapter;
  newAgentId?: AccountAgentIdAdapter;
  newAgentSecurityEventId?: AgentSecurityEventIdAdapter;
  newApiKeyId?: () => string;
  newApiKeySecret?: () => string;
  newAuthorizationNonce?: ControllerWalletAuthorizationNonceAdapter;
  newFeedId?: FeedContractIdAdapter;
  newFeedPacketId?: FeedPacketIdAdapter;
  newFeedSlaIncidentId?: FeedSlaIncidentIdAdapter;
  newOperatorAlertId?: OperatorAlertIdAdapter;
  newReattestationId?: ControllerWalletReattestationIdAdapter;
  newRuntimeKeyId?: () => string;
  newRuntimeKeySecret?: () => string;
  newSealedCallId?: SealedCallIdAdapter;
  newUsageEventId?: UsageEventIdAdapter;
  now: () => Date;
  operatorAlertSink?: OperatorAlertSinkConfig | null;
  nanopayRuntime?: DaemonNanopayRuntime | null;
  entitlementAccess?: EntitlementAccessSurfaceDeps | null;
  /**
   * Narrow read handle on the live venue ticker. Constructed inert before the
   * surface so the two `/v2/venue/*` routes can close over it, then started
   * after the server listens. `null` (or a ticker that is not running) makes
   * both routes answer 503.
   */
  venueTicker?: VenueTickerReader | null;
}

export function createDaemonHttpSurface(
  deps: DaemonHttpSurfaceDeps,
): Express {
  const app = express();
  // Never trust X-Forwarded-For on the directly exposed default topology.
  // Operators behind a known proxy can opt into the exact hop count; making
  // this explicit prevents callers from rotating forged IPs around rate limits.
  app.set("trust proxy", deps.config.trustProxyHops || false);

  if (deps.config.dashboardCors.kind === "any") {
    app.use(cors());
  } else {
    app.use(
      cors({
        origin: deps.config.dashboardCors.origins,
        credentials: true,
      }),
    );
  }

  // Mount the inbound Privy transfer receiver FIRST: it installs a route-scoped
  // raw-body parser on POST /v1/privy/webhooks so the svix signature verifies
  // against the exact bytes Privy signed. The account router below installs a
  // JSON body parser that would otherwise consume the body first. The receiver
  // fail-closes to 503 when PRIVY_WEBHOOK_SIGNING_SECRET is unset.
  app.use(
    privyWebhookRouter({
      db: deps.db,
      verifier: createPrivyWebhookVerifier({
        appId: deps.config.privyAuth.appId,
        appSecret: deps.config.privyAuth.appSecret,
        signingSecret: deps.config.privyWebhookSigningSecret,
      }),
      reparent: reparentAccount,
      logger: deps.logger,
    }),
  );

  app.use(
    createVerdictRouter({
      db: deps.db,
      adminToken: deps.config.adminToken,
      logger: deps.logger,
      events: deps.events,
      fhenixVerifier: deps.fhenixVerifier,
      fhenixGateway: deps.fhenixGateway,
      entitlementAccess: deps.entitlementAccess,
      privyAuth: deps.privyAuth ?? undefined,
      popAudience: deps.config.popAudience,
      liveCanaries: deps.liveCanaries,
      publicOrigin: deps.config.publicOrigin,
      fhenixChainId: deps.fhenixChainId,
      fhenixSealedVerdictsAddress: deps.fhenixSealedVerdictsAddress,
      saleTerms: deps.fhenixSaleTerms,
      marketRegistrationGammaLookup: deps.marketRegistrationGammaLookup,
      nanopayX402Mounted: Boolean(deps.nanopayRuntime),
      newAgentSecurityEventId: deps.newAgentSecurityEventId,
      newFeedId: deps.newFeedId,
      newFeedPacketId: deps.newFeedPacketId,
      newFeedSlaIncidentId: deps.newFeedSlaIncidentId,
      newOperatorAlertId: deps.newOperatorAlertId,
      newSealedCallId: deps.newSealedCallId,
      requireLiveCanaries: deps.config.requireLiveCanaries,
      operatorAlertSink: deps.operatorAlertSink === undefined
        ? deps.config.operatorAlertSink
        : deps.operatorAlertSink,
      webhookUrlPolicy: deps.config.webhookUrlPolicy,
      operatorFhenixLifecycleQueryDefaults:
        deps.config.operatorFhenixLifecycleQueryDefaults,
      // Forward the parsed Gamma kill switch so an env injected via
      // startDaemon({ env }) reaches the market read surface. `env` stays {}
      // to keep the router isolated from ambient process.env for every other
      // derivation (all of which are passed explicitly above).
      polymarketGammaEnabled: deps.config.polymarketGammaEnabled,
      env: {},
      now: deps.now,
    }),
  );

  app.use(accountRouter({
    accountAuth: deps.privyAuth ?? undefined,
    db: deps.db,
    newAccountId: deps.newAccountId,
    newAgentId: deps.newAgentId,
    newApiKeyId: deps.newApiKeyId,
    newApiKeySecret: deps.newApiKeySecret,
    newAuthorizationNonce: deps.newAuthorizationNonce,
    newReattestationId: deps.newReattestationId,
    newRuntimeKeyId: deps.newRuntimeKeyId,
    newRuntimeKeySecret: deps.newRuntimeKeySecret,
    newUsageEventId: deps.newUsageEventId,
    // The grant runtime knows what it can deliver; provider-terms reports it.
    deliverableCap: deps.entitlementAccess?.access.maxArmedPerCall,
    // Murmur's cut, from the PARSED config rather than the ambient process, so
    // a daemon started with an injected env prices the same way it seals.
    // Setting terms is refused while this is null: a call sealed for a selling
    // agent has to freeze a split, and there would be none to freeze.
    protocolFeeBps: deps.config.fhenixRuntime.protocolFeeBps,
    // The agent-exclusive reveal window, as THIS deployment configured it.
    // Threaded from the parsed reveal-worker config rather than re-read from
    // the ambient env, and left null when no worker runs — the reveals surface
    // then reports no deadline instead of printing the loader's 300s default
    // as though it were policy.
    revealGraceSeconds: deps.config.fhenixRuntime.revealWorker?.graceSeconds ?? null,
    now: deps.now,
  }));

  // Venue ticker read surface. Its own route + its own bounded write path;
  // deliberately not folded into `/v1/stream`, whose fan-out reaches every
  // public consumer and ignores backpressure.
  app.use(
    venueTickerRouter({ reader: deps.venueTicker ?? null }),
  );

  mountNanopayRuntime(app, deps.nanopayRuntime);

  // App-level VerdictError → JSON translator. Without this, errors thrown
  // out of `accountRouter` (and any future sibling router) fall through to
  // Express's default error handler, which renders an HTML 500 page even
  // when the underlying VerdictError already carries an httpStatus + code
  // (e.g. 409 controller_wallet_binding_conflict). createVerdictRouter
  // mounts its own copy of this handler for its child routes, but that
  // instance only catches errors from inside it — top-level routers need
  // their own coverage. Single line, idempotent, prevents the bug ever
  // returning if a new top-level router gets added later.
  app.use(createVerdictErrorHandler(deps.logger ?? console));

  return app;
}
