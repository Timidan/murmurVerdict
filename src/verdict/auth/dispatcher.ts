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
import { verifyAgentApiKey } from "../auth.js";
import { verifyHmac } from "../submissions.js";
import { agentsRepo } from "../db.js";
import { getAccountForAgent, verifyApiKey as verifyAccountApiKey } from "./accounts.js";
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
 * Returns null if no auth mode produces a verified identity. Throws
 * ONLY for catastrophic config issues (e.g. DB unavailable mid-lookup) —
 * normal "wrong credentials" returns null so the caller can decide how
 * to surface the failure.
 */
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
      // The Privy claims identify the USER, not necessarily an agent.
      // Phase 4's session route will create/lookup the account and
      // optionally include an agent slug via X-Murmur-Agent-Slug or
      // path param. The dispatcher exposes both so the route handler
      // can decide.
      const slug = req.header("X-Murmur-Agent-Slug");
      let agent_id: string | undefined;
      let agent_kind: AgentKind | undefined;
      if (slug) {
        const agent = agentsRepo.bySlug(deps.db, slug);
        if (agent) {
          agent_id = agent.agent_id;
          agent_kind = agent.kind;
        }
      }
      // We DON'T eagerly upsert the account here — that's the job of
      // the /v1/account/session route. The dispatcher's role is to
      // verify-and-tag, not to mutate state.
      const identity: AuthIdentity = {
        tier: "casual",
        privy: claims,
      };
      if (agent_id !== undefined) {
        identity.agent_id = agent_id;
      }
      if (agent_kind !== undefined) {
        identity.agent_kind = agent_kind;
      }
      return identity;
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
