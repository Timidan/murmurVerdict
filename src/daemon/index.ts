import "dotenv/config";
import express from "express";
import http from "node:http";
import cors from "cors";
import { OracleClient } from "../integrations/oracle.js";
import { Resolver } from "../verdict/resolver.js";
import { createVerdictRouter } from "../verdict/api.js";
import { accountRouter } from "../verdict/routes/account.js";
import { ClaimService } from "../verdict/claim.js";
import { agentsRepo, openDb, resolutionsRepo, submissionsRepo } from "../verdict/db.js";
import { runPhaseECleanupIfRequested } from "../verdict/phase-e-cleanup.js";
import { hashSharedSecret } from "../verdict/submissions.js";
import { VerdictEventBus } from "../verdict/events.js";
import { getLeaderboard } from "../verdict/leaderboard.js";
import { startWebhookDispatcher } from "../verdict/webhooks.js";
import {
  registerBaselines,
  runBaselinesOnce,
} from "../benchmark/agents.js";
import { loadAgeContextFromEnv } from "../verdict/age-envelope.js";
import { loadDrandContextFromEnv } from "../verdict/drand-envelope.js";
import { TelegramNotifier } from "../integrations/telegram.js";
import { makeProductionVerifier } from "../integrations/postVerifiers.js";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Server } from "node:http";

// ─── Env knobs ──────────────────────────────────────────────────────────────

const PORT = Number(process.env.PORT ?? 8080);
const RESOLVER_TICK_SEC = Number(process.env.RESOLVER_TICK_SEC ?? 30);
const BENCHMARK_TICK_SEC = Number(process.env.BENCHMARK_TICK_SEC ?? 600);
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
  // BLOCKER #5 fix — Phase-E plaintext scrub runs at boot when env is set.
  // Idempotent + decoupled from MIGRATION_015's single-shot schema gate.
  runPhaseECleanupIfRequested(db);
  registerBaselines(db);

  // Wave 4b-2 — MarketContextProvider (Santiment scout/analyst) removed.
  // Murmur is a pure ranking layer over canonical price/event oracles;
  // no sentiment cache or 5-minute refresh tick.
  const telegram = new TelegramNotifier();
  const oracle = makeOracle();
  const events = new VerdictEventBus();
  // P2 committed-mode: load the daemon's age recipient at boot so
  // committed submissions can be encrypted to it. Optional — when
  // absent, committed-mode submissions return 503 and legacy_plaintext
  // path is unaffected.
  const ageCtx = loadAgeContextFromEnv();
  if (ageCtx) {
    console.log(
      `[daemon] age envelope ready (key_id=${ageCtx.daemon_key_id}, fallback_decrypt=${ageCtx.identity ? "enabled" : "disabled"})`,
    );
  } else {
    console.log("[daemon] age recipient not set; committed-mode submissions disabled");
  }
  // P2 phase B-3: optional parallel drand/tlock envelope (D21).
  // Closes the selective-reveal attack vector — operator can't keep a
  // committed call hidden past the drand round, even with the age key.
  const drandCtx = loadDrandContextFromEnv();
  if (drandCtx) {
    console.log(
      `[daemon] drand timelock ready (chain=${drandCtx.chain.hash.slice(0, 12)}…, period=${drandCtx.chain.period}s)`,
    );
  } else {
    console.log(
      "[daemon] drand disabled (set MURMUR_DRAND_ENABLED=1 for daemon-less reveal)",
    );
  }
  // Webhooks fan-out: subscribes once and dispatches HTTP POST to every
  // matching subscription on call.accepted / call.resolved.
  const webhookDispatcher = startWebhookDispatcher(db, events);
  const resolver = oracle
    ? new Resolver({
        db,
        oracle,
        ...(ageCtx ? { ageContext: ageCtx } : {}),
        ...(drandCtx ? { drandContext: drandCtx } : {}),
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
              events.emit({
                type: "call.resolved",
                call_id,
                agent_id: agent.agent_id,
                agent_slug: agent.display_slug,
                outcome: full.resolution.outcome,
                signed_return: full.resolution.signed_return,
                call_score: full.resolution.call_score ?? null,
                resolved_at: full.resolution.resolved_at,
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
      ctx: {
        events,
        ...(ageCtx ? { ageContext: ageCtx } : {}),
        ...(drandCtx ? { drandContext: drandCtx } : {}),
      },
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
  // store, tracked in scaling research §6). Mounted AFTER the verdict
  // router so `/v1/calls` / `/v1/agents/...` still resolve to the legacy
  // handlers — `/v1/account/*` is a fresh path prefix with no collision.
  app.use(accountRouter({ db }));

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
    // Wave 4b-2 — market refresh ticker dropped (no Santiment cache to refresh).
    // The benchmark ticker stays so legacy benchmark agents are still
    // registered, but runBaselinesOnce now no-ops when no decision-driving
    // signal source is wired (see src/benchmark/agents.ts).
    tickers.push(
      setIntervalGuarded(BENCHMARK_TICK_SEC * 1000, "benchmark", async () => {
        await runBaselinesOnce({ db });
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
        ctx: {},
      });
    } catch (err) {
      console.warn("[daemon] OpenServ adapter failed to start:", err);
    }
  }

  console.log(
    `[daemon] verdict listening on :${actualPort} (resolver=${RESOLVER_TICK_SEC}s, benchmark=${BENCHMARK_TICK_SEC}s)`,
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
