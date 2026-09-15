// ─── An agent reading back its own submission attempt ───────────────────────
//
//   GET /v2/gateway/attempts/:attempt_id
//
// Lets an agent learn the onchain_call_id of its asynchronously relayed call.
// Auth: runtime key only; requireRuntimeKeyIdentity rejects Privy sessions and account API keys.
// PoP: the route is bodyless, so the dispatcher hashes zero bytes, matching what a client signs for a GET.
// Scoped by agent_id, not runtime_key_id (ON DELETE SET NULL), so key rotation doesn't hide history.
// A miss is 404 whether absent or another agent's, so attempt ids can't be probed.

import type Database from "better-sqlite3";

import {
  dispatchAuth,
  type AuthIdentity,
  type DispatchAuthDeps,
} from "./auth/dispatcher.js";
import { requireRuntimeKeyIdentity } from "./auth/runtime-authorization.js";
import type { PrivyAuthVerifier } from "./auth/privy.js";
import { redactedErrorText } from "../integrations/fhenix-gateway-runtime.js";
import { ERROR_CODES, SCHEMA_VERSION, VerdictError } from "./schema.js";

/** Terminal statuses. Their stored next_attempt_at is stale (never cleared), so it isn't served. */
const TERMINAL_STATUSES: ReadonlySet<string> = new Set(["accepted", "failed_terminal"]);

/** Failure classes say what the caller should do; provider text is too unstable to classify. */
export type GatewayAttemptErrorCode = "submit_retrying" | "submit_failed";

const ERROR_CODES_BY_STATUS: Record<string, GatewayAttemptErrorCode> = {
  failed_retryable: "submit_retrying",
  failed_terminal: "submit_failed",
};

export interface GatewayAttemptRequest {
  header(name: string): string | undefined;
  method?: string;
  originalUrl?: string;
  murmurRawBodySha256?: string;
}

export type GatewayAttemptAuthDispatcher = (
  req: GatewayAttemptRequest,
  deps: DispatchAuthDeps,
) => Promise<AuthIdentity | null>;

export interface GatewayAttemptSurfaceDeps {
  db: Database.Database;
  now: () => Date;
  privyAuth?: PrivyAuthVerifier;
  dispatchAuth?: GatewayAttemptAuthDispatcher;
  popAudience?: string;
}

export interface GatewayAttemptResponse {
  status: number;
  body: unknown;
}

interface AttemptQueryRow {
  attempt_id: string;
  status: string;
  tx_hash: string | null;
  onchain_call_id: string | null;
  call_id: string | null;
  chain_id: number;
  contract_address: string;
  reveal_open_at: string | null;
  next_attempt_at: string | null;
  last_error: string | null;
}

const ATTEMPT_SQL = `
  SELECT attempt_id, status, tx_hash, onchain_call_id, call_id,
         chain_id, contract_address, reveal_open_at, next_attempt_at, last_error
  FROM fhenix_gateway_tx_attempts
  WHERE attempt_id = @attempt_id AND agent_id = @agent_id
  LIMIT 1
`;

export async function gatewayAttemptResponse(input: {
  req: GatewayAttemptRequest;
  deps: GatewayAttemptSurfaceDeps;
  attemptId: string;
}): Promise<GatewayAttemptResponse> {
  const { req, deps } = input;
  const auth = deps.dispatchAuth ?? defaultAttemptAuthDispatcher;
  const authResult = await auth(req, {
    db: deps.db,
    allowRuntimeKey: true,
    now: deps.now,
    privyAuth: deps.privyAuth,
    popAudience: deps.popAudience,
  });
  if (!authResult) {
    throw new VerdictError(
      "gateway attempt reads require X-Murmur-Runtime-Key",
      ERROR_CODES.agent_not_authorized,
      401,
    );
  }
  const identity = requireRuntimeKeyIdentity(
    authResult,
    "gateway attempt reads require X-Murmur-Runtime-Key auth",
  );

  const attemptId = input.attemptId.trim();
  const row = attemptId
    ? (deps.db
        .prepare(ATTEMPT_SQL)
        .get({ attempt_id: attemptId, agent_id: identity.agent_id }) as
        | AttemptQueryRow
        | undefined)
    : undefined;
  if (!row) {
    return {
      status: 404,
      body: { error: "AttemptNotFound", message: "no such attempt for this agent" },
    };
  }

  const terminal = TERMINAL_STATUSES.has(row.status);
  const errorCode = ERROR_CODES_BY_STATUS[row.status] ?? null;
  return {
    status: 200,
    body: {
      schema_version: SCHEMA_VERSION,
      attempt_id: row.attempt_id,
      status: row.status,
      tx_hash: row.tx_hash,
      onchain_call_id: row.onchain_call_id,
      call_id: row.call_id,
      chain_id: row.chain_id,
      contract_address: row.contract_address,
      reveal_open_at: row.reveal_open_at,
      next_attempt_at: terminal ? null : row.next_attempt_at,
      error_code: errorCode,
      // Failures only, always redacted: last_error can embed an RPC URL carrying credentials.
      error: errorCode ? redactedErrorText(row.last_error ?? "") : null,
    },
  };
}

function defaultAttemptAuthDispatcher(
  req: GatewayAttemptRequest,
  deps: DispatchAuthDeps,
): Promise<AuthIdentity | null> {
  return dispatchAuth(req, deps);
}
