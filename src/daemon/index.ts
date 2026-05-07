import "dotenv/config";
import express from "express";
import http from "node:http";
import cors from "cors";
import { OracleClient } from "../integrations/oracle.js";
import { Resolver } from "../verdict/resolver.js";
import { createVerdictRouter } from "../verdict/api.js";
import { ClaimService } from "../verdict/claim.js";
import { agentsRepo, openDb, resolutionsRepo, submissionsRepo } from "../verdict/db.js";
import { hashSharedSecret } from "../verdict/submissions.js";
import { VerdictEventBus } from "../verdict/events.js";
import { getLeaderboard } from "../verdict/leaderboard.js";
import { startWebhookDispatcher } from "../verdict/webhooks.js";
import {
  registerBaselines,
  runBaselinesOnce,
} from "../benchmark/agents.js";
import { MarketContextProvider } from "./marketContext.js";
import { TelegramNotifier } from "../integrations/telegram.js";
import { makeProductionVerifier } from "../integrations/postVerifiers.js";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Server } from "node:http";

// ─── Env knobs ──────────────────────────────────────────────────────────────

const PORT = Number(process.env.PORT ?? 8080);
const RESOLVER_TICK_SEC = Number(process.env.RESOLVER_TICK_SEC ?? 30);
const BENCHMARK_TICK_SEC = Number(process.env.BENCHMARK_TICK_SEC ?? 600);
const MARKET_REFRESH_SEC = Number(process.env.MARKET_REFRESH_SEC ?? 300);
const VERDICT_DB_PATH = process.env.VERDICT_DB_PATH ?? "./data/verdict.db";
const DASHBOARD_ORIGIN = (process.env.DASHBOARD_ORIGIN ?? "*").trim();

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
  /** Skip OpenServ agent registration (useful in tests) */
  skipOpenServ?: boolean;
  /** Skip cron tickers (useful in tests; smoke driver still calls .tick() manually) */
  skipTickers?: boolean;
}

export async function startDaemon(opts: DaemonOpts = {}): Promise<DaemonHandle> {
  const dbPath = opts.dbPath ?? VERDICT_DB_PATH;
  const port = opts.port ?? PORT;

  ensureParentDir(dbPath);
  const db = openDb({ path: dbPath });
  registerBaselines(db);

  const market = new MarketContextProvider({
    refreshIntervalMs: MARKET_REFRESH_SEC * 1000,
  });
  await market.refresh();

  const telegram = new TelegramNotifier();
  const oracle = makeOracle();
  const events = new VerdictEventBus();
  // Webhooks fan-out: subscribes once and dispatches HTTP POST to every
  // matching subscription on call.accepted / call.resolved.
  const webhookDispatcher = startWebhookDispatcher(db, events);
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
              events.emit({
                type: "call.resolved",
                call_id,
                agent_id: agent.agent_id,
                agent_slug: agent.display_slug,
                outcome: full.resolution.outcome,
                signed_return: full.resolution.signed_return,
                call_score: full.resolution.call_score ?? null,
                resolved_at: full.resolution.resolved_at,
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
            }
          } catch (err) {
            console.warn(`[daemon] sse fan-out failed for ${call_id}:`, err);
          }
          // 2. Telegram side-effect (existing behavior)
          if (!telegram.isLive()) return;
          const result = await telegram.postResolutionCard(db, call_id);
          if (!result.ok && result.reason) {
            console.warn(
              `[daemon] telegram resolution card failed for ${call_id}: ${result.reason}`,
            );
          }
        },
      })
    : null;
  // Claim flow:
  //   - production: wire CompositeVerifier (Telegram + X). Real verification.
  //   - dev / smoke: leave verifier unset so ClaimService falls back to its
  //     internal NullVerifier (gated on NODE_ENV !== "production" inside
  //     ClaimService — see src/verdict/claim.ts).
  const claim =
    process.env.NODE_ENV === "production"
      ? new ClaimService({ db, verifier: makeProductionVerifier() })
      : new ClaimService({ db });

  const app = express();
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
      ctx: { marketContext: (asset_id) => market.get(asset_id), events },
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
      resolveSharedSecret: async (agent_id) => {
        const row = agentsRepo.byId(db, agent_id);
        if (!row?.api_key_hash) return null;
        // The HTTP layer expects the actual secret, not the hash. We don't
        // store secrets in v0.1, so we compute a HMAC against an env-supplied
        // shared secret table for benchmark agents only. External agents must
        // bring their own key via the claim flow.
        const benchmarkKey = process.env[`BENCHMARK_KEY_${row.display_slug}`];
        if (benchmarkKey && hashSharedSecret(benchmarkKey) === row.api_key_hash) {
          return benchmarkKey;
        }
        return null;
      },
      claim,
    }),
  );

  const server: Server = await new Promise((resolve, reject) => {
    const s = app.listen(port, () => resolve(s));
    s.once("error", reject);
  });
  const addr = server.address();
  const actualPort =
    typeof addr === "object" && addr !== null ? addr.port : port;

  // Cron tickers — every ticker is wrapped in an in-flight guard so a slow
  // run (e.g. oracle/Telegram path) never overlaps with the next tick.
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
    tickers.push(
      setIntervalGuarded(MARKET_REFRESH_SEC * 1000, "market", async () => {
        await market.refresh();
      }),
    );
    tickers.push(
      setIntervalGuarded(BENCHMARK_TICK_SEC * 1000, "benchmark", async () => {
        await runBaselinesOnce({
          db,
          ctx: { marketContext: (asset_id) => market.get(asset_id) },
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

  // Optional OpenServ adapter — opt-in only. The @openserv-labs/sdk has
  // `openai` as a peer dep that we don't ship by default, so we only attempt
  // the dynamic import when the operator explicitly sets
  // OPENSERV_VERDICT_ENABLED=true.
  if (
    !opts.skipOpenServ &&
    process.env.OPENSERV_VERDICT_ENABLED === "true" &&
    process.env.OPENSERV_API_KEY
  ) {
    try {
      const { startVerdictOpenServAgent } = await import(
        "../integrations/openserv-verdict.js"
      );
      await startVerdictOpenServAgent({
        db,
        ctx: { marketContext: (asset_id) => market.get(asset_id) },
      });
    } catch (err) {
      console.warn("[daemon] OpenServ adapter failed to start:", err);
    }
  }

  console.log(
    `[daemon] verdict listening on :${actualPort} (resolver=${RESOLVER_TICK_SEC}s, benchmark=${BENCHMARK_TICK_SEC}s, market=${MARKET_REFRESH_SEC}s)`,
  );

  const close = async (): Promise<void> => {
    for (const t of tickers) clearInterval(t);
    webhookDispatcher.stop();
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
  if (!process.env.BASE_MAINNET_RPC_URL) return null;
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
