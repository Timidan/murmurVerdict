import type Database from "better-sqlite3";

import { fhenixGatewayTxRepo } from "../repos/fhenix-gateway-tx-repo.js";
import { submissionsRepo } from "../repos/sealed-call-submissions-repo.js";
import { ERROR_CODES, VerdictError } from "../schema.js";
import { isoFromMs } from "../time.js";
import type { AuthIdentity } from "./dispatcher.js";
import type { RuntimeKeyVerification } from "./accounts.js";
import {
  parseRuntimeKeyGatewayPolicyJson,
  type RuntimeKeyGatewayPolicy,
} from "./runtime-key-policy.js";
export type { RuntimeKeyGatewayPolicy } from "./runtime-key-policy.js";

export interface RuntimeKeyIdentity {
  agent_id: string;
  account_id: string;
  runtime_key: RuntimeKeyVerification;
}

export type RuntimeKeyGatewayIntent =
  | {
      kind: "sealed_call";
      chain_id: number;
      market_id: string;
    }
  | {
      kind: "feed_packet";
      chain_id: number;
      market_id: string | null;
    };

export interface RuntimeKeyAuthorization {
  identity: RuntimeKeyIdentity;
  policy: RuntimeKeyGatewayPolicy;
}

export interface RuntimeKeyAcceptanceIdentityInput {
  account_id: string;
  agent_id: string;
  runtime_key_id: string | null;
  runtime_key_policy_json: string;
  runtime_key_policy_hash: string;
  controller_wallet_address: string;
  controller_chain_id: string;
}

export function runtimeKeyAcceptanceAuthIdentity(
  input: RuntimeKeyAcceptanceIdentityInput,
): AuthIdentity {
  return {
    tier: "casual",
    auth_mode: "runtime_key",
    agent_id: input.agent_id,
    account_id: input.account_id,
    runtime_key: {
      runtime_key_id: input.runtime_key_id ?? "",
      account_id: input.account_id,
      agent_id: input.agent_id,
      runtime_key_prefix: "",
      policy_json: input.runtime_key_policy_json,
      policy_hash: input.runtime_key_policy_hash,
      controller_wallet_address: input.controller_wallet_address,
      controller_chain_id: input.controller_chain_id,
      expires_at: null,
    },
  };
}

export function requireRuntimeKeyIdentity(
  authResult: AuthIdentity,
  message = "gateway submissions require X-Murmur-Runtime-Key auth",
): RuntimeKeyIdentity {
  if (
    authResult.auth_mode !== "runtime_key" ||
    !authResult.runtime_key ||
    !authResult.agent_id ||
    !authResult.account_id
  ) {
    throw new VerdictError(
      message,
      ERROR_CODES.agent_not_authorized,
      401,
    );
  }
  return {
    agent_id: authResult.agent_id,
    account_id: authResult.account_id,
    runtime_key: authResult.runtime_key,
  };
}

export function authorizeRuntimeKeyGatewayIntent(
  db: Database.Database,
  identity: RuntimeKeyIdentity,
  intent: RuntimeKeyGatewayIntent,
  opts: { now: () => Date },
): RuntimeKeyAuthorization {
  const runtimeKey = identity.runtime_key;
  const expectedChainId = `eip155:${intent.chain_id}`;
  if (runtimeKey.controller_chain_id !== expectedChainId) {
    throw new VerdictError(
      "Runtime Key controller chain does not match Gateway Fhenix chain",
      ERROR_CODES.agent_not_authorized,
      403,
      {
        expected_chain_id: expectedChainId,
        runtime_key_chain_id: runtimeKey.controller_chain_id,
      },
    );
  }

  const policy = parseRuntimeKeyPolicy(runtimeKey);
  const marketId = intent.market_id;
  if (
    marketId &&
    policy.allowed_market_ids &&
    policy.allowed_market_ids.length > 0 &&
    !policy.allowed_market_ids.includes(marketId)
  ) {
    throw new VerdictError(
      intent.kind === "feed_packet"
        ? "Runtime Key policy does not allow this feed packet market"
        : "Runtime Key policy does not allow this market",
      ERROR_CODES.agent_not_authorized,
      403,
      {
        runtime_key_id: runtimeKey.runtime_key_id,
        policy_hash: runtimeKey.policy_hash,
        market_id: marketId,
      },
    );
  }

  if (intent.kind === "feed_packet" && policy.feed_packets !== true) {
    throw new VerdictError(
      "Runtime Key policy does not allow feed packets",
      ERROR_CODES.agent_not_authorized,
      403,
      {
        runtime_key_id: runtimeKey.runtime_key_id,
        policy_hash: runtimeKey.policy_hash,
      },
    );
  }

  if (intent.kind === "sealed_call") {
    enforceSealedCallRateLimits(db, runtimeKey, policy, opts.now);
  }

  return { identity, policy };
}

function parseRuntimeKeyPolicy(
  runtimeKey: RuntimeKeyVerification,
): RuntimeKeyGatewayPolicy {
  try {
    return parseRuntimeKeyGatewayPolicyJson(runtimeKey.policy_json);
  } catch (err) {
    throw new VerdictError(
      "Runtime Key policy is invalid; revoke and mint a new key",
      ERROR_CODES.agent_not_authorized,
      403,
      {
        runtime_key_id: runtimeKey.runtime_key_id,
        error: err instanceof Error ? err.message : String(err),
      },
    );
  }
}

function enforceSealedCallRateLimits(
  db: Database.Database,
  runtimeKey: RuntimeKeyVerification,
  policy: RuntimeKeyGatewayPolicy,
  now: () => Date,
): void {
  if (policy.max_calls_per_hour !== undefined) {
    const since = isoFromMs(now().getTime() - 60 * 60 * 1000);
    const count =
      submissionsRepo.countCallsForRuntimeKeyWindow(db, runtimeKey.runtime_key_id, since) +
      fhenixGatewayTxRepo.countInflightByRuntimeKeyWindow(db, runtimeKey.runtime_key_id, since);
    if (count >= policy.max_calls_per_hour) {
      throw new VerdictError(
        "Runtime Key hourly call limit exceeded",
        ERROR_CODES.rate_limited,
        429,
        {
          runtime_key_id: runtimeKey.runtime_key_id,
          policy_hash: runtimeKey.policy_hash,
          limit: policy.max_calls_per_hour,
        },
      );
    }
  }

  if (policy.max_calls_per_day !== undefined) {
    const since = isoFromMs(now().getTime() - 24 * 60 * 60 * 1000);
    const count =
      submissionsRepo.countCallsForRuntimeKeyWindow(db, runtimeKey.runtime_key_id, since) +
      fhenixGatewayTxRepo.countInflightByRuntimeKeyWindow(db, runtimeKey.runtime_key_id, since);
    if (count >= policy.max_calls_per_day) {
      throw new VerdictError(
        "Runtime Key daily call limit exceeded",
        ERROR_CODES.rate_limited,
        429,
        {
          runtime_key_id: runtimeKey.runtime_key_id,
          policy_hash: runtimeKey.policy_hash,
          limit: policy.max_calls_per_day,
        },
      );
    }
  }
}
