// ─── /v1/account/* router (V2 §7.1 casual tier) — SCAFFOLD ONLY ───────────
//
// NOT YET MOUNTED on the main app. Phase 4 imports `accountRouter` from
// here and wires it into createVerdictRouter / daemon/index.ts. Until
// then this file is dead code from the runtime's perspective; only the
// type-check and the smoke test exercise it.
//
// Routes:
//   POST   /v1/account/session                          — Privy → account upsert
//   POST   /v1/account/agents                           — create casual agent
//   GET    /v1/account/agents                           — list owned agents
//   POST   /v1/account/agents/:slug/api-keys            — mint scoped key
//   DELETE /v1/account/api-keys/:key_id                 — rotate (soft delete)
//   PATCH  /v1/account/agents/:slug/destination-address — set/update payout addr
//
// Auth model:
//   Every route except /session expects an already-verified casual-tier
//   identity. /session itself accepts a raw Privy Bearer token, runs it
//   through verifyPrivyAuth, and creates/updates the account row. The
//   other routes require both Privy auth AND ownership of the targeted
//   agent (account_agents bridge). Account ownership is enforced inside
//   each handler — the router does not assume Phase-4 middleware has
//   already filtered.

import { Router, type Request, type Response, type NextFunction } from "express";
import express from "express";
import type Database from "better-sqlite3";
import { z } from "zod";
import { randomUUID, createHash } from "node:crypto";
import { rateLimit, ipKeyGenerator } from "express-rate-limit";
import {
  AgentSlugSchema,
  ERROR_CODES,
  WalletAddressSchema,
  VerdictError,
} from "../schema.js";
import { agentsRepo } from "../db.js";
import {
  getOrCreateAccount,
  linkAgentToAccount,
  listAccountAgents,
  getAccountForAgent,
  mintApiKey,
  rotateApiKey,
  setDestinationAddress,
  listApiKeysForAccount,
  AgentAlreadyOwnedError,
} from "../auth/accounts.js";
import { verifyPrivyAuth, type PrivyClaims } from "../auth/privy.js";

export interface AccountRouterDeps {
  db: Database.Database;
  /**
   * Optional clock injection. Phase 4 will share its `now` with this
   * router so cooldown tests stay deterministic.
   */
  now?: () => Date;
  /**
   * Optional cooldown override for tests. Real deploys leave this
   * unset and use the default from auth/accounts.ts (24h).
   */
  destinationCooldownMs?: number;
}

/**
 * Resolve the Privy Bearer token from a request → claims → account.
 * Returns null if no Bearer is present or verification failed; the
 * caller decides how to surface that (most routes 403, /session 401).
 */
async function resolveAccount(
  req: Request,
  db: Database.Database,
): Promise<{ claims: PrivyClaims; account_id: string } | null> {
  const authz = req.header("Authorization") ?? req.header("authorization");
  if (!authz || !/^Bearer\s+/i.test(authz)) return null;
  const token = authz.replace(/^Bearer\s+/i, "").trim();
  const claims = await verifyPrivyAuth(token);
  if (!claims) return null;
  const { account_id } = getOrCreateAccount(db, claims);
  return { claims, account_id };
}

/**
 * Throw 403 if the agent isn't owned by this account.
 */
function assertAgentOwnedBy(
  db: Database.Database,
  account_id: string,
  agent_id: string,
): void {
  const owner = getAccountForAgent(db, agent_id);
  if (owner !== account_id) {
    throw new VerdictError(
      "agent not owned by this account",
      ERROR_CODES.agent_not_authorized,
      403,
    );
  }
}

// ─── Route handlers ───────────────────────────────────────────────────────

const CreateAgentSchema = z.object({
  display_slug: AgentSlugSchema,
  display_name: z.string().min(1).max(120),
  bio: z.string().max(500).optional(),
});

const MintKeySchema = z.object({
  label: z.string().max(80).optional(),
});

const SetDestinationSchema = z.object({
  destination_address: WalletAddressSchema,
});

// ─── Rate limiting (V2 §7.1 + codex review MAJOR finding 8.4) ───────────────
//
// All /v1/account/* routes ship with route-level rate limiting BEFORE Phase 4
// mounts the router, so we never have a dark window where the dispatcher is
// reachable but unprotected. Per-route limits are tuned to the operation:
//
//   POST   /v1/account/session                            30 / min / IP
//   POST   /v1/account/agents                             10 / min / IP
//   POST   /v1/account/agents/:slug/api-keys              10 / min / (IP, token)
//   PATCH  /v1/account/agents/:slug/destination-address    5 / min / (IP, token)
//   DELETE /v1/account/api-keys/:key_id                   20 / min / (IP, token)
//   GET    /v1/account/agents                             60 / min / IP
//
// IP-only limits cover unauthenticated burst (e.g. mass /session probing).
// Token-bucket limits gate authenticated bursts so a leaked Privy token
// can't drain key-mint capacity for everyone behind the same IP (corporate
// NAT, mobile carriers).
//
// State is in-process MemoryStore. Single Render instance today; if Phase 4
// scales out we need a Redis-backed store (express-rate-limit provides one
// via @express-rate-limit/redis). Until then, scaling horizontally would
// reset counters per-instance — flag this concern in the operator runbook
// before promoting the daemon to multi-replica.
const ONE_MINUTE_MS = 60 * 1000;

/**
 * Build a key generator that combines the client IP with a hash of the
 * Authorization bearer token. Hashes the token (not the cleartext) so the
 * rate-limiter store doesn't double as a credential cache. When no Bearer
 * is present (the limiter still runs even on unauth requests) we fall
 * back to IP-only — this still rate-limits anonymous probing.
 */
function ipAndTokenKey(req: Request, _res: Response): string {
  const authz = req.header("Authorization") ?? req.header("authorization") ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(authz);
  // Use express-rate-limit's IPv6-safe IP key generator (an IPv6 address
  // contains a colon, which clashes with naive concatenation).
  const ip = ipKeyGenerator(req.ip ?? "unknown");
  if (!m || !m[1]) return ip;
  // sha256 → hex first 16 chars: collision space is 2^64, plenty for a
  // rate-limiting bucket. Caching the hash per-request would help, but
  // the limiter only runs once per request, so it's a non-issue.
  const tokenHash = createHash("sha256").update(m[1]).digest("hex").slice(0, 16);
  return `${ip}:${tokenHash}`;
}

function makeLimiter(
  max: number,
  windowMs: number,
  perToken: boolean,
  routeLabel: string,
) {
  return rateLimit({
    windowMs,
    limit: max,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    keyGenerator: perToken
      ? ipAndTokenKey
      : (req, _res) => ipKeyGenerator(req.ip ?? "unknown"),
    message: { error: "rate_limited", code: "rate_limited", route: routeLabel },
  });
}

export function createAccountRouter(deps: AccountRouterDeps): Router {
  const router = Router();
  const json = express.json({ limit: "32kb" });
  const { db, now, destinationCooldownMs } = deps;

  // Per-route limiters constructed once per router instance; tests that
  // build a fresh router per case get a clean window each time.
  const sessionLimiter = makeLimiter(30, ONE_MINUTE_MS, false, "session");
  const createAgentLimiter = makeLimiter(10, ONE_MINUTE_MS, false, "create_agent");
  const listAgentsLimiter = makeLimiter(60, ONE_MINUTE_MS, false, "list_agents");
  const mintKeyLimiter = makeLimiter(10, ONE_MINUTE_MS, true, "mint_api_key");
  const rotateKeyLimiter = makeLimiter(20, ONE_MINUTE_MS, true, "rotate_api_key");
  const destAddrLimiter = makeLimiter(5, ONE_MINUTE_MS, true, "destination_address");

  // POST /v1/account/session — exchange Privy JWT for an internal session.
  // Returns { account_id, created } so the dashboard can branch on
  // first-time UX. Idempotent — repeat calls update last_seen_at and
  // always succeed for a valid token.
  router.post(
    "/v1/account/session",
    sessionLimiter,
    json,
    asyncHandler(async (req, res) => {
      const resolved = await resolveAccount(req, db);
      if (!resolved) {
        throw new VerdictError(
          "invalid or missing Privy bearer token",
          ERROR_CODES.agent_not_authorized,
          401,
        );
      }
      // We need to know whether the row existed before this call. Do a
      // pre-check. Cheap because privy_user_id is UNIQUE-indexed.
      const existing = db
        .prepare("SELECT 1 FROM accounts WHERE privy_user_id = ?")
        .get(resolved.claims.privy_user_id);
      const created = !existing;
      // resolveAccount already upserted; we still call to bump
      // last_seen_at on the freshly-created row.
      const { account_id } = getOrCreateAccount(db, resolved.claims);
      res.status(200).json({
        account_id,
        created,
        privy_user_id: resolved.claims.privy_user_id,
      });
    }),
  );

  // POST /v1/account/agents — create a casual-tier agent under this account.
  // Body: { display_slug, display_name, bio? }
  router.post(
    "/v1/account/agents",
    createAgentLimiter,
    json,
    asyncHandler(async (req, res) => {
      const resolved = await resolveAccount(req, db);
      if (!resolved) {
        throw new VerdictError("auth required", ERROR_CODES.agent_not_authorized, 401);
      }
      const parsed = CreateAgentSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new VerdictError(
          "invalid request",
          ERROR_CODES.schema_invalid,
          400,
          { issues: parsed.error.issues },
        );
      }
      const ts = (now ?? (() => new Date()))().toISOString().replace(/\.\d+Z$/, "Z");
      const agent_id = randomUUID();
      // FIX 6 — wrap agent insert + ownership link in a single
      // transaction so a crash between insert and link cannot leave
      // an orphan casual agent. Errors are caught + classified outside
      // the transaction (so the rollback runs first, then the API
      // surfaces the right status code).
      try {
        db.transaction(() => {
          agentsRepo.insert(
            db,
            {
              agent_id,
              display_slug: parsed.data.display_slug,
              kind: "casual",
              display_name: parsed.data.display_name,
              bio: parsed.data.bio,
              created_at: ts,
              verified_identities: [],
            },
            null,
          );
          linkAgentToAccount(db, resolved.account_id, agent_id);
        })();
      } catch (err) {
        // SQLite UNIQUE on display_slug → 'duplicate'.
        if (
          err instanceof Error &&
          /UNIQUE.+display_slug/i.test(err.message)
        ) {
          throw new VerdictError(
            "display_slug already taken",
            ERROR_CODES.duplicate,
            409,
          );
        }
        // BLOCKER #4 — agent already owned by a different account.
        if (err instanceof AgentAlreadyOwnedError) {
          throw new VerdictError(
            err.message,
            ERROR_CODES.agent_already_owned_by_another_account,
            409,
            { agent_id: err.agent_id },
          );
        }
        throw err;
      }
      res.status(201).json({
        agent_id,
        display_slug: parsed.data.display_slug,
        display_name: parsed.data.display_name,
        kind: "casual",
        created_at: ts,
      });
    }),
  );

  // GET /v1/account/agents — list agents owned by this account.
  router.get(
    "/v1/account/agents",
    listAgentsLimiter,
    asyncHandler(async (req, res) => {
      const resolved = await resolveAccount(req, db);
      if (!resolved) {
        throw new VerdictError("auth required", ERROR_CODES.agent_not_authorized, 401);
      }
      const rows = listAccountAgents(db, resolved.account_id);
      const hydrated = rows.map((row) => {
        const a = agentsRepo.byId(db, row.agent_id);
        return {
          agent_id: row.agent_id,
          linked_at: row.created_at,
          display_slug: a?.display_slug ?? null,
          display_name: a?.display_name ?? null,
          kind: a?.kind ?? null,
        };
      });
      res.status(200).json({ agents: hydrated });
    }),
  );

  // POST /v1/account/agents/:slug/api-keys — mint a new scoped key.
  // Returns { api_key_id, secret, created_at }. The plaintext secret is
  // returned exactly once and never stored beyond the response stream.
  router.post(
    "/v1/account/agents/:slug/api-keys",
    mintKeyLimiter,
    json,
    asyncHandler(async (req, res) => {
      const resolved = await resolveAccount(req, db);
      if (!resolved) {
        throw new VerdictError("auth required", ERROR_CODES.agent_not_authorized, 401);
      }
      const slug = String(req.params.slug ?? "");
      const agent = agentsRepo.bySlug(db, slug);
      if (!agent) {
        throw new VerdictError(
          "unknown agent",
          ERROR_CODES.unknown_agent,
          404,
        );
      }
      assertAgentOwnedBy(db, resolved.account_id, agent.agent_id);
      const parsed = MintKeySchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        throw new VerdictError(
          "invalid request",
          ERROR_CODES.schema_invalid,
          400,
          { issues: parsed.error.issues },
        );
      }
      const minted = mintApiKey(
        db,
        resolved.account_id,
        agent.agent_id,
        parsed.data.label,
      );
      res.status(201).json({
        api_key_id: minted.api_key_id,
        secret: minted.secret,
        created_at: minted.created_at,
        warning: "store this secret now — it is not retrievable later",
      });
    }),
  );

  // DELETE /v1/account/api-keys/:key_id — rotate (soft-delete) a key.
  router.delete(
    "/v1/account/api-keys/:key_id",
    rotateKeyLimiter,
    asyncHandler(async (req, res) => {
      const resolved = await resolveAccount(req, db);
      if (!resolved) {
        throw new VerdictError("auth required", ERROR_CODES.agent_not_authorized, 401);
      }
      const key_id = String(req.params.key_id ?? "");
      // Require the key to belong to this account (defence-in-depth —
      // the WHERE in rotateApiKey doesn't check account_id).
      const owned = listApiKeysForAccount(db, resolved.account_id, true).some(
        (k) => k.api_key_id === key_id,
      );
      if (!owned) {
        throw new VerdictError(
          "api key not owned by this account",
          ERROR_CODES.agent_not_authorized,
          403,
        );
      }
      const rotated = rotateApiKey(db, key_id);
      res.status(200).json({ rotated });
    }),
  );

  // PATCH /v1/account/agents/:slug/destination-address — set/update payout target.
  // Enforces the §7.4 24h cooldown via setDestinationAddress().
  router.patch(
    "/v1/account/agents/:slug/destination-address",
    destAddrLimiter,
    json,
    asyncHandler(async (req, res) => {
      const resolved = await resolveAccount(req, db);
      if (!resolved) {
        throw new VerdictError("auth required", ERROR_CODES.agent_not_authorized, 401);
      }
      const slug = String(req.params.slug ?? "");
      const agent = agentsRepo.bySlug(db, slug);
      if (!agent) {
        throw new VerdictError(
          "unknown agent",
          ERROR_CODES.unknown_agent,
          404,
        );
      }
      assertAgentOwnedBy(db, resolved.account_id, agent.agent_id);
      const parsed = SetDestinationSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new VerdictError(
          "invalid request",
          ERROR_CODES.schema_invalid,
          400,
          { issues: parsed.error.issues },
        );
      }
      const result = setDestinationAddress(
        db,
        agent.agent_id,
        parsed.data.destination_address,
        {
          ...(destinationCooldownMs !== undefined
            ? { cooldownMs: destinationCooldownMs }
            : {}),
          ...(now ? { now } : {}),
        },
      );
      if (!result.ok) {
        if (result.reason === "cooldown_active") {
          res.status(429).json({
            error: "destination_address cooldown active",
            code: ERROR_CODES.rate_limited,
            retry_after_seconds: result.retry_after_seconds,
          });
          return;
        }
        throw new VerdictError(
          "agent not found",
          ERROR_CODES.unknown_agent,
          404,
        );
      }
      res.status(200).json({
        agent_id: agent.agent_id,
        destination_address: parsed.data.destination_address,
      });
    }),
  );

  return router;
}

/** Singleton-style export — Phase 4 prefers this for ergonomic mounting. */
export const accountRouter = (deps: AccountRouterDeps): Router =>
  createAccountRouter(deps);

// ─── helpers ──────────────────────────────────────────────────────────────

function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<void>,
) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res, next).catch(next);
  };
}
