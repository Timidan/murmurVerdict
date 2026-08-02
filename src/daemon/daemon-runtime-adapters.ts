import type Database from "better-sqlite3";

import { createPrivyAuthVerifier, type PrivyAuthVerifier } from "../verdict/auth/privy.js";
import { VerdictEventBus } from "../verdict/events.js";
import { createResolutionFanout } from "../verdict/resolution-fanout.js";
import { Resolver } from "../verdict/resolver.js";
import { startWebhookDispatcher } from "../verdict/webhooks.js";
import type { FhenixEventVerifier } from "../integrations/fhenix-events.js";
import type { FhenixGatewayBroadcaster } from "../integrations/fhenix-gateway.js";
import type { FhenixMarketRegistrar } from "../integrations/fhenix-market-registration.js";
import type { OracleClient } from "../integrations/oracle.js";
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
import { createGatewayMiddleware } from "../integrations/circle-gateway.js";
import {
  createGatewayEntitlementBroker,
  type EntitlementAccessSurfaceDeps,
} from "../verdict/entitlement-access-surface.js";
import {
  loadDaemonOracleRuntime,
} from "./oracle-runtime.js";
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
  oracle: OracleClient | null;
  polymarketDiscovery: { tick: () => Promise<unknown> } | null;
  privyAuth: PrivyAuthVerifier;
  resolver: Resolver | null;
  stop(): void;
}

export interface LoadDaemonRuntimeAdaptersDeps {
  config: DaemonRuntimeConfig;
  db: Database.Database;
  liveCanaryEnv: NodeJS.ProcessEnv;
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
  const liveCanaryEnv = deps.liveCanaryEnv;
  const logger = deps.logger ?? console;
  const now = deps.now;
  const privyAuth = createPrivyAuthVerifier(config.privyAuth);
  const events = new VerdictEventBus();

  const oracleRuntime = loadDaemonOracleRuntime({
    config: config.oracleRuntime,
    logger,
    now,
  });
  const fhenixRuntime = await loadFhenixRuntime(db, {
    config: config.fhenixRuntime,
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
    config: loadOperatorObservabilityRuntimeConfig(db, schemaVersion, liveCanaryEnv, {
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
  const resolver = oracleRuntime.oracle
    ? new Resolver({
        db,
        oracle: oracleRuntime.oracle,
        now,
        onResolved: createResolutionFanout({
          db,
          events,
          now,
        }),
      })
    : null;

  // Flow 2 access surface: build the payment broker over the SAME nanopay
  // payment infra (seller, facilitator, accepted networks) but a dedicated flat
  // access price, and bind it to the grant runtime's chain adapter. Only when
  // the grant runtime is enabled AND nanopay is mounted — otherwise the access
  // routes stay unmounted (the durable reconciler still runs if enabled).
  let entitlementAccess: EntitlementAccessSurfaceDeps | null = null;
  if (
    fhenixRuntime.grant &&
    fhenixRuntime.grantAccess &&
    config.nanopayRuntime.kind === "mounted"
  ) {
    const np = config.nanopayRuntime.config;
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
    oracle: oracleRuntime.oracle,
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
