// ─── Tier-aware auth dispatcher (V2 §7.5) — SCAFFOLD ONLY ──────────────────
//
// One async entry point that maps an inbound HTTP request to a tier-tagged
// identity, falling through three auth modes in order:
//
//   1. Authorization: Bearer <privy-token>   → Privy session  → tier='casual'
//   2. X-Murmur-Api-Key                      → DB-stored hash → tier='casual'
//                                                                or 'legacy'
//   3. X-Murmur-Agent-Id + X-Murmur-Signature → HMAC v0.1     → tier='wallet_legacy'
//
// Returns null when none of the three auth modes succeed. The caller (the
// route handler in api.ts after Phase 4 wires this in) is responsible for
// translating null → 403 with an appropriate ErrorCode.
//
// This module DOES NOT touch the existing auth at api.ts:136-178. It will
// be wired in by Phase 4. The shape below is the contract Phase 4 will
// integrate against — keep it stable.
//
// Why async at the dispatcher level:
//   verifyPrivyAuth is async (jose's jwtVerify uses Web Crypto under
//   the hood). The legacy paths (verifyAgentApiKey, verifyHmac) are
//   sync. We keep the dispatcher async so it composes both styles
//   without forcing the legacy callers to also become async — they
//   stay reusable as-is.
//
// Why HMAC verification needs the raw body:
//   verifyHmac signs `${timestamp}\n${rawBody}`. Express buffers the
//   parsed JSON; the raw text is only available inside a route that
//   uses express.text() middleware. The dispatcher takes the raw body
//   as an explicit parameter — Phase 4's route handler hands it in.

import type Database from "better-sqlite3";
import type { Request } from "express";
import type { AgentKind } from "../schema.js";
import { ERROR_CODES, VerdictError } from "../schema.js";
import { verifyAgentApiKey } from "../auth.js";
import { verifyHmac } from "../submissions.js";
import { agentsRepo } from "../db.js";
import {
  getAccountByPrivyUserId,
  getAccountForAgent,
  listAccountAgents,
  verifyApiKey as verifyAccountApiKey,
} from "./accounts.js";
import { verifyPrivyAuth, type PrivyClaims } from "./privy.js";

export type AuthTier =
  // Privy-backed account or scoped account API key.
  | "casual"
  // Agent has an api_key_hash on the agent row but no account binding —
  // pre-Phase-4 keys, will phase out.
  | "legacy"
  // HMAC-per-call against the resolveSharedSecret callback. Used by
  // benchmark/internal_test agents whose secrets live in env vars.
  // Phase 8 replaces this for actual wallet-tier agents with EIP-712.
  | "wallet_legacy";

export interface AuthIdentity {
  tier: AuthTier;
  /**
   * The agent the request is acting AS. May be undefined for the very
   * narrow case of /v1/account/session where the user hasn't created
   * any agents yet.
   */
  agent_id?: string;
  /** Set when tier='casual' and the auth path was Privy or account API key. */
  account_id?: string;
  /** Privy claims, present only when the Privy path succeeded. */
  privy?: PrivyClaims;
  /** Mirror of the agent's kind, for dispatch in submit handlers. */
  agent_kind?: AgentKind;
}

export interface DispatchAuthDeps {
  db: Database.Database;
  /**
   * Required for the legacy HMAC path. Phase 4 passes the same callback
   * api.ts currently uses (`deps.resolveSharedSecret`).
   */
  resolveSharedSecret?: (agent_id: string) => Promise<string | null>;
  /**
   * Required for HMAC. Express's body-parser strips this; routes that
   * want HMAC support must use express.text() and forward req.body.
   */
  rawBody?: string;
  /** Clock injection for tests. */
  now?: () => Date;
}

/**
 * Dispatch a request to the highest-priority matching auth tier.
 *
 * Three return shapes:
 *   - AuthIdentity  — a verified identity (the request is good).
 *   - null          — no auth mode produced a verified identity. The
 *                     caller (Phase 4 route handler) translates to 401.
 *   - throws VerdictError — the Bearer token verified, but the agent
 *                     selection is policy-illegal (unowned slug, missing
 *                     slug when account owns >1 agent, ...). The caller
 *                     translates to 403/400 using the embedded code.
 *
 * Why throw instead of return null on the unowned-slug path:
 *   If we returned null, the dispatcher would silently fall through to
 *   the API-key and HMAC modes, giving an attacker who held a valid
 *   Privy token a free shot at also brute-forcing those. Throwing
 *   short-circuits the dispatcher — once you authenticated as Account A
 *   and asked to act as agent B, you don't get a second auth chance.
 */
/**
 * Internal: resolve a verified Privy bearer to an AuthIdentity, applying
 * the §7.1 ownership policy. Pure — no Privy verification, no env reads.
 * Exported (with __ prefix) so the smoke test can drive every branch
 * without minting real Privy tokens. Not part of the public auth surface.
 *
 * Throws VerdictError on policy rejections; returns AuthIdentity on
 * success. Never returns null — the caller (dispatchAuth) only invokes
 * this function once verifyPrivyAuth returned non-null claims.
 */
export function __resolveCasualIdentity(
  db: Database.Database,
  claims: PrivyClaims,
  slug: string | undefined,
): AuthIdentity {
  const account = getAccountByPrivyUserId(db, claims.privy_user_id);
  const account_id = account?.account_id;

  // ─── Path A: explicit slug provided ──────────────────────────
  if (slug) {
    const agent = agentsRepo.bySlug(db, slug);
    if (!agent) {
      // Don't leak which slug exists by returning agent_not_owned;
      // unknown_agent is the same code we use for non-existent
      // submissions agents.
      throw new VerdictError(
        "unknown agent slug",
        ERROR_CODES.unknown_agent,
        404,
      );
    }
    // Ownership enforcement — the heart of BLOCKER #3. Must run
    // BEFORE we return anything, and must NOT fall through to
    // other auth modes if it fails.
    if (!account_id) {
      throw new VerdictError(
        "Privy user has no account; call /v1/account/session first",
        ERROR_CODES.agent_not_owned_by_account,
        403,
      );
    }
    const owner = getAccountForAgent(db, agent.agent_id);
    if (owner !== account_id) {
      throw new VerdictError(
        "agent not owned by this account",
        ERROR_CODES.agent_not_owned_by_account,
        403,
      );
    }
    return {
      tier: "casual",
      privy: claims,
      agent_id: agent.agent_id,
      agent_kind: agent.kind,
      account_id,
    };
  }

  // ─── Path B: no slug — derive from account's owned agents ───
  if (!account_id) {
    // No session yet → only account-management routes can run. Return
    // tier='casual' with no agent binding; the route layer gates which
    // routes accept this shape (POST /session, POST /agents create the
    // first agent, GET /agents list).
    return { tier: "casual", privy: claims };
  }
  const owned = listAccountAgents(db, account_id);
  if (owned.length === 0) {
    // Account exists but has no agents yet — same shape as above.
    return { tier: "casual", privy: claims, account_id };
  }
  if (owned.length === 1 && owned[0]) {
    // Smart default: single-agent accounts don't need to set the
    // header on every call.
    const agent = agentsRepo.byId(db, owned[0].agent_id);
    const out: AuthIdentity = {
      tier: "casual",
      privy: claims,
      account_id,
      agent_id: owned[0].agent_id,
    };
    if (agent) out.agent_kind = agent.kind;
    return out;
  }
  // Multi-agent account with no header → ambiguous. Reject so the
  // operator must decide which agent acts. Falling back to "first
  // alphabetically" or similar would mask user error.
  throw new VerdictError(
    "X-Murmur-Agent-Slug header required: account owns multiple agents",
    ERROR_CODES.agent_slug_required,
    400,
  );
}

export async function dispatchAuth(
  req: Request,
  deps: DispatchAuthDeps,
): Promise<AuthIdentity | null> {
  // ─── Mode 1: Authorization: Bearer <privy-token> ─────────────────────
  const authzHeader = req.header("Authorization") ?? req.header("authorization");
  if (authzHeader && /^Bearer\s+/i.test(authzHeader)) {
    const token = authzHeader.replace(/^Bearer\s+/i, "").trim();
    const claims = await verifyPrivyAuth(token);
    if (claims) {
      const slug = req.header("X-Murmur-Agent-Slug");
      // Delegate post-verify policy to the pure function so the smoke
      // suite can exercise every branch without minting a real token.
      return __resolveCasualIdentity(deps.db, claims, slug);
    }
    // Bearer present but failed Privy verification — fall through to
    // other modes rather than 403. A client that sends both Bearer +
    // X-Murmur-Api-Key still gets a chance to authenticate via the
    // second header. (Whether to allow that downgrade is a Phase-4
    // policy call.)
  }

  // ─── Mode 2: X-Murmur-Api-Key ────────────────────────────────────────
  const apiKey = req.header("X-Murmur-Api-Key");
  if (apiKey) {
    // First try the new account-scoped api_keys table.
    const accountKey = verifyAccountApiKey(deps.db, apiKey);
    if (accountKey) {
      const agent = agentsRepo.byId(deps.db, accountKey.agent_id);
      const out: AuthIdentity = {
        tier: "casual",
        agent_id: accountKey.agent_id,
        account_id: accountKey.account_id,
      };
      if (agent) {
        out.agent_kind = agent.kind;
      }
      return out;
    }
    // Fall back to the legacy single-key-per-agent path. This requires
    // X-Murmur-Agent-Id alongside the key (matches api.ts:149).
    const headerAgentId = req.header("X-Murmur-Agent-Id");
    if (headerAgentId) {
      try {
        const id = verifyAgentApiKey(deps.db, headerAgentId, apiKey);
        const agent = agentsRepo.byId(deps.db, id.agent_id);
        const account_id = getAccountForAgent(deps.db, id.agent_id);
        const tier: AuthTier = account_id ? "casual" : "legacy";
        const out: AuthIdentity = { tier, agent_id: id.agent_id };
        if (account_id) {
          out.account_id = account_id;
        }
        if (agent) {
          out.agent_kind = agent.kind;
        }
        return out;
      } catch {
        // Wrong key for that agent — fall through to HMAC mode.
      }
    }
  }

  // ─── Mode 3: X-Murmur-Agent-Id + X-Murmur-Signature (HMAC) ──────────
  const hmacAgentId = req.header("X-Murmur-Agent-Id");
  const hmacTimestamp = req.header("X-Murmur-Timestamp");
  const hmacSignature = req.header("X-Murmur-Signature");
  if (hmacAgentId && hmacTimestamp && hmacSignature && deps.resolveSharedSecret) {
    const secret = await deps.resolveSharedSecret(hmacAgentId);
    if (secret) {
      try {
        verifyHmac({
          rawBody: deps.rawBody ?? "",
          headers: {
            agent_id: hmacAgentId,
            timestamp: hmacTimestamp,
            signature: hmacSignature,
          },
          shared_secret: secret,
          ...(deps.now ? { now: deps.now } : {}),
        });
        const agent = agentsRepo.byId(deps.db, hmacAgentId);
        const out: AuthIdentity = {
          tier: "wallet_legacy",
          agent_id: hmacAgentId,
        };
        if (agent) {
          out.agent_kind = agent.kind;
        }
        return out;
      } catch {
        // Invalid signature / timestamp — drop through to null.
      }
    }
  }

  return null;
}
