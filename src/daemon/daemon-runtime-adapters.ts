import type Database from "better-sqlite3";

import { createPrivyAuthVerifier, type PrivyAuthVerifier } from "../verdict/auth/privy.js";
import { VerdictEventBus } from "../verdict/events.js";
import { createResolutionFanout } from "../verdict/resolution-fanout.js";
import { Resolver } from "../verdict/resolver.js";
import { startWebhookDispatcher } from "../verdict/webhooks.js";
import type { FhenixEventVerifier } from "../integrations/fhenix-events.js";
import type { FhenixGatewayBroadcaster } from "../integrations/fhenix-gateway.js";
import type { OracleClient } from "../integrations/oracle.js";
import type { LiveCanaryProvider } from "../integrations/live-canaries.js";
import type { OperatorAlertSinkConfig } from "../verdict/operator-alerts.js";
import type { FeedPacketIdAdapter } from "../verdict/feed-packet-ingestion.js";
import type { SealedCallIdAdapter } from "../verdict/sealed-call-acceptance.js";
import type { DaemonRuntimeConfig } from "./daemon-config.js";
import { loadFhenixRuntime } from "./fhenix-runtime.js";
import {
  loadDaemonNanopayRuntime,
  type DaemonNanopayRuntime,
} from "./nanopay-runtime.js";
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
  fhenixSealedVerdictsAddress: string | null;
  fhenixVerifier: FhenixEventVerifier | null;
  liveCanaries: LiveCanaryProvider;
  nanopayRuntime: DaemonNanopayRuntime | null;
  operatorAlertSink: OperatorAlertSinkConfig;
  oracle: OracleClient | null;
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
  logger?: Pick<Console, "log" | "warn">;
  now: () => Date;
  schemaVersion: number;
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
  });
  const webhookDispatcher = startWebhookDispatcher(db, events, {
    now,
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

  let stopped = false;

  return {
    events,
    fhenixChainId,
    fhenixGateway: fhenixRuntime.gateway,
    fhenixIngestor: fhenixRuntime.ingestor,
    fhenixSealedVerdictsAddress,
    fhenixVerifier: fhenixRuntime.verifier,
    liveCanaries: observability.liveCanaries,
    nanopayRuntime,
    operatorAlertSink: observability.operatorAlertSink,
    oracle: oracleRuntime.oracle,
    privyAuth,
    resolver,
    stop(): void {
      if (stopped) return;
      stopped = true;
      webhookDispatcher.stop();
    },
  };
}
