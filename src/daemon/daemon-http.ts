import cors from "cors";
import express, { type Express } from "express";
import type Database from "better-sqlite3";

import type { FhenixEventVerifier } from "../integrations/fhenix-events.js";
import type { FhenixGatewayBroadcaster } from "../integrations/fhenix-gateway.js";
import type { LiveCanaryProvider } from "../integrations/live-canaries.js";
import type { OracleClient } from "../integrations/oracle.js";
import { createVerdictRouter } from "../verdict/api.js";
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
  oracle: OracleClient | null;
  fhenixVerifier: FhenixEventVerifier | null;
  fhenixGateway: FhenixGatewayBroadcaster | null;
  privyAuth?: PrivyAuthVerifier | null;
  fhenixChainId: number | null;
  fhenixSealedVerdictsAddress: string | null;
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
}

export function createDaemonHttpSurface(
  deps: DaemonHttpSurfaceDeps,
): Express {
  const app = express();
  app.set("trust proxy", 1);

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

  app.use(
    createVerdictRouter({
      db: deps.db,
      adminToken: deps.config.adminToken,
      logger: deps.logger,
      events: deps.events,
      oracleProbe: deps.oracle ? oracleProbe(deps.oracle) : undefined,
      fhenixVerifier: deps.fhenixVerifier,
      fhenixGateway: deps.fhenixGateway,
      privyAuth: deps.privyAuth ?? undefined,
      liveCanaries: deps.liveCanaries,
      publicOrigin: deps.config.publicOrigin,
      fhenixChainId: deps.fhenixChainId,
      fhenixSealedVerdictsAddress: deps.fhenixSealedVerdictsAddress,
      marketRegistrationGammaLookup: deps.marketRegistrationGammaLookup,
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
    now: deps.now,
  }));

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

function oracleProbe(
  oracle: OracleClient,
): () => Promise<string | null> {
  return async () => {
    try {
      const obs = await oracle.getLatestPrice("pyth:base:ETH-USD");
      if (!obs?.price) return "no price returned";
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  };
}
