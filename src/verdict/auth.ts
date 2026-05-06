import { timingSafeEqual } from "node:crypto";
import type Database from "better-sqlite3";
import { agentsRepo } from "./db.js";
import { ERROR_CODES, VerdictError } from "./schema.js";
import { hashSharedSecret } from "./submissions.js";

// ─── Bearer-API-key auth ─────────────────────────────────────────────────────
//
// Claimed agents receive a 32-byte hex API key from the claim flow. Only the
// hash is stored on the agent row (`agents.api_key_hash`). At verification
// time we recompute the hash against the candidate key and constant-time
// compare. This is the production auth path for external agents — the legacy
// HMAC-per-call route in [submissions.ts] is preserved for benchmark agents
// whose secrets sit in env vars rather than the DB.

export interface AuthIdentityResolution {
  agent_id: string;
}

export function verifyAgentApiKey(
  db: Database.Database,
  agent_id: string,
  candidate_key: string,
): AuthIdentityResolution {
  const row = agentsRepo.byId(db, agent_id);
  if (!row) {
    throw new VerdictError(
      "unknown agent",
      ERROR_CODES.unknown_agent,
      404,
    );
  }
  if (!row.api_key_hash) {
    throw new VerdictError(
      "agent has no api_key (must claim first)",
      ERROR_CODES.agent_not_authorized,
      403,
    );
  }
  if (typeof candidate_key !== "string" || candidate_key.length < 16) {
    throw new VerdictError(
      "missing or malformed api key",
      ERROR_CODES.agent_not_authorized,
      403,
    );
  }
  const candidate_hash = hashSharedSecret(candidate_key);
  const a = Buffer.from(row.api_key_hash, "hex");
  const b = Buffer.from(candidate_hash, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new VerdictError(
      "api key did not verify",
      ERROR_CODES.agent_not_authorized,
      403,
    );
  }
  return { agent_id };
}
