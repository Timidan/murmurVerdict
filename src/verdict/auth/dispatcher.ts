// ─── Tier-aware auth dispatcher (V2 §7.5) ──────────────────────────────────
//
// One async entry point that maps an inbound HTTP request to a tier-tagged
// identity, falling through three auth modes in order:
//
//   1. Authorization: Bearer <privy-token>   → Privy session
//   2. X-Murmur-Runtime-Key                  → Gateway runtime key (explicit opt-in)
//   3. X-Murmur-Api-Key                      → account-scoped DB hash
//
// Returns null when neither auth mode succeeds. The caller is responsible
// for translating null into the route-specific auth response.
//
// Why async at the dispatcher level:
//   Privy verification is async (jose's jwtVerify uses Web Crypto under the
//   hood). The API-key path is sync. We keep the dispatcher async so route
//   handlers can compose both without special casing Privy.

import type Database from "better-sqlite3";
import type { Request } from "express";
import type { AgentKind } from "../schema.js";
import { ERROR_CODES, VerdictError } from "../schema.js";
import { agentsRepo } from "../repos/agents-repo.js";
import {
  getAccountForAgent,
  listAccountAgents,
  resolveAccountForClaims,
  verifyApiKey as verifyAccountApiKey,
  verifyRuntimeKey,
  type RuntimeKeyVerification,
} from "./accounts.js";
import { verifyPrivyBearer, type PrivyAuthVerifier, type PrivyClaims } from "./privy.js";

export type AuthTier = "casual";

export interface AuthIdentity {
  tier: AuthTier;
  auth_mode?: "privy" | "api_key" | "runtime_key";
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
  /** Runtime-key metadata, present only when auth_mode='runtime_key'. */
  runtime_key?: RuntimeKeyVerification;
}

export interface DispatchAuthDeps {
  db: Database.Database;
  /** Caller-supplied auth read instant for Runtime Key verification. */
  now: () => Date;
  /** Runtime Keys are powerful bot credentials; routes must opt in. */
  allowRuntimeKey?: boolean;
  /** Explicit Privy verifier Adapter. Daemon callers should pass this. */
  privyAuth?: PrivyAuthVerifier;
}

/**
 * Dispatch a request to the highest-priority matching auth tier.
 *
 * Two return shapes:
 *   - AuthIdentity  — a verified identity (the request is good).
 *   - null          — no auth mode produced a verified identity. The
 *                     caller translates to 401.
 *   - throws VerdictError — the Bearer token verified, but the agent
 *                     selection is policy-illegal (unowned slug, missing
 *                     slug when account owns >1 agent, ...). The caller
 *                     translates to 403/400 using the embedded code.
 *
 * Why throw instead of return null on the unowned-slug path:
 *   If we returned null, the dispatcher would silently fall through to
 *   API-key auth, giving an attacker who held a valid Privy token a second
 *   auth chance. Throwing short-circuits the dispatcher once you
 *   authenticated as Account A and asked to act as agent B.
 */
/**
 * Internal: resolve a verified Privy bearer to an AuthIdentity, applying
 * the §7.1 ownership policy. Pure — no Privy verification, no env reads.
 * Exported (with __ prefix) so the smoke test can drive every branch
 * without minting real Privy tokens. Not part of the public auth surface.
 *
 * Throws VerdictError on policy rejections; returns AuthIdentity on
 * success. Never returns null — the caller (dispatchAuth) only invokes
 * this function once the caller-supplied PrivyAuthVerifier returned non-null
 * claims.
 */
export function __resolveCasualIdentity(
  db: Database.Database,
  claims: PrivyClaims,
  slug: string | undefined,
): AuthIdentity {
  // READ-only account lookup: dispatch auth (gateway/feed) must never create
  // an account as a side effect. The explicit "read" mode makes that a named
  // contract rather than an inline call choice.
  const account_id = resolveAccountForClaims(db, claims, { mode: "read" }).account_id ?? undefined;

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
      auth_mode: "privy",
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
    return { tier: "casual", auth_mode: "privy", privy: claims };
  }
  const owned = listAccountAgents(db, account_id);
  if (owned.length === 0) {
    // Account exists but has no agents yet — same shape as above.
    return { tier: "casual", auth_mode: "privy", privy: claims, account_id };
  }
  if (owned.length === 1 && owned[0]) {
    // Smart default: single-agent accounts don't need to set the
    // header on every call.
    const agent = agentsRepo.byId(db, owned[0].agent_id);
    const out: AuthIdentity = {
      tier: "casual",
      auth_mode: "privy",
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
  // verifyPrivyBearer returns null when there is no verifier, no/non-Bearer
  // header, or the token fails verification — every case that should fall
  // through to the other modes rather than 403. A client that sends both
  // Bearer + X-Murmur-Api-Key still gets a chance via the second header.
  const claims = await verifyPrivyBearer(req, deps.privyAuth);
  if (claims) {
    const slug = req.header("X-Murmur-Agent-Slug");
    // Delegate post-verify policy to the pure function so the smoke
    // suite can exercise every branch without minting a real token.
    return __resolveCasualIdentity(deps.db, claims, slug);
  }

  // ─── Mode 2: X-Murmur-Runtime-Key ────────────────────────────────────
  const runtimeKey = req.header("X-Murmur-Runtime-Key");
  if (deps.allowRuntimeKey && runtimeKey) {
    const verifiedAt = deps.now();
    const verified = verifyRuntimeKey(deps.db, {
      secret: runtimeKey,
      verifiedAt,
    });
    if (verified) {
      const agent = agentsRepo.byId(deps.db, verified.agent_id);
      const slug = req.header("X-Murmur-Agent-Slug");
      if (slug && agent && slug !== agent.display_slug) {
        throw new VerdictError(
          "X-Murmur-Agent-Slug does not match Runtime Key agent",
          ERROR_CODES.agent_not_owned_by_account,
          403,
        );
      }
      const out: AuthIdentity = {
        tier: "casual",
        auth_mode: "runtime_key",
        agent_id: verified.agent_id,
        account_id: verified.account_id,
        runtime_key: verified,
      };
      if (agent) {
        out.agent_kind = agent.kind;
      }
      return out;
    }
  }

  // ─── Mode 3: X-Murmur-Api-Key ────────────────────────────────────────
  const apiKey = req.header("X-Murmur-Api-Key");
  if (apiKey) {
    // First try the new account-scoped api_keys table.
    const accountKey = verifyAccountApiKey(deps.db, apiKey);
    if (accountKey) {
      const agent = agentsRepo.byId(deps.db, accountKey.agent_id);
      const out: AuthIdentity = {
        tier: "casual",
        auth_mode: "api_key",
        agent_id: accountKey.agent_id,
        account_id: accountKey.account_id,
      };
      if (agent) {
        out.agent_kind = agent.kind;
      }
      return out;
    }
  }

  return null;
}
