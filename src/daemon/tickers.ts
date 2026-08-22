import type Database from "better-sqlite3";
import type { LiveCanaryProvider } from "../integrations/live-canaries.js";
import type { VerdictEventBus } from "../verdict/events.js";
import {
  runFeedSlaTick,
  type FeedSlaIncidentIdAdapter,
} from "../verdict/feed-sla.js";
import {
  runOperatorAlertTick,
  type OperatorAlertIdAdapter,
  type OperatorAlertSinkConfig,
} from "../verdict/operator-alerts.js";
import { publicActivityWindow } from "../verdict/public-activity-window.js";

interface Tickable {
  tick(): Promise<unknown>;
}

export interface DaemonTickerIntervals {
  resolverMs: number;
  fhenixEventMs: number;
  fhenixGatewayMs: number;
  fhenixRevealWorkerMs: number;
  fhenixGrantReconcilerMs?: number;
  feedSlaMs: number;
  liveCanaryMs: number;
  operatorAlertMs: number;
  polymarketDiscoveryMs: number;
  statsMs: number;
}

export interface DaemonTickerLogger {
  warn: (message?: unknown, ...optionalParams: unknown[]) => void;
}

export interface DaemonTickersDeps {
  db: Database.Database;
  events: VerdictEventBus;
  now: () => Date;
  resolver: Tickable | null;
  fhenixIngestor: Tickable | null;
  fhenixGateway: Tickable | null;
  fhenixRevealWorker: Tickable | null;
  fhenixGrantReconciler?: Tickable | null;
  polymarketDiscovery: Tickable | null;
  liveCanaries: LiveCanaryProvider;
  /** Contract this deployment runs. Gateway alerts scope to it so a retired
   *  deployment's terminal failures stop re-raising every tick forever. */
  fhenixContractAddress?: string | null;
  newFeedSlaIncidentId?: FeedSlaIncidentIdAdapter;
  newOperatorAlertId?: OperatorAlertIdAdapter;
  operatorAlertSink?: OperatorAlertSinkConfig;
  intervals: DaemonTickerIntervals;
  logger?: DaemonTickerLogger;
}

export interface DaemonTickerRuntime {
  /**
   * Clears all interval timers and awaits any in-flight tick body so
   * that downstream shutdown steps (notably `db.close()`) cannot race a
   * still-running tick that is mid-query.
   */
  stop(): Promise<void>;
}

interface GuardedTicker {
  timer: NodeJS.Timeout;
  settled: () => Promise<unknown>;
}

export function startDaemonTickers(
  deps: DaemonTickersDeps,
): DaemonTickerRuntime {
  const {
    db,
    events,
    now,
    resolver,
    fhenixIngestor,
    fhenixGateway,
    fhenixRevealWorker,
    fhenixGrantReconciler,
    polymarketDiscovery,
    liveCanaries,
    fhenixContractAddress,
    newFeedSlaIncidentId,
    newOperatorAlertId,
    operatorAlertSink,
    intervals,
  } = deps;
  const logger = deps.logger ?? console;
  const tickers: GuardedTicker[] = [];

  // The resolver has no optional dependency left — it settles calls through
  // the venue adapter registry, which needs only the db + clock. `null` is
  // still accepted so a harness can deliberately run without a resolver tick,
  // but the daemon itself always supplies one.
  if (resolver) {
    tickers.push(
      setIntervalGuarded(logger, intervals.resolverMs, "resolver", async () => {
        await resolver.tick();
      }),
    );
  } else {
    logger.warn("[daemon] resolver ticker not started (no resolver supplied)");
  }

  if (fhenixIngestor) {
    tickers.push(
      setIntervalGuarded(logger, intervals.fhenixEventMs, "fhenix-events", async () => {
        await fhenixIngestor.tick();
      }),
    );
  }

  if (fhenixGateway) {
    tickers.push(
      setIntervalGuarded(
        logger,
        intervals.fhenixGatewayMs,
        "fhenix-gateway",
        async () => {
          await fhenixGateway.tick();
        },
      ),
    );
  }

  if (fhenixRevealWorker) {
    // Immediate startup tick: after a restart the reveal EOA must resume any
    // in-flight open/publish jobs (and pick up newly-overdue calls) without
    // waiting a full interval. The overlap guard prevents a slow decrypt tick
    // from stacking, and stop() awaits the in-flight body on shutdown.
    tickers.push(
      setIntervalGuarded(
        logger,
        intervals.fhenixRevealWorkerMs,
        "fhenix-reveal-worker",
        async () => {
          await fhenixRevealWorker.tick();
        },
        { runImmediately: true },
      ),
    );
  }

  if (fhenixGrantReconciler) {
    // Immediate startup tick: after a restart, entitlements left in
    // grant_queued / grant_broadcast / settlement_unknown must resume without
    // waiting a full interval — a subscriber already paid for access.
    tickers.push(
      setIntervalGuarded(
        logger,
        intervals.fhenixGrantReconcilerMs ?? 30_000,
        "fhenix-grant-reconciler",
        async () => {
          await fhenixGrantReconciler.tick();
        },
        { runImmediately: true },
      ),
    );
  }

  if (polymarketDiscovery) {
    // Immediate startup tick: fresh 5-minute windows appear only ~10-30min
    // before their end, so waiting a full interval after a restart can miss
    // a whole boundary.
    tickers.push(
      setIntervalGuarded(
        logger,
        intervals.polymarketDiscoveryMs,
        "polymarket-discovery",
        async () => {
          await polymarketDiscovery.tick();
        },
        { runImmediately: true },
      ),
    );
  }

  tickers.push(
    setIntervalGuarded(logger, intervals.feedSlaMs, "feed-sla", async () => {
      runFeedSlaTick(db, {
        tickedAt: now(),
        newIncidentId: newFeedSlaIncidentId,
      });
    }),
  );

  if (liveCanaries.hasEnabledChecks()) {
    void liveCanaries.runNow().catch((err) => {
      logger.warn("[daemon] live canary startup check failed:", err);
    });
    tickers.push(
      setIntervalGuarded(logger, intervals.liveCanaryMs, "live-canaries", async () => {
        await liveCanaries.runNow();
      }),
    );
  }

  tickers.push(
    setIntervalGuarded(
      logger,
      intervals.operatorAlertMs,
      "operator-alerts",
      async () => {
        await runOperatorAlertTick({
          db,
          now,
          liveCanaries,
          fhenixContractAddress,
          newAlertId: newOperatorAlertId,
          sink: operatorAlertSink,
        });
      },
    ),
  );

  tickers.push(
    setIntervalGuarded(logger, intervals.statsMs, "stats", async () => {
      emitStatsTick(db, events, now());
    }),
  );

  return {
    async stop(): Promise<void> {
      for (const ticker of tickers) {
        clearInterval(ticker.timer);
      }
      await Promise.all(tickers.map((ticker) => ticker.settled()));
    },
  };
}

function emitStatsTick(
  db: Database.Database,
  events: VerdictEventBus,
  servedAt: Date,
): void {
  const activityWindow = publicActivityWindow(servedAt);
  const row = db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM submissions WHERE accepted_at >= ?) AS accepted_24h,
         (SELECT COUNT(*) FROM t1_resolutions WHERE resolved_at >= ?) AS resolved_24h,
         (SELECT COUNT(*) FROM t1_resolutions WHERE resolved_at >= ? AND outcome = 'win')  AS wins_24h,
         (SELECT COUNT(*) FROM t1_resolutions WHERE resolved_at >= ? AND outcome = 'loss') AS losses_24h,
         (SELECT COUNT(*) FROM t1_resolutions WHERE resolved_at >= ? AND outcome IN ('void','oracle_unavailable')) AS void_24h`,
    )
    .get(
      activityWindow.since_iso,
      activityWindow.since_iso,
      activityWindow.since_iso,
      activityWindow.since_iso,
      activityWindow.since_iso,
    ) as {
    accepted_24h: number;
    resolved_24h: number;
    wins_24h: number;
    losses_24h: number;
    void_24h: number;
  };
  events.emit({
    type: "stats.tick",
    served_at: activityWindow.served_at,
    ...row,
  });
}

function setIntervalGuarded(
  logger: DaemonTickerLogger,
  intervalMs: number,
  label: string,
  work: () => Promise<unknown>,
  opts?: { runImmediately?: boolean },
): GuardedTicker {
  let inFlight = false;
  let inFlightPromise: Promise<unknown> = Promise.resolve();
  const run = () => {
    if (inFlight) {
      logger.warn(`[daemon] ${label} tick still in flight - skipping`);
      return;
    }
    inFlight = true;
    inFlightPromise = work()
      .catch((err) => logger.warn(`[daemon] ${label} tick failed:`, err))
      .finally(() => {
        inFlight = false;
      });
  };
  const timer = setInterval(run, intervalMs);
  // Tracked through inFlightPromise so stop() awaits the startup tick too.
  if (opts?.runImmediately) run();
  return { timer, settled: () => inFlightPromise };
}
