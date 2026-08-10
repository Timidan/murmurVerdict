import type Database from "better-sqlite3";

import { createPrivyAuthVerifier, type PrivyAuthVerifier } from "../verdict/auth/privy.js";
import { VerdictEventBus } from "../verdict/events.js";
import { createResolutionFanout } from "../verdict/resolution-fanout.js";
import { Resolver } from "../verdict/resolver.js";
import { startWebhookDispatcher } from "../verdict/webhooks.js";
import type { FhenixEventVerifier } from "../integrations/fhenix-events.js";
import type { FhenixGatewayBroadcaster } from "../integrations/fhenix-gateway.js";
import type { FhenixMarketRegistrar } from "../integrations/fhenix-market-registration.js";
import type { LiveCanaryProvider } from "../integrations/live-canaries.js";
import type { OperatorAlertSinkConfig } from "../verdict/operator-alerts.js";
import type { FeedPacketIdAdapter } from "../verdict/feed-packet-ingestion.js";
import type { SealedCallIdAdapter } from "../verdict/sealed-call-acceptance.js";
import { polymarketDiscoveryRepo } from "../verdict/repos/polymarket-discovery-repo.js";
import { nowIso } from "../verdict/time.js";
import type { DaemonRuntimeConfig } from "./daemon-config.js";
import { loadFhenixRuntime } from "./fhenix-runtime.js";
import {
  loadDaemonNanopayRuntime,
  type DaemonNanopayRuntime,
} from "./nanopay-runtime.js";
import {
  nanopayFacilitatorUrl,
  type NanopayGatewayFactory,
} from "../verdict/nanopay-payment-gate.js";
import { nanopaySettlementRail } from "../verdict/nanopay-config.js";
import { createGatewayMiddleware } from "../integrations/circle-gateway.js";
import {
  createGatewayEntitlementBroker,
  type EntitlementAccessSurfaceDeps,
} from "../verdict/entitlement-access-surface.js";
import {
  loadOperatorObservabilityRuntime,
  loadOperatorObservabilityRuntimeConfig,
} from "./operator-observability-runtime.js";

export interface DaemonRuntimeAdapters {
  events: VerdictEventBus;
  fhenixChainId: number | null;
  fhenixGateway: FhenixGatewayBroadcaster | null;
  fhenixIngestor: { tick: () => Promise<unknown> } | null;
  fhenixRevealWorker: { tick: () => Promise<unknown> } | null;
  /** Flow 2 grant reconciler ticker; null unless the grant runtime + its
   *  reconciler are enabled. */
  fhenixGrantReconciler: { tick: () => Promise<unknown> } | null;
  /** Flow 2 paid decrypt-access HTTP surface deps; null unless the grant
   *  runtime is enabled AND nanopay payment infra is mounted. */
  entitlementAccess: EntitlementAccessSurfaceDeps | null;
  fhenixSealedVerdictsAddress: string | null;
  fhenixVerifier: FhenixEventVerifier | null;
  liveCanaries: LiveCanaryProvider;
  nanopayRuntime: DaemonNanopayRuntime | null;
  operatorAlertSink: OperatorAlertSinkConfig;
  polymarketDiscovery: { tick: () => Promise<unknown> } | null;
  privyAuth: PrivyAuthVerifier;
  /** Never null — see the construction site in loadDaemonRuntimeAdapters. */
  resolver: Resolver;
  stop(): void;
}

export interface LoadDaemonRuntimeAdaptersDeps {
  config: DaemonRuntimeConfig;
  db: Database.Database;
  /**
   * The daemon's injected environment. Every runtime that reads env directly
   * must take it from HERE, not from ambient process.env — startDaemon({env})
   * exists so a deployment's configuration is the one that applies. It used to
   * be named `liveCanaryEnv` after its first consumer, and the grant runtime's
   * refund acknowledgement read the ambient process instead.
   */
  env: NodeJS.ProcessEnv;
  gatewayFeedPacketId?: FeedPacketIdAdapter;
  gatewaySealedCallId?: SealedCallIdAdapter;
  /** Circle facilitator factory Adapter for the nanopay route; defaults to
   *  the real SDK facade. Injected here so a full-daemon paid-inference test
   *  can drive preflight → verify → settle → replay against a fake. */
  nanopayGatewayFactory?: NanopayGatewayFactory;
  logger?: Pick<Console, "log" | "warn">;
  now: () => Date;
  schemaVersion: number;
}

async function loadPolymarketDiscoveryEngine(deps: {
  db: Database.Database;
  config: DaemonRuntimeConfig;
  marketRegistrar: FhenixMarketRegistrar | null;
  logger: Pick<Console, "log" | "warn">;
  now: () => Date;
}): Promise<{ tick: () => Promise<unknown> } | null> {
  const discovery = deps.config.polymarketDiscovery;
  if (!discovery.enabled) {
    // A health row left enabled by a previous run would keep the stale-tick
    // alert firing forever once the operator turns discovery off.
    polymarketDiscoveryRepo.markDisabled(deps.db, nowIso(deps.now()));
    return null;
  }
  // Config load already fails closed on these, but the runtime seam is the
  // last line before owner-key writes — refuse rather than run degraded.
  if (!deps.marketRegistrar) {
    throw new Error(
      "polymarket discovery enabled but the Fhenix gateway market registrar is unavailable",
    );
  }
  const chainId = deps.config.fhenixRuntime.chainId;
  if (chainId === null) {
    throw new Error(
      "polymarket discovery enabled but FHENIX_CHAIN_ID is unresolved",
    );
  }
  const { PolymarketGammaClient } = await import(
    "../markets/polymarket-gamma/client.js"
  );
  const { PolymarketDiscoveryEngine } = await import(
    "../markets/polymarket-gamma/discovery.js"
  );
  return new PolymarketDiscoveryEngine({
    db: deps.db,
    registrar: deps.marketRegistrar,
    gamma: new PolymarketGammaClient({ nowMs: () => deps.now().getTime() }),
    config: {
      chainId,
      tickSec: discovery.tickSec,
      lookaheadMin: discovery.lookaheadMin,
      minLeadSec: discovery.minLeadSec,
      questionFilter: discovery.questionFilter,
      assets: discovery.assets,
      windowDurationSec: discovery.windowDurationSec,
      seriesClock: discovery.seriesClock,
      maxArmedPerCall: discovery.maxArmedPerCall,
      seriesVersion: discovery.seriesVersion,
      maxPerTick: discovery.maxPerTick,
      maxPerHour: discovery.maxPerHour,
      maxPerDay: discovery.maxPerDay,
      minBalanceWei: discovery.minBalanceWei,
      warnBalanceWei: discovery.warnBalanceWei,
      maxRegisterCostWei: discovery.maxRegisterCostWei,
    },
    now: deps.now,
    logger: deps.logger,
  });
}

export async function loadDaemonRuntimeAdapters(
  deps: LoadDaemonRuntimeAdaptersDeps,
): Promise<DaemonRuntimeAdapters> {
  const { config, db, schemaVersion } = deps;
  const env = deps.env;
  const logger = deps.logger ?? console;
  const now = deps.now;
  const privyAuth = createPrivyAuthVerifier(config.privyAuth);
  const events = new VerdictEventBus();

  const fhenixRuntime = await loadFhenixRuntime(db, {
    config: config.fhenixRuntime,
    env,
    gatewayFeedPacketId: deps.gatewayFeedPacketId,
    gatewaySealedCallId: deps.gatewaySealedCallId,
    logger,
    now,
  });
  const fhenixChainId = fhenixRuntime.chainId;
  const fhenixSealedVerdictsAddress = fhenixRuntime.sealedVerdictsAddress;
  const nanopayRuntime = loadDaemonNanopayRuntime({
    db,
    config: config.nanopayRuntime,
    logger,
    now,
    gatewayFactory: deps.nanopayGatewayFactory,
  });
  const webhookDispatcher = startWebhookDispatcher(db, events, {
    now,
    urlPolicy: config.webhookUrlPolicy,
  });
  const observability = loadOperatorObservabilityRuntime(db, schemaVersion, {
    config: loadOperatorObservabilityRuntimeConfig(db, schemaVersion, env, {
      fhenixSealedVerdictsAddress,
      now,
      operatorAlertSink: config.operatorAlertSink,
      polymarketGammaEnabled: config.polymarketGammaEnabled,
    }),
    now,
  });
  const polymarketDiscovery = await loadPolymarketDiscoveryEngine({
    db,
    config,
    marketRegistrar: fhenixRuntime.marketRegistrar,
    logger,
    now,
  });
  // The Resolver is constructed UNCONDITIONALLY.
  //
  // It used to be gated on the price-oracle runtime having produced a
  // Chainlink/Pyth client, which meant a deployment without Base RPC / feed
  // env silently resolved NOTHING — including the Polymarket calls that have
  // never needed a price oracle at all. Murmur is a pure referee over external
  // venues now: resolution is `adapter.observeResolution(...)` and its only
  // dependencies are the database and a clock, both of which always exist by
  // this point. There is no configuration under which the resolver should be
  // absent. Pinned by src/daemon/daemon-runtime-adapters.smoke.ts (resolver is
  // constructed and tickable with zero oracle configuration) and exercised
  // end-to-end by src/verdict/fhenix-api.smoke.ts.
  const resolver = new Resolver({
    db,
    now,
    onResolved: createResolutionFanout({
      db,
      events,
      now,
    }),
  });

  // Flow 2 access surface: build the payment broker over the SAME settlement
  // RAIL as nanopay (seller, facilitator, accepted networks) but a dedicated
  // flat access price, and bind it to the grant runtime's chain adapter.
  //
  // Requires the rail, NOT the inference route. It used to require
  // `kind === "mounted"`, which made the documented grant-only deployment —
  // grants enabled, no inference price — return 503 PaidAccessDisabled on
  // every access request: the one feature it was configured to sell.
  const rail = nanopaySettlementRail(config.nanopayRuntime);
  let entitlementAccess: EntitlementAccessSurfaceDeps | null = null;
  if (fhenixRuntime.grant && fhenixRuntime.grantAccess && rail) {
    const np = rail;
    const gatewayFactory = deps.nanopayGatewayFactory ?? createGatewayMiddleware;
    const middleware = gatewayFactory({
      sellerAddress: np.sellerAddress,
      networks: np.acceptNetworks,
      facilitatorUrl: nanopayFacilitatorUrl(np.network),
      description: "Murmur early private decrypt access",
    });
    const network =
      np.acceptNetworks?.[0] ??
      (np.network === "mainnet" ? "eip155:8453" : "eip155:84532");
    entitlementAccess = {
      access: fhenixRuntime.grantAccess,
      broker: createGatewayEntitlementBroker({
        db,
        now,
        gateway: middleware,
        network,
        sellerAddress: np.sellerAddress,
        currency: fhenixRuntime.grant.currency,
      }),
      priceAtoms: fhenixRuntime.grant.priceAtoms,
      currency: fhenixRuntime.grant.currency,
      pricingVersion: fhenixRuntime.grant.pricingVersion,
    };
  }

  let stopped = false;

  return {
    events,
    fhenixChainId,
    fhenixGateway: fhenixRuntime.gateway,
    fhenixIngestor: fhenixRuntime.ingestor,
    fhenixRevealWorker: fhenixRuntime.revealWorker,
    fhenixGrantReconciler: fhenixRuntime.grantReconciler,
    entitlementAccess,
    fhenixSealedVerdictsAddress,
    fhenixVerifier: fhenixRuntime.verifier,
    liveCanaries: observability.liveCanaries,
    nanopayRuntime,
    operatorAlertSink: observability.operatorAlertSink,
    polymarketDiscovery,
    privyAuth,
    resolver,
    stop(): void {
      if (stopped) return;
      stopped = true;
      webhookDispatcher.stop();
    },
  };
}
