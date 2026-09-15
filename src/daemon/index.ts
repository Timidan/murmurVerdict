import "dotenv/config";
import { openDb } from "../verdict/db-bootstrap.js";
import type { AgentSecurityEventIdAdapter } from "../verdict/agent-security-event.js";
import type { FeedContractIdAdapter } from "../verdict/feed-contract-surface.js";
import type { FeedPacketIdAdapter } from "../verdict/feed-packet-ingestion.js";
import type { FeedSlaIncidentIdAdapter } from "../verdict/feed-sla.js";
import type { OperatorAlertIdAdapter } from "../verdict/operator-alerts.js";
import type {
  PolymarketMarketRegistrationGammaAdapter,
} from "../verdict/polymarket-market-registration.js";
import type { SealedCallIdAdapter } from "../verdict/sealed-call-acceptance.js";
import type { NanopayGatewayFactory } from "../verdict/nanopay-payment-gate.js";
import { VenueTicker } from "../integrations/venue-ticker.js";
import { SCHEMA_VERSION } from "../verdict/schema.js";
import { loadDaemonRuntimeConfig } from "./daemon-config.js";
import { createDaemonHttpSurface } from "./daemon-http.js";
import { createDaemonLifecycle } from "./daemon-lifecycle.js";
import { loadDaemonRuntimeAdapters } from "./daemon-runtime-adapters.js";
import { startDaemonHttpServer } from "./daemon-server.js";
import { startDaemonOpenServLaunchpad } from "./openserv-launchpad-runtime.js";
import { startDaemonPolymarketGammaRuntime } from "./polymarket-gamma-runtime.js";
import { startDaemonTickers } from "./tickers.js";

// receipts subsystem and Filecoin pin callback retired.
// The legacy makePinReceipt() helper that lived here was a no-op for any
// deploy without FILECOIN_API_TOKEN set, and the receipts table it pinned
// canonical JSON for is gone. v3 attested tier will pin EAS attestations
// directly; nothing in v0.2 needs an HTTP-pinning shim.

// ─── Bootstrap ───────────────────────────────────────────────────────────────

export interface DaemonHandle {
  port: number;
  close: () => Promise<void>;
}

export interface DaemonLogger {
  log: (message?: unknown, ...optionalParams: unknown[]) => void;
  warn: (message?: unknown, ...optionalParams: unknown[]) => void;
  error: (message?: unknown, ...optionalParams: unknown[]) => void;
}

export interface DaemonOpts {
  /** Environment source; default process.env */
  env?: NodeJS.ProcessEnv;
  /** Runtime logger; default console */
  logger?: DaemonLogger;
  /** Daemon operation clock; default live wall clock */
  now?: () => Date;
  /** Override DB path; default VERDICT_DB_PATH or ./data/verdict.db */
  dbPath?: string;
  /** Override port; default $PORT or 8080 */
  port?: number;
  /** Skip OpenServ Launchpad agent registration (useful in tests) */
  skipOpenServ?: boolean;
  /** Skip cron tickers (useful in tests; smoke driver still calls .tick() manually) */
  skipTickers?: boolean;
  /** Polymarket Gamma lookup Adapter for admin market registration. */
  marketRegistrationGammaLookup?: PolymarketMarketRegistrationGammaAdapter;
  /** Agent Security Event ID Adapter; default uses random UUIDs inside Agent Security Event. */
  newAgentSecurityEventId?: AgentSecurityEventIdAdapter;
  /** Feed SLA incident ID Adapter; default uses random UUIDs inside Feed SLA. */
  newFeedSlaIncidentId?: FeedSlaIncidentIdAdapter;
  /** Feed Contract ID Adapter; default uses random UUIDs inside Feed Contract Surface. */
  newFeedId?: FeedContractIdAdapter;
  /** Feed Packet ID Adapter; default uses random UUIDs inside packet writers. */
  newFeedPacketId?: FeedPacketIdAdapter;
  /** Operator Alert ID Adapter; default uses random UUIDs when alert keys first open. */
  newOperatorAlertId?: OperatorAlertIdAdapter;
  /** Sealed Call ID Adapter; default uses random UUIDs inside acceptance. */
  newSealedCallId?: SealedCallIdAdapter;
  /** Circle facilitator factory Adapter for the nanopay route; default is the
   *  real SDK facade. Inject a fake to drive an end-to-end paid-inference test
   *  (preflight → verify → settle → replay) through startDaemon. */
  nanopayGatewayFactory?: NanopayGatewayFactory;
}

export async function startDaemon(opts: DaemonOpts = {}): Promise<DaemonHandle> {
  const env = opts.env ?? process.env;
  const logger = opts.logger ?? console;
  const now = opts.now ?? (() => new Date());
  const nowMs = () => now().getTime();
  const config = loadDaemonRuntimeConfig(env, {
    dbPath: opts.dbPath,
    port: opts.port,
  });
  const lifecycle = createDaemonLifecycle();

  try {
    const db = openDb({ path: config.dbPath });
    lifecycle.defer({
      name: "database",
      run: () => {
        db.close();
      },
    });

    const adapters = await loadDaemonRuntimeAdapters({
      config,
      db,
      gatewayFeedPacketId: opts.newFeedPacketId,
      gatewaySealedCallId: opts.newSealedCallId,
      nanopayGatewayFactory: opts.nanopayGatewayFactory,
      env: env,
      logger,
      now,
      schemaVersion: SCHEMA_VERSION,
    });
    lifecycle.defer({ name: "runtime-adapters", run: () => adapters.stop() });

    // Constructed INERT: no socket, no timer, no query until start() below.
    // It has to exist before the HTTP surface so the /v2/venue/* routes can
    // close over its read interface.
    const venueTicker = config.venueTickerEnabled
      ? new VenueTicker({ db, nowMs, logger })
      : null;

    const app = createDaemonHttpSurface({
      db,
      config,
      logger,
      events: adapters.events,
      fhenixVerifier: adapters.fhenixVerifier,
      fhenixGateway: adapters.fhenixGateway,
      entitlementAccess: adapters.entitlementAccess,
      payoutAsset: adapters.payoutAsset,
      privyAuth: adapters.privyAuth,
      liveCanaries: adapters.liveCanaries,
      marketRegistrationGammaLookup: opts.marketRegistrationGammaLookup,
      operatorAlertSink: adapters.operatorAlertSink,
      nanopayRuntime: adapters.nanopayRuntime,
      newAgentSecurityEventId: opts.newAgentSecurityEventId,
      newFeedId: opts.newFeedId,
      newFeedPacketId: opts.newFeedPacketId,
      newFeedSlaIncidentId: opts.newFeedSlaIncidentId,
      newOperatorAlertId: opts.newOperatorAlertId,
      newSealedCallId: opts.newSealedCallId,
      fhenixChainId: adapters.fhenixChainId,
      // The WORKER, not the flag: a configured-but-unbuilt worker is
      // still no reveal guarantee.
      fhenixRevealWorkerEnabled: adapters.fhenixRevealWorker !== null,
      fhenixSealedVerdictsAddress: adapters.fhenixSealedVerdictsAddress,
      fhenixSaleTerms: adapters.fhenixSaleTerms,
      venueTicker,
      now,
    });

    const polymarketRuntime = await startDaemonPolymarketGammaRuntime({
      db,
      enabled: config.polymarketGammaEnabled,
      nowMs,
      skipTickers: opts.skipTickers,
    });
    if (polymarketRuntime) {
      lifecycle.defer({
        name: "polymarket-gamma",
        run: () => polymarketRuntime.stop(),
      });
    }

    const httpServerRuntime = await startDaemonHttpServer(app, config.port);
    lifecycle.defer({ name: "http-server", run: () => httpServerRuntime.close() });

    // Registered AFTER the HTTP server on purpose: shutdown steps run in
    // REVERSE registration order, so this slot yields
    //   tickers → venue ticker → HTTP → gamma → DB.
    // The ticker MUST stop before the HTTP server. `server.close()` waits for
    // open connections to end and never ends them itself, so an open
    // /v2/venue/stream would hold the close promise forever; the ticker's
    // stop() is what ends those responses. It also stops after the general
    // tickers, so nothing is still queuing work into it.
    if (venueTicker) {
      lifecycle.defer({ name: "venue-ticker", run: () => venueTicker.stop() });
    }

    // Sockets and timers only after the server is listening, and never in
    // test mode — smokes must not open a real websocket to Polymarket.
    if (venueTicker && !opts.skipTickers) {
      await venueTicker.start();
    }

    const tickerRuntime = opts.skipTickers
      ? null
      : startDaemonTickers({
          db,
          events: adapters.events,
          now,
          resolver: adapters.resolver,
          fhenixIngestor: adapters.fhenixIngestor,
          fhenixGateway: adapters.fhenixGateway,
          fhenixRevealWorker: adapters.fhenixRevealWorker,
          fhenixGrantReconciler: adapters.fhenixGrantReconciler,
          providerPayoutWorker: adapters.providerPayoutWorker,
          deliverySweep: adapters.deliverySweep,
          polymarketDiscovery: adapters.polymarketDiscovery,
          liveCanaries: adapters.liveCanaries,
          fhenixContractAddress: adapters.fhenixSealedVerdictsAddress,
          newFeedSlaIncidentId: opts.newFeedSlaIncidentId,
          newOperatorAlertId: opts.newOperatorAlertId,
          operatorAlertSink: adapters.operatorAlertSink,
          intervals: config.intervals,
          logger,
        });
    if (tickerRuntime) {
      lifecycle.defer({ name: "tickers", run: () => tickerRuntime.stop() });
    }

    const openServLaunchpadRuntime = await startDaemonOpenServLaunchpad({
      db,
      config: config.openServLaunchpad,
      logger,
      now,
      skip: opts.skipOpenServ,
    });
    if (openServLaunchpadRuntime) {
      lifecycle.defer({
        name: "openserv-launchpad",
        run: () => openServLaunchpadRuntime.stop(),
      });
    }

    logger.log(
      `[daemon] verdict listening on :${httpServerRuntime.port} (resolver=${config.resolverTickSec}s)`,
    );

    if (!config.privyAuth.appId) {
      logger.warn(
        "[daemon] PRIVY_APP_ID/PRIVY_APP_SECRET unset — account sign-in and " +
          "agent onboarding are DISABLED (Privy bearer auth fails closed). " +
          "Public reads still work, but no first user can create an account. " +
          "Set both vars (and VITE_PRIVY_APP_ID in the dashboard build) before launch.",
      );
    }

    return { port: httpServerRuntime.port, close: lifecycle.close };
  } catch (err) {
    try {
      await lifecycle.close();
    } catch (shutdownErr) {
      logger.warn("[daemon] startup cleanup failed:", shutdownErr);
    }

    throw err;
  }
}

// ─── Entry ───────────────────────────────────────────────────────────────────

if (import.meta.url === `file://${process.argv[1]}`) {
  startDaemon().then((handle) => {
    const shutdown = (signal: string) => {
      console.log(`[daemon] received ${signal}, closing…`);
      handle
        .close()
        .then(() => process.exit(0))
        .catch((err) => {
          console.error("[daemon] shutdown failed:", err);
          process.exit(1);
        });
    };
    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT", () => shutdown("SIGINT"));
  });
}
