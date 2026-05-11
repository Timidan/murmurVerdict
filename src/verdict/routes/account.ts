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
import { agentsRepo, usageRepo } from "../db.js";
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
  type SetDestinationResult,
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
 *
 * BUG FIX (codex review v2 P2 #2): forwards the `created` flag from
 * getOrCreateAccount so the /v1/account/session handler can branch on
 * first-time UX without doing its own SELECT-existence check (which
 * raced against this function's INSERT and always reported created=false).
 */
async function resolveAccount(
  req: Request,
  db: Database.Database,
): Promise<{ claims: PrivyClaims; account_id: string; created: boolean } | null> {
  const authz = req.header("Authorization") ?? req.header("authorization");
  if (!authz || !/^Bearer\s+/i.test(authz)) return null;
  const token = authz.replace(/^Bearer\s+/i, "").trim();
  const claims = await verifyPrivyAuth(token);
  if (!claims) return null;
  const { account_id, created } = getOrCreateAccount(db, claims);
  return { claims, account_id, created };
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

// Phase 7d — funnel event emit. Body is fixed-shape, kind is strictly
// allowlisted server-side (mirrors UsageEventKindSchema but enumerated
// inline so the route stays the only authority on what the dashboard
// can write). Anything outside this list → 400 schema_invalid.
//
// Why a separate enum instead of UsageEventKindSchema? The full schema
// includes resolver-side kinds (submission_accepted, resolution_completed)
// that the dashboard should NEVER be allowed to forge. The route's
// allowlist is the funnel-only subset.
const FunnelEventKindSchema = z.enum([
  "landing.viewed",
  "compete.clicked",
  "privy.modal_opened",
  "privy.signed_in",
  "agent.created",
  "api_key.minted",
  "destination.set",
  // Reserved for future resolver-side emits; the dashboard never sets
  // these directly today, but the allowlist accepts them so we can wire
  // the call-resolver path without another roll.
  "call.first_submitted",
  "call.first_resolved",
  "call.tenth_submitted",
]);

const FunnelEventSchema = z.object({
  kind: FunnelEventKindSchema,
  // Attributes are free-shape but constrained to JSON-stringifiable
  // values via z.record. The DB column is TEXT (JSON.stringified) so we
  // accept anything well-typed and let the JSON encoder handle the
  // ground-truth shape check.
  attributes: z.record(z.string(), z.unknown()).optional(),
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
  // Funnel-emit limiter — generous because the dashboard fires one event per
  // user action (landing.viewed, compete.clicked, etc) and a single Maya
  // walks through ~7 of them inside a minute. Per-token so a leaked Privy
  // bearer can't drain everyone's quota.
  const funnelEventLimiter = makeLimiter(60, ONE_MINUTE_MS, true, "funnel_event");

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
      // BUG FIX (codex review v2 P2 #2): the previous implementation did a
      // SELECT-existence check AFTER resolveAccount had already INSERTed the
      // row, so `created` was always false for first-time users. The
      // `created` flag now comes directly from getOrCreateAccount via
      // resolveAccount — true iff the upsert inserted a fresh row.
      res.status(200).json({
        account_id: resolved.account_id,
        created: resolved.created,
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
  //
  // Phase 7c additive: surface `destination_address` and
  // `destination_address_updated_at` on each row so the settings UI can
  // derive the §7.4 24h cooldown countdown without an extra round-trip
  // (and without needing to call PATCH and parse 429 just to learn the
  // current state). Reads the columns via a direct SELECT because the
  // hydrated AgentRow shape doesn't expose them by design — keeps the
  // public /v1/agents/:slug response free of operator-only payout data.
  router.get(
    "/v1/account/agents",
    listAgentsLimiter,
    asyncHandler(async (req, res) => {
      const resolved = await resolveAccount(req, db);
      if (!resolved) {
        throw new VerdictError("auth required", ERROR_CODES.agent_not_authorized, 401);
      }
      const rows = listAccountAgents(db, resolved.account_id);
      const destRowStmt = db.prepare(
        "SELECT destination_address, destination_address_updated_at FROM agents WHERE agent_id = ?",
      );
      const hydrated = rows.map((row) => {
        const a = agentsRepo.byId(db, row.agent_id);
        const dest = destRowStmt.get(row.agent_id) as
          | {
              destination_address: string | null;
              destination_address_updated_at: string | null;
            }
          | undefined;
        return {
          agent_id: row.agent_id,
          linked_at: row.created_at,
          display_slug: a?.display_slug ?? null,
          display_name: a?.display_name ?? null,
          kind: a?.kind ?? null,
          destination_address: dest?.destination_address ?? null,
          destination_address_updated_at:
            dest?.destination_address_updated_at ?? null,
        };
      });
      res.status(200).json({ agents: hydrated });
    }),
  );

  // GET /v1/account/agents/:slug/api-keys — list active keys for an agent.
  //
  // Phase 7c — the rotate UI needs to enumerate (api_key_id, created_at,
  // label) so the user can pick which stale key to soft-delete without
  // having to remember a uuid. The plaintext secret is NEVER returned
  // here — only metadata. Existing /api-keys POST stays the sole source
  // of cleartext per the §7.5 one-time-reveal invariant.
  //
  // Auth: requires Privy bearer + agent ownership (same posture as
  // POST /:slug/api-keys). Re-uses `listAgentsLimiter` semantics — this
  // is a read on already-paginated data.
  router.get(
    "/v1/account/agents/:slug/api-keys",
    listAgentsLimiter,
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
      // Filter the account-wide list down to keys belonging to THIS agent.
      // listApiKeysForAccount returns rows scoped to the account; we keep
      // both rotated + active so the panel can show full history (the UI
      // chooses what to render).
      const keys = listApiKeysForAccount(db, resolved.account_id, true)
        .filter((k) => k.agent_id === agent.agent_id)
        .map((k) => ({
          api_key_id: k.api_key_id,
          created_at: k.created_at,
          label: k.label,
          rotated_at: k.rotated_at,
        }));
      res.status(200).json({ keys });
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
      // V2 §7.7 risk-1 — the address update and its audit event must commit
      // atomically. Without the outer transaction, a crash between
      // setDestinationAddress returning and usageRepo.emit running would
      // leave the cooldown active with no matching audit row, breaking
      // post-incident replay AND blocking retry. better-sqlite3 nests via
      // savepoints, so setDestinationAddress's inner txn becomes a savepoint
      // of this outer commit-or-rollback boundary.
      const result = db.transaction((): SetDestinationResult => {
        const r = setDestinationAddress(
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
        if (r.ok) {
          usageRepo.emit(db, {
            event_id: randomUUID(),
            agent_id: agent.agent_id,
            kind: "destination_address_updated",
            ts: r.updated_at ?? new Date().toISOString().replace(/\.\d+Z$/, "Z"),
            attributes: {
              previous_address: r.previous_address ?? null,
              new_address: parsed.data.destination_address,
              cooldown_ms:
                destinationCooldownMs ?? 24 * 60 * 60 * 1000 /* default */,
            },
          });
        }
        return r;
      })();
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
      // Phase 7c — surface `destination_address_updated_at` on the success
      // response so the client can start the 24h cooldown countdown
      // without an extra round-trip. Falls back to `now()` if the inner
      // helper didn't return one (shouldn't happen on ok=true).
      res.status(200).json({
        agent_id: agent.agent_id,
        destination_address: parsed.data.destination_address,
        destination_address_updated_at:
          result.updated_at ?? new Date().toISOString().replace(/\.\d+Z$/, "Z"),
      });
    }),
  );

  // POST /v1/account/events — thin allowlisted funnel-event emit (Phase 7d).
  //
  // Account-scoped audit trail for the Maya onboarding loop. The dashboard
  // fires one event per UX step (landing.viewed → compete.clicked → … →
  // destination.set) so we can measure where casual-tier signups drop off.
  //
  // Why account-scoped (agent_id=null) instead of agent-scoped: most of the
  // funnel happens BEFORE the user has an agent. The handful of post-create
  // events (api_key.minted, destination.set) could carry agent_id in their
  // attributes_json — we keep that as a payload field rather than the
  // usage_events.agent_id column because the column ON DELETE SET NULLs
  // (agent deletion shouldn't wipe funnel history).
  //
  // Auth: same Privy bearer posture as the other /v1/account/* writes. A
  // 401 is silently swallowed by useFunnelEmit on the client so missed
  // emits never bubble into the UI.
  router.post(
    "/v1/account/events",
    funnelEventLimiter,
    json,
    asyncHandler(async (req, res) => {
      const resolved = await resolveAccount(req, db);
      if (!resolved) {
        throw new VerdictError(
          "auth required",
          ERROR_CODES.agent_not_authorized,
          401,
        );
      }
      const parsed = FunnelEventSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new VerdictError(
          "invalid request",
          ERROR_CODES.schema_invalid,
          400,
          { issues: parsed.error.issues },
        );
      }
      const ts = (now ?? (() => new Date()))()
        .toISOString()
        .replace(/\.\d+Z$/, "Z");
      // Stamp the account_id into attributes so downstream funnel queries
      // can group by account without joining against the api_keys table.
      // The usage_events.agent_id column stays null on purpose (these are
      // account-scoped, not agent-scoped).
      //
      // Codex P2 fix — put account_id AFTER the client spread (was the
      // other way), so an authenticated caller submitting
      // `attributes.account_id = "other"` cannot overwrite the
      // server-stamped value used for downstream attribution. The trusted
      // server value always wins.
      const attributes = {
        ...(parsed.data.attributes ?? {}),
        account_id: resolved.account_id,
      };
      usageRepo.emit(db, {
        event_id: randomUUID(),
        agent_id: null,
        kind: parsed.data.kind,
        ts,
        attributes,
      });
      res.status(204).end();
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
