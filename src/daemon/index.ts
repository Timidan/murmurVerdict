import "dotenv/config";
import express from "express";
import cors from "cors";
import { OracleClient } from "../integrations/oracle.js";
import { Resolver } from "../verdict/resolver.js";
import { createVerdictRouter } from "../verdict/api.js";
import { accountRouter } from "../verdict/routes/account.js";
import { nanopayRouter, type PipelineInfo } from "../verdict/routes/nanopay.js";
import type { FhenixAnchorTuple } from "../verdict/single-stream-binding.js";
import { agentsRepo, openDb, resolutionsRepo } from "../verdict/db.js";
import { VerdictEventBus } from "../verdict/events.js";
import { runFeedSlaTick } from "../verdict/feed-sla.js";
import { getLeaderboard } from "../verdict/leaderboard.js";
import {
  operatorAlertSinkFromEnv,
  runOperatorAlertTick,
} from "../verdict/operator-alerts.js";
import { startWebhookDispatcher } from "../verdict/webhooks.js";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Server } from "node:http";
import { createFhenixEventVerifierFromEnv } from "../integrations/fhenix-events.js";
import { loadDeployment, resolveFhenixContractAddress } from "../integrations/deployments.js";
import { createLiveCanaryRunnerFromEnv } from "../integrations/live-canaries.js";
import { SCHEMA_VERSION } from "../verdict/schema.js";

// ─── Env knobs ──────────────────────────────────────────────────────────────

const PORT = Number(process.env.PORT ?? 8080);
const RESOLVER_TICK_SEC = Number(process.env.RESOLVER_TICK_SEC ?? 30);
const FHENIX_EVENT_TICK_SEC = Number(process.env.FHENIX_EVENT_TICK_SEC ?? RESOLVER_TICK_SEC);
const FHENIX_GATEWAY_TICK_SEC = Number(process.env.FHENIX_GATEWAY_TICK_SEC ?? 10);
const FEED_SLA_TICK_SEC = Number(process.env.FEED_SLA_TICK_SEC ?? 60);
const LIVE_CANARY_TICK_SEC = Number(process.env.LIVE_CANARY_TICK_SEC ?? 300);
const OPERATOR_ALERT_TICK_SEC = Number(process.env.OPERATOR_ALERT_TICK_SEC ?? 60);
const VERDICT_DB_PATH = process.env.VERDICT_DB_PATH ?? "./data/verdict.db";
const DASHBOARD_ORIGIN = (process.env.DASHBOARD_ORIGIN ?? "*").trim();

// Wave 4b — receipts subsystem and Filecoin pin callback retired.
// The legacy makePinReceipt() helper that lived here was a no-op for any
// deploy without FILECOIN_API_TOKEN set, and the receipts table it pinned
// canonical JSON for is gone. v3 attested tier will pin EAS attestations
// directly; nothing in v0.2 needs an HTTP-pinning shim.

// ─── Bootstrap ───────────────────────────────────────────────────────────────

export interface DaemonHandle {
  port: number;
  close: () => Promise<void>;
}

export interface DaemonOpts {
  /** Override DB path; default VERDICT_DB_PATH or ./data/verdict.db */
  dbPath?: string;
  /** Override port; default $PORT or 8080 */
  port?: number;
  /** Skip OpenServ Launchpad agent registration (useful in tests) */
  skipOpenServ?: boolean;
  /** Skip cron tickers (useful in tests; smoke driver still calls .tick() manually) */
  skipTickers?: boolean;
}

export async function startDaemon(opts: DaemonOpts = {}): Promise<DaemonHandle> {
  const dbPath = opts.dbPath ?? VERDICT_DB_PATH;
  const port = opts.port ?? PORT;

  ensureParentDir(dbPath);
  const db = openDb({ path: dbPath });

  // Wave 4b-2 — MarketContextProvider (Santiment scout/analyst) removed.
  // Murmur is a pure ranking layer over canonical price/event oracles;
  // no sentiment cache or 5-minute refresh tick.
  const oracle = makeOracle();
  const events = new VerdictEventBus();
  const fhenixVerifier = createFhenixEventVerifierFromEnv();
  let fhenixIngestor: { tick: () => Promise<unknown> } | null = null;
  let fhenixGateway: import("../integrations/fhenix-gateway.js").FhenixGatewayBroadcaster | null = null;
  if (fhenixVerifier) {
    const { createFhenixEventIngestorFromEnv } = await import(
      "../integrations/fhenix-watcher.js"
    );
    fhenixIngestor = createFhenixEventIngestorFromEnv(db, fhenixVerifier);
    const { createFhenixGatewayFromEnv } = await import(
      "../integrations/fhenix-gateway.js"
    );
    fhenixGateway = createFhenixGatewayFromEnv(db, fhenixVerifier);
    if (!fhenixIngestor && process.env.FHENIX_RPC_URL) {
      console.warn(
        "[daemon] Fhenix verifier is configured, but event watcher is disabled; set FHENIX_CHAIN_ID and either FHENIX_SEALED_VERDICTS_ADDRESS or run sync-deployments to index reveals",
      );
    }
  }
  const fhenixChainId = Number(process.env.FHENIX_CHAIN_ID ?? "0") || null;
  const fhenixSealedVerdictsAddress =
    resolveFhenixContractAddress(fhenixChainId ?? undefined);
  const fhenixEscrowAddress =
    process.env.FHENIX_ESCROW_ADDRESS?.trim() ||
    (fhenixChainId ? loadDeployment(fhenixChainId, "MurmurEscrow")?.address : null) ||
    null;
  console.log(
    "[daemon] Fhenix config:",
    JSON.stringify({
      chainId: fhenixChainId,
      sealedVerdictsAddress: fhenixSealedVerdictsAddress,
      escrowAddress: fhenixEscrowAddress,
      gatewayEnabled: (process.env.FHENIX_GATEWAY_ENABLED ?? "false").toLowerCase() === "true",
      verifierActive: Boolean(fhenixVerifier),
      ingestorActive: Boolean(fhenixIngestor),
      gatewayActive: Boolean(fhenixGateway),
    }),
  );
  // Webhooks fan-out: subscribes once and dispatches HTTP POST to every
  // matching subscription on call.accepted / call.resolved.
  const webhookDispatcher = startWebhookDispatcher(db, events);
  const liveCanaries = createLiveCanaryRunnerFromEnv(db, SCHEMA_VERSION);
  const operatorAlertSink = operatorAlertSinkFromEnv();
  const resolver = oracle
    ? new Resolver({
        db,
        oracle,
        onResolved: async (call_id) => {
          // 1. Fan out to SSE subscribers
          try {
            const full = resolutionsRepo.loadFullCall(db, call_id);
            const agent = full ? agentsRepo.byId(db, full.submission.agent_id) : null;
            if (full?.resolution && agent) {
              // Phase 5 — surface universal payout-vector additive fields
              // when the resolver dispatched through an adapter. Subscribers
              // that read only legacy fields (outcome / call_score) keep
              // working unchanged; v2 clients can read resolved_outcome /
              // payout_vector for the universal shape.
              const resolvedOutcome = full.resolution.resolved_outcome_json
                ? (JSON.parse(full.resolution.resolved_outcome_json) as unknown)
                : undefined;
              const payoutVector = full.resolution.payout_vector_json
                ? (JSON.parse(
                    full.resolution.payout_vector_json,
                  ) as string[])
                : undefined;
              // Phase 10 / Z4-extra Drift C — read the adapter/family
              // off the submission so non-native resolutions (Polymarket,
              // future event-binary adapters) don't emit a meaningless
              // signed_return on the SSE channel. Native-price defaults
              // when the columns are null (pre-MIGRATION_016 legacy rows).
              const adapterRow = db
                .prepare(
                  "SELECT adapter_id, market_family, market_id FROM submissions WHERE call_id = ?",
                )
                .get(call_id) as
                | {
                    adapter_id: string | null;
                    market_family: string | null;
                    market_id: string | null;
                  }
                | undefined;
              const adapterId = adapterRow?.adapter_id ?? "native-price";
              const marketFamily =
                adapterRow?.market_family ?? "financial-direction";
              const isNativePrice = adapterId === "native-price";
              events.emit({
                type: "call.resolved",
                call_id,
                agent_id: agent.agent_id,
                agent_slug: agent.display_slug,
                outcome: full.resolution.outcome,
                // signed_return is a price-return concept — emit ONLY for
                // native-price adapters. Polymarket and other event/
                // category families omit the field entirely (Drift C).
                ...(isNativePrice
                  ? { signed_return: full.resolution.signed_return }
                  : {}),
                call_score: full.resolution.call_score ?? null,
                resolved_at: full.resolution.resolved_at,
                adapter_id: adapterId,
                market_family: marketFamily,
                ...(adapterRow?.market_id
                  ? { market_id: adapterRow.market_id }
                  : {}),
                ...(resolvedOutcome !== undefined
                  ? { resolved_outcome: resolvedOutcome }
                  : {}),
                ...(payoutVector !== undefined
                  ? { payout_vector: payoutVector }
                  : {}),
              });
              // Resolution typically reorders the leaderboard — push new top.
              const rows = getLeaderboard(db, { limit: 20 });
              events.emit({
                type: "leaderboard.update",
                served_at: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
                rows: rows.map((r) => ({
                  rank: r.rank,
                  agent_id: r.agent_id,
                  display_slug: r.display_slug,
                  display_name: r.display_name,
                  kind: r.kind,
                  verdict_score: r.verdict_score,
                  win_rate: r.win_rate,
                  resolved_calls: r.resolved_calls,
                  pending_calls: r.pending_calls,
                })),
              });
              // Phase 3b follow-up B: per-market delta. Scoped to the call's
              // market_id so MarketsMatrix cards refresh without a poll.
              // Legacy rows without market_id (pre-migration 009) skip this —
              // there's no market surface to update for them.
              const marketRow = db
                .prepare(
                  "SELECT market_id FROM submissions WHERE call_id = ?",
                )
                .get(call_id) as { market_id: string | null } | undefined;
              if (marketRow?.market_id) {
                events.emitMarketsUpdate(db, marketRow.market_id);
              }
            }
          } catch (err) {
            console.warn(`[daemon] sse fan-out failed for ${call_id}:`, err);
          }
          // SSE remains the canonical fan-out; subscribers route their own
          // Discord/Zapier/OpenServ/custom bridges through webhooks.
        },
      })
    : null;
  const app = express();
  // Phase 4 Hardening B — trust the first reverse-proxy hop. The casual
  // tier (V2 §7.1) lives behind express-rate-limit's IP-keyed buckets
  // (see src/verdict/routes/account.ts); without trust-proxy, req.ip
  // collapses to the LB's address and a single IPv4 floods every bucket.
  // Set to 1 (a single hop) rather than `true` (which is permissive about
  // X-Forwarded-For spoofing) — Render / Fly / Railway all sit on a
  // single proxy hop.
  app.set("trust proxy", 1);
  if (DASHBOARD_ORIGIN === "*") {
    app.use(cors());
  } else {
    app.use(
      cors({
        origin: DASHBOARD_ORIGIN.split(",").map((s) => s.trim()).filter(Boolean),
        credentials: true,
      }),
    );
  }
  app.use(
    createVerdictRouter({
      db,
      events,
      oracleProbe: oracle
        ? async () => {
            try {
              const obs = await oracle.getLatestPrice("pyth:base:ETH-USD");
              if (!obs?.price) return "no price returned";
              return null;
            } catch (err) {
              return err instanceof Error ? err.message : String(err);
            }
          }
        : undefined,
      fhenixVerifier,
      fhenixGateway,
      liveCanaries,
      requireLiveCanaries: process.env.MURMUR_REQUIRE_LIVE_CANARIES === "true",
      operatorAlertSink,
    }),
  );

  // Phase 4 — mount the account router (V2 §7.1 casual tier). Routes:
  //   POST   /v1/account/session                          Privy → account
  //   POST   /v1/account/agents                           create casual agent
  //   GET    /v1/account/agents                           list owned agents
  //   POST   /v1/account/agents/:slug/api-keys            mint scoped key
  //   DELETE /v1/account/api-keys/:key_id                 rotate (soft delete)
  //   PATCH  /v1/account/agents/:slug/destination-address §7.4 cooldown
  //
  // Each route ships with its own express-rate-limit middleware (in-process
  // MemoryStore — single-instance; multi-replica requires Redis-backed
  // store, tracked in scaling research §6). Mounted after the verdict router;
  // `/v1/account/*` is a fresh path prefix with no collision.
  app.use(accountRouter({ db }));

  // Wave L.A Phase 1 — Nanopayments via Circle Gateway middleware.
  // Mounts `POST /v2/nanopay/infer/:pipelineId`. Wire-format details
  // (x402 V2 headers, EIP-3009 sig recovery, Circle /settle call) are
  // handled by `@circle-fin/x402-batching/server`'s middleware; Murmur
  // owns the pipeline catalog, sealed-Fhenix anchor lookup, receipt
  // persistence, and single-stream binding response.
  //
  // Phase 1 testnet MVP: `resolvePipeline` + `resolveLatestSealedCall`
  // ship as stubs (return null) until Phase 2 wires them to real
  // catalogs. With stubs the route returns 404/503 — safe (no
  // free-serve), but it does ALREADY settle the buyer's payment via
  // the SDK middleware before reaching the stub. Operator must wire
  // real resolvers before promoting beyond local-smoke testing.
  //
  // Env config:
  //   MURMUR_NANOPAY_ENABLED=true              — enables the route mount
  //   MURMUR_NANOPAY_NETWORK                   — "testnet" (default) | "mainnet"
  //   MURMUR_NANOPAY_SELLER_ADDRESS            — seller wallet that receives
  //                                              Nanopayments (required)
  //   MURMUR_NANOPAY_DOMAIN_CHAIN_ID           — chainId for the EIP-712
  //                                              requestSignalId domain
  //                                              (defaults to FHENIX_CHAIN_ID)
  //   MURMUR_NANOPAY_DOMAIN_CONTRACT           — sealed-verdicts contract addr
  //                                              for the EIP-712 verifyingContract
  //                                              (defaults to FHENIX_SEALED_VERDICTS_ADDRESS)
  //   MURMUR_NANOPAY_DEFAULT_PRICE             — default per-call price string,
  //                                              e.g. "$0.001". (Phase 2 will
  //                                              switch to per-pipeline pricing.)
  //   MURMUR_NANOPAY_ACCEPT_NETWORKS           — optional comma-separated
  //                                              CAIP-2 network restrictions
  //                                              (default: all Gateway-supported)
  //
  // Design note:
  //   docs/superpowers/specs/2026-05-23-wave-l-a-nanopayments-design.md
  if ((process.env.MURMUR_NANOPAY_ENABLED ?? "false").toLowerCase() === "true") {
    const domainChainId = Number(
      process.env.MURMUR_NANOPAY_DOMAIN_CHAIN_ID ??
        process.env.FHENIX_CHAIN_ID ??
        "0",
    );
    const domainContract =
      process.env.MURMUR_NANOPAY_DOMAIN_CONTRACT ??
      fhenixSealedVerdictsAddress ??
      "";
    const sellerAddress = process.env.MURMUR_NANOPAY_SELLER_ADDRESS ?? "";
    if (!domainChainId || !domainContract || !sellerAddress) {
      console.warn(
        "[daemon] MURMUR_NANOPAY_ENABLED=true but required config missing (need MURMUR_NANOPAY_SELLER_ADDRESS + domain chainId + domain contract); nanopay route NOT mounted",
      );
    } else if (!/^0x[0-9a-fA-F]{40}$/.test(sellerAddress)) {
      console.warn(
        `[daemon] MURMUR_NANOPAY_SELLER_ADDRESS not a valid 0x address (got ${sellerAddress}); nanopay route NOT mounted`,
      );
    } else if (!/^0x[0-9a-fA-F]{40}$/.test(domainContract)) {
      console.warn(
        `[daemon] MURMUR_NANOPAY_DOMAIN_CONTRACT not a valid 0x address (got ${domainContract}); nanopay route NOT mounted`,
      );
    } else {
      const network =
        (process.env.MURMUR_NANOPAY_NETWORK ?? "testnet").toLowerCase() === "mainnet"
          ? "mainnet"
          : "testnet";
      const defaultPrice = process.env.MURMUR_NANOPAY_DEFAULT_PRICE ?? "$0.001";
      const acceptNetworks = process.env.MURMUR_NANOPAY_ACCEPT_NETWORKS
        ? process.env.MURMUR_NANOPAY_ACCEPT_NETWORKS.split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : undefined;

      // express.json() so handlers can read req.body if any future
      // path needs it. The SDK middleware does not require a body
      // parser (the PAYMENT-SIGNATURE comes via headers), but
      // mounting it broadly is the safe default.
      app.use("/v2/nanopay", express.json({ limit: "16kb" }));

      app.use(
        nanopayRouter({
          db,
          network,
          bindingDomain: {
            chainId: domainChainId,
            verifyingContract: domainContract as `0x${string}`,
          },
          sellerAddress: sellerAddress as `0x${string}`,
          defaultPrice,
          acceptNetworks,
          // Phase 1 stubs — Phase 2 will wire real lookups.
          resolvePipeline: (_pipelineId: string): PipelineInfo | null => null,
          resolveLatestSealedCall: (
            _pipelineId: string,
          ): { anchor: FhenixAnchorTuple; revealArtifact: unknown | null } | null =>
            null,
        }),
      );
      console.log(
        `[daemon] Nanopayments route mounted on POST /v2/nanopay/infer/:pipelineId (network=${network}, seller=${sellerAddress}, price=${defaultPrice})`,
      );
    }
  }

  // Polymarket Gamma adapter registration happens in the market-maker
  // registry at module load. The optional ticker only pre-warms/syncs Gamma
  // rows; the resolver can still observe a listed conditionId directly.
  let polymarketStop: (() => void) | null = null;
  if (process.env.MURMUR_POLYMARKET_GAMMA_ENABLED === "1") {
    const { registerPolymarketGammaAdapter } = await import(
      "../markets/polymarket-gamma/register.js"
    );
    const handle = registerPolymarketGammaAdapter(
      opts.skipTickers ? {} : { db },
    );
    polymarketStop = handle.stop;
  }

  const server: Server = await new Promise((resolve, reject) => {
    const s = app.listen(port, () => resolve(s));
    s.once("error", reject);
  });
  const addr = server.address();
  const actualPort =
    typeof addr === "object" && addr !== null ? addr.port : port;

  // Cron tickers — every ticker is wrapped in an in-flight guard so a slow
  // oracle or event-indexing run never overlaps with the next tick.
  const tickers: NodeJS.Timeout[] = [];
  if (!opts.skipTickers) {
    if (resolver) {
      tickers.push(
        setIntervalGuarded(RESOLVER_TICK_SEC * 1000, "resolver", async () => {
          await resolver.tick();
        }),
      );
    } else {
      console.warn(
        "[daemon] resolver disabled — set BASE_MAINNET_RPC_URL to enable",
      );
    }
    if (fhenixIngestor) {
      tickers.push(
        setIntervalGuarded(FHENIX_EVENT_TICK_SEC * 1000, "fhenix-events", async () => {
          await fhenixIngestor.tick();
        }),
      );
    }
    if (fhenixGateway) {
      tickers.push(
        setIntervalGuarded(FHENIX_GATEWAY_TICK_SEC * 1000, "fhenix-gateway", async () => {
          await fhenixGateway.tick();
        }),
      );
    }
    tickers.push(
      setIntervalGuarded(FEED_SLA_TICK_SEC * 1000, "feed-sla", async () => {
        runFeedSlaTick(db);
      }),
    );
    if (liveCanaries.hasEnabledChecks()) {
      void liveCanaries.runNow().catch((err) => {
        console.warn("[daemon] live canary startup check failed:", err);
      });
      tickers.push(
        setIntervalGuarded(LIVE_CANARY_TICK_SEC * 1000, "live-canaries", async () => {
          await liveCanaries.runNow();
        }),
      );
    }
    tickers.push(
      setIntervalGuarded(OPERATOR_ALERT_TICK_SEC * 1000, "operator-alerts", async () => {
        await runOperatorAlertTick({
          db,
          liveCanaries,
          sink: operatorAlertSink,
        });
      }),
    );
    // Stats heartbeat — emits a `stats.tick` every 10s so the landing-page
    // hero counter stays current even when no calls flow through. Cheap:
    // single COUNT-with-WHERE query; no oracle calls.
    tickers.push(
      setIntervalGuarded(10_000, "stats", async () => {
        const since = new Date(Date.now() - 24 * 60 * 60 * 1000)
          .toISOString()
          .replace(/\.\d+Z$/, "Z");
        const row = db
          .prepare(
            `SELECT
               (SELECT COUNT(*) FROM submissions WHERE accepted_at >= ?) AS accepted_24h,
               (SELECT COUNT(*) FROM t1_resolutions WHERE resolved_at >= ?) AS resolved_24h,
               (SELECT COUNT(*) FROM t1_resolutions WHERE resolved_at >= ? AND outcome = 'win')  AS wins_24h,
               (SELECT COUNT(*) FROM t1_resolutions WHERE resolved_at >= ? AND outcome = 'loss') AS losses_24h,
               (SELECT COUNT(*) FROM t1_resolutions WHERE resolved_at >= ? AND outcome IN ('void','oracle_unavailable')) AS void_24h`,
          )
          .get(since, since, since, since, since) as {
          accepted_24h: number;
          resolved_24h: number;
          wins_24h: number;
          losses_24h: number;
          void_24h: number;
        };
        events.emit({
          type: "stats.tick",
          served_at: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
          ...row,
        });
      }),
    );
  }

  // Optional OpenServ Launchpad agent — opt-in only. This is a public
  // discovery/growth surface for OpenServ, not part of Murmur's private
  // verdict submission, Fhenix reveal, scoring, or resolution path.
  if (
    !opts.skipOpenServ &&
    process.env.OPENSERV_LAUNCHPAD_ENABLED === "true" &&
    process.env.OPENSERV_API_KEY
  ) {
    try {
      const { startLaunchpadOpenServAgent } = await import(
        "../integrations/openserv-launchpad.js"
      );
      await startLaunchpadOpenServAgent({
        db,
      });
    } catch (err) {
      console.warn("[daemon] OpenServ Launchpad agent failed to start:", err);
    }
  }

  console.log(
    `[daemon] verdict listening on :${actualPort} (resolver=${RESOLVER_TICK_SEC}s)`,
  );

  const close = async (): Promise<void> => {
    for (const t of tickers) clearInterval(t);
    webhookDispatcher.stop();
    if (polymarketStop) polymarketStop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  };

  return { port: actualPort, close };
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

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeOracle(): OracleClient | null {
  // Default to the free public Base mainnet RPC when no override is set.
  // The public endpoint is rate-limited but sufficient for dev + low-volume
  // production; operators expecting real load should set a paid RPC URL
  // (Alchemy / Infura / QuickNode) via env. Removing the env-gate here
  // lets the resolver enable out of the box on a fresh boot.
  if (!process.env.BASE_MAINNET_RPC_URL) {
    process.env.BASE_MAINNET_RPC_URL = "https://mainnet.base.org";
    console.log(
      "[daemon] BASE_MAINNET_RPC_URL unset; defaulting to public https://mainnet.base.org (rate-limited; set a paid RPC URL for production load)",
    );
  }
  try {
    return new OracleClient();
  } catch (err) {
    console.warn(
      "[daemon] OracleClient init failed:",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

function setIntervalGuarded(
  intervalMs: number,
  label: string,
  work: () => Promise<unknown>,
): NodeJS.Timeout {
  let inFlight = false;
  return setInterval(() => {
    if (inFlight) {
      console.warn(`[daemon] ${label} tick still in flight — skipping`);
      return;
    }
    inFlight = true;
    work()
      .catch((err) => console.warn(`[daemon] ${label} tick failed:`, err))
      .finally(() => {
        inFlight = false;
      });
  }, intervalMs);
}

function ensureParentDir(filePath: string): void {
  const dir = dirname(filePath);
  if (dir && dir !== ".") {
    mkdirSync(dir, { recursive: true });
  }
}
