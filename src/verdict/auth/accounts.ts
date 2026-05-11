// ─── Account & API-key repositories (V2 §7.1 casual tier scaffold) ─────────
//
// Sibling to agentsRepo / verifiedIdentitiesRepo in db.ts — but lives in a
// separate module because the auth tier is a higher-level concept than
// the agent table (an account can own N agents; an agent has at most one
// owning account in v2.0). Keeping these repos here also keeps db.ts from
// growing unbounded.
//
// All functions take a Database.Database and run synchronously against
// better-sqlite3 prepared statements. The async surface in privy.ts is
// the only async boundary in the auth path; the DB writes themselves stay
// sync so the dispatcher (auth/dispatcher.ts) can compose them inside an
// async wrapper without juggling two async layers.
//
// SCAFFOLD ONLY — Phase 4 wires these into the submit dispatcher and the
// accountRouter. Today nothing imports these symbols from the daemon
// path; the test harness in __account_smoke__.ts is the only consumer.

import type Database from "better-sqlite3";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { PrivyClaims } from "./privy.js";

// ─── Types ────────────────────────────────────────────────────────────────

export interface AccountRow {
  account_id: string;
  privy_user_id: string;
  email: string | null;
  primary_login_method: string | null;
  created_at: string;
  last_seen_at: string;
}

export interface AccountAgentLink {
  account_id: string;
  agent_id: string;
  created_at: string;
}

export interface ApiKeyRow {
  api_key_id: string;
  account_id: string;
  agent_id: string;
  api_key_hash: string;
  label: string | null;
  created_at: string;
  rotated_at: string | null;
}

export interface MintApiKeyResult {
  api_key_id: string;
  /** Plaintext secret. Returned ONCE — caller MUST hand to the user and not persist. */
  secret: string;
  created_at: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function nowIso(): string {
  // Match the rest of the codebase: stripped fractional seconds, Z suffix.
  return new Date().toISOString().replace(/\.\d+Z$/, "Z");
}

/**
 * Compute the canonical hash for an API-key secret. Identical to
 * submissions.hashSharedSecret() but duplicated locally so the auth
 * scaffold has no inbound dep on the legacy submissions module — keeps
 * the v2 cutover surface narrow.
 */
function hashApiKeySecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

// ─── accountsRepo ─────────────────────────────────────────────────────────

/**
 * Upsert-by-privy-user-id. Returns the account_id (existing or newly
 * created) and a flag indicating whether this call created the row.
 *
 * The flag matters for the /v1/account/session route — first-time
 * creation triggers the onboarding UX (set destination_address, mint
 * first API key) while returning users skip straight to the dashboard.
 */
export function getOrCreateAccount(
  db: Database.Database,
  claims: PrivyClaims,
): { account_id: string; created: boolean } {
  // FIX 6 — wrap the SELECT-then-(UPDATE | INSERT) sequence in a
  // transaction so concurrent /session callers for the same Privy
  // user don't race past the existence check. The UNIQUE on
  // privy_user_id is the DB-level backstop; the txn closes the
  // application-level window.
  const txn = db.transaction(() => {
    const existing = db
      .prepare(
        "SELECT account_id FROM accounts WHERE privy_user_id = ?",
      )
      .get(claims.privy_user_id) as { account_id: string } | undefined;

    if (existing) {
      db.prepare(
        "UPDATE accounts SET last_seen_at = ? WHERE account_id = ?",
      ).run(nowIso(), existing.account_id);
      return { account_id: existing.account_id, created: false };
    }

    const account_id = randomUUID();
    const ts = nowIso();
    db.prepare(
      `INSERT INTO accounts (
         account_id, privy_user_id, email, primary_login_method,
         created_at, last_seen_at
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      account_id,
      claims.privy_user_id,
      claims.email ?? null,
      claims.primary_login_method ?? null,
      ts,
      ts,
    );
    return { account_id, created: true };
  });
  return txn();
}

export function getAccountById(
  db: Database.Database,
  account_id: string,
): AccountRow | null {
  const row = db
    .prepare("SELECT * FROM accounts WHERE account_id = ?")
    .get(account_id) as AccountRow | undefined;
  return row ?? null;
}

/**
 * Read-only lookup by Privy DID. Used by the auth dispatcher, which
 * must NOT create rows on the verify-and-tag path — only the explicit
 * /v1/account/session route is allowed to upsert. Returns null when
 * the user has never opened a session.
 */
export function getAccountByPrivyUserId(
  db: Database.Database,
  privy_user_id: string,
): AccountRow | null {
  const row = db
    .prepare("SELECT * FROM accounts WHERE privy_user_id = ?")
    .get(privy_user_id) as AccountRow | undefined;
  return row ?? null;
}

// ─── account_agents bridge ────────────────────────────────────────────────

/**
 * BLOCKER #4 — agent ownership transfer attempt. Thrown by
 * linkAgentToAccount when the agent is already linked to a DIFFERENT
 * account. Distinct from a generic insert error so the caller can
 * surface a precise 409 to the API edge.
 */
export class AgentAlreadyOwnedError extends Error {
  /** Stable error code for API responses + tests. */
  readonly code = "agent_already_owned_by_another_account" as const;
  readonly agent_id: string;

  constructor(agent_id: string) {
    super(
      `agent ${agent_id} is already owned by a different account`,
    );
    this.name = "AgentAlreadyOwnedError";
    this.agent_id = agent_id;
  }
}

/**
 * Link an agent to an account, enforcing the one-account-per-agent
 * invariant (V2 §7.1, BLOCKER #4). Behavior:
 *   - No existing link → INSERT.
 *   - Existing link to the SAME account → no-op (idempotent).
 *   - Existing link to a DIFFERENT account → throw AgentAlreadyOwnedError.
 *
 * The pre-SELECT closes the race that "INSERT OR IGNORE" left open: with
 * IGNORE alone, a concurrent request that already linked agent X to
 * account A would silently succeed for account B's request (because the
 * PRIMARY KEY in M017 was on the pair). Migration 019 adds UNIQUE(agent_id)
 * which makes the DB authoritative; this code layer is the early-fail
 * fast path so callers don't have to parse SQLite UNIQUE error messages.
 */
export function linkAgentToAccount(
  db: Database.Database,
  account_id: string,
  agent_id: string,
): void {
  const txn = db.transaction(() => {
    const existing = db
      .prepare(
        "SELECT account_id FROM account_agents WHERE agent_id = ? LIMIT 1",
      )
      .get(agent_id) as { account_id: string } | undefined;
    if (existing) {
      if (existing.account_id === account_id) {
        // Idempotent re-link by the same owner. No-op.
        return;
      }
      throw new AgentAlreadyOwnedError(agent_id);
    }
    db.prepare(
      `INSERT INTO account_agents (account_id, agent_id, created_at)
       VALUES (?, ?, ?)`,
    ).run(account_id, agent_id, nowIso());
  });
  txn();
}

export function listAccountAgents(
  db: Database.Database,
  account_id: string,
): Array<{ agent_id: string; created_at: string }> {
  return db
    .prepare(
      `SELECT agent_id, created_at FROM account_agents
       WHERE account_id = ?
       ORDER BY created_at ASC`,
    )
    .all(account_id) as Array<{ agent_id: string; created_at: string }>;
}

/**
 * Returns the owning account_id for an agent, or null if unowned.
 *
 * v2.0 enforces a single-owner-per-agent invariant in code: minting a
 * casual-tier agent runs linkAgentToAccount() exactly once; existing
 * wallet-only / benchmark agents have NO account row and return null
 * here — those tiers stay on the legacy auth path.
 *
 * If the schema ever permits multi-owner (e.g. team accounts), this
 * function would need to either return an array or be split into
 * "primary owner" vs "co-owners". Both shapes are forward-compatible
 * with the current bridge table.
 */
export function getAccountForAgent(
  db: Database.Database,
  agent_id: string,
): string | null {
  const row = db
    .prepare(
      "SELECT account_id FROM account_agents WHERE agent_id = ? LIMIT 1",
    )
    .get(agent_id) as { account_id: string } | undefined;
  return row?.account_id ?? null;
}

// ─── api_keys ─────────────────────────────────────────────────────────────

/**
 * Mint a new API key for the (account, agent) pair. Generates 32 random
 * bytes, hex-encodes (64 chars), stores sha256 of the hex string. Returns
 * the plaintext exactly once — the caller is responsible for handing it
 * to the user and never persisting it.
 *
 * NOTE: the secret is returned as the hex form, not as base64 or as the
 * raw bytes, to match the existing agents.api_key_hash discipline (see
 * submissions.hashSharedSecret) so verification semantics line up if a
 * client is migrated between auth modes.
 */
export function mintApiKey(
  db: Database.Database,
  account_id: string,
  agent_id: string,
  label?: string,
): MintApiKeyResult {
  const secret = randomBytes(32).toString("hex");
  const api_key_id = randomUUID();
  const created_at = nowIso();
  db.prepare(
    `INSERT INTO api_keys (
       api_key_id, account_id, agent_id, api_key_hash,
       label, created_at, rotated_at
     ) VALUES (?, ?, ?, ?, ?, ?, NULL)`,
  ).run(
    api_key_id,
    account_id,
    agent_id,
    hashApiKeySecret(secret),
    label ?? null,
    created_at,
  );
  return { api_key_id, secret, created_at };
}

/**
 * Constant-time-ish lookup-by-hash. SQLite doesn't expose constant-time
 * comparison on its own, but the timing-leak surface here is "did this
 * hash exist in the table" — which is a hash of the secret, so an
 * attacker would have to first guess the hash to learn anything. The
 * timingSafeEqual on the second-stage column compare protects against
 * the smaller leak of "two valid keys collided in their first N bytes."
 */
export function verifyApiKey(
  db: Database.Database,
  secret: string,
): { account_id: string; agent_id: string; api_key_id: string } | null {
  if (typeof secret !== "string" || secret.length < 16) {
    return null;
  }
  const hash = hashApiKeySecret(secret);
  const row = db
    .prepare(
      `SELECT api_key_id, account_id, agent_id, api_key_hash
       FROM api_keys
       WHERE api_key_hash = ? AND rotated_at IS NULL`,
    )
    .get(hash) as
    | { api_key_id: string; account_id: string; agent_id: string; api_key_hash: string }
    | undefined;
  if (!row) {
    return null;
  }
  // Defence-in-depth — we already matched on equality in SQL but a
  // future schema change could relax that to a prefix match. The
  // timingSafeEqual stays correct under both shapes.
  const a = Buffer.from(row.api_key_hash, "hex");
  const b = Buffer.from(hash, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return null;
  }
  return {
    account_id: row.account_id,
    agent_id: row.agent_id,
    api_key_id: row.api_key_id,
  };
}

/**
 * Soft-rotate: set rotated_at on the row. Future verifyApiKey() calls
 * filter WHERE rotated_at IS NULL so the key is invalidated without
 * losing audit history.
 *
 * Idempotent — rotating an already-rotated key is a no-op (the WHERE
 * rotated_at IS NULL guards prevents double-stamping).
 */
export function rotateApiKey(
  db: Database.Database,
  api_key_id: string,
): boolean {
  const result = db
    .prepare(
      "UPDATE api_keys SET rotated_at = ? WHERE api_key_id = ? AND rotated_at IS NULL",
    )
    .run(nowIso(), api_key_id);
  return result.changes > 0;
}

export function listApiKeysForAccount(
  db: Database.Database,
  account_id: string,
  includeRotated = false,
): Array<Omit<ApiKeyRow, "api_key_hash">> {
  const sql = includeRotated
    ? `SELECT api_key_id, account_id, agent_id, label, created_at, rotated_at
       FROM api_keys WHERE account_id = ?
       ORDER BY created_at DESC`
    : `SELECT api_key_id, account_id, agent_id, label, created_at, rotated_at
       FROM api_keys WHERE account_id = ? AND rotated_at IS NULL
       ORDER BY created_at DESC`;
  return db.prepare(sql).all(account_id) as Array<
    Omit<ApiKeyRow, "api_key_hash">
  >;
}

// ─── destination_address (V2 §7.4) ───────────────────────────────────────

/**
 * Cooldown for destination_address updates — V2 §7.4. 24h hard window
 * to prevent compromise-then-drain attacks.
 *
 * Exported as a constant so tests can monkey-patch it via DI rather than
 * sleeping through a real 24h window. Tests pass a smaller value via
 * the optional `cooldownMs` arg on setDestinationAddress().
 */
export const DESTINATION_ADDRESS_COOLDOWN_MS = 24 * 60 * 60 * 1000;

export interface SetDestinationResult {
  ok: boolean;
  /**
   * When ok=false, this is set to 'cooldown_active' or 'agent_not_found'.
   */
  reason?: "cooldown_active" | "agent_not_found";
  /** Seconds until the cooldown clears (only when reason='cooldown_active'). */
  retry_after_seconds?: number;
  /** Previous destination_address, surfaced on ok=true so the caller can
   *  emit the §7.7 risk-1 audit event with both old + new values. Null when
   *  the agent had no prior destination_address bound. */
  previous_address?: string | null;
  /** ISO8601 timestamp the new value was written at, surfaced for the audit
   *  event. Matches the `destination_address_updated_at` column write. */
  updated_at?: string;
}

/**
 * Set/update an agent's destination_address with the §7.4 24h cooldown.
 *
 * Reads the existing destination_address_updated_at, rejects if the last
 * update was within the cooldown window, and otherwise writes the new
 * value + bumps the timestamp. Wraps both reads and the write in a
 * transaction so a concurrent caller can't race past the check.
 *
 * Caller responsibilities (NOT enforced here):
 *   - Address normalization (viem getAddress + toLowerCase()) — the
 *     scaffold's auth dispatcher will run this at the API edge.
 *   - Account ownership of the agent — verify via getAccountForAgent
 *     before invoking this fn.
 */
export function setDestinationAddress(
  db: Database.Database,
  agent_id: string,
  destination_address: string,
  opts: { cooldownMs?: number; now?: () => Date } = {},
): SetDestinationResult {
  const cooldownMs = opts.cooldownMs ?? DESTINATION_ADDRESS_COOLDOWN_MS;
  const now = (opts.now ?? (() => new Date()))();

  const txn = db.transaction(() => {
    const row = db
      .prepare(
        "SELECT destination_address, destination_address_updated_at FROM agents WHERE agent_id = ?",
      )
      .get(agent_id) as
      | {
          destination_address: string | null;
          destination_address_updated_at: string | null;
        }
      | undefined;
    if (!row) {
      return { ok: false as const, reason: "agent_not_found" as const };
    }
    if (row.destination_address_updated_at) {
      const last = Date.parse(row.destination_address_updated_at);
      if (Number.isFinite(last)) {
        const elapsed = now.getTime() - last;
        if (elapsed < cooldownMs) {
          const retry = Math.ceil((cooldownMs - elapsed) / 1000);
          return {
            ok: false as const,
            reason: "cooldown_active" as const,
            retry_after_seconds: retry,
          };
        }
      }
    }
    const ts = now.toISOString().replace(/\.\d+Z$/, "Z");
    db.prepare(
      `UPDATE agents
       SET destination_address = ?, destination_address_updated_at = ?
       WHERE agent_id = ?`,
    ).run(destination_address, ts, agent_id);
    return {
      ok: true as const,
      previous_address: row.destination_address,
      updated_at: ts,
    };
  });

  return txn();
}
