// ─── An agent reading back its own submission attempt ───────────────────────
//
//   GET /v2/gateway/attempts/:attempt_id
//
// Closes a real gap in the SDK: POST /v2/gateway/calls returns an attempt id
// and the relay happens asynchronously, so until now an agent had NO way to
// learn the `onchain_call_id` its own call was assigned. Without it the agent
// cannot reference its call on-chain, cannot link it, and cannot tell whether
// the submission landed at all — the id existed only in the daemon's tables.
//
// AUTH — runtime key ONLY.
//
// dispatchAuth(allowRuntimeKey) alone is not enough: it also accepts a Privy
// session and an account API key, which are HUMAN dashboard credentials.
// Attempt state belongs to the agent runtime, so the identity is passed
// through requireRuntimeKeyIdentity, which rejects everything else.
//
// PoP-bound keys sign method + path + body hash. This route is bodyless, and
// the dispatcher substitutes the sha256 of zero bytes when express records no
// raw body, which is exactly what a client signs for a GET.
//
// SCOPE — agent_id, never runtime_key_id.
//
// `fhenix_gateway_tx_attempts.runtime_key_id` is ON DELETE SET NULL, so
// scoping to the key would hide an agent's own history the moment the key that
// made it was rotated or revoked — precisely when an operator is most likely
// to be looking. The agent is the durable owner.
//
// A miss is 404 whether the attempt does not exist or belongs to someone else.
// Separating the two would turn this into an oracle for probing other agents'
// attempt ids.

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

/**
 * Statuses after which no further attempt is scheduled.
 *
 * `next_attempt_at` is NOT NULL in storage and the terminal transitions do not
 * clear it — markAccepted only sets status and call_id — so the stored value
 * is a stale watermark from the last retry schedule. Serving it would tell an
 * agent to wait for work that will never run.
 */
const TERMINAL_STATUSES: ReadonlySet<string> = new Set(["accepted", "failed_terminal"]);

/**
 * Stable, machine-readable failure classes.
 *
 * Deliberately about what the caller should DO, not about which RPC failed.
 * The underlying provider text is free-form and changes with provider
 * versions; classifying it into "insufficient funds" / "nonce gap" style codes
 * would be guesswork that silently starts mislabelling after an upgrade. The
 * human-readable (redacted) message carries the detail.
 */
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
      // Only on a failure, and only ever redacted. `last_error` can embed a
      // provider URL whose path or query carries operator RPC credentials, and
      // `last_rpc_error` is raw transport diagnostics that is never served at
      // all. A stale error left on a since-succeeded attempt is also withheld:
      // the status is the answer there.
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
