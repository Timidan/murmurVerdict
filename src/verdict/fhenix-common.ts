import type Database from "better-sqlite3";
import { z } from "zod";
import { agentsRepo } from "./db.js";
import { ERROR_CODES, VerdictError } from "./schema.js";
import {
  FhenixEventVerificationError,
} from "../integrations/fhenix-events.js";

export const Hex20Schema = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
export const Hex32Schema = z.string().regex(/^0x[0-9a-fA-F]{64}$/);

export const FhenixSubmitEventSchema = z
  .object({
    chain_id: z.number().int().positive(),
    contract_address: Hex20Schema,
    onchain_call_id: Hex32Schema,
    submit_tx_hash: Hex32Schema,
    submit_log_index: z.number().int().nonnegative(),
    binary_index_ct_hash: Hex32Schema,
    confidence_ct_hash: Hex32Schema,
    accepted_at: z.string().datetime({ offset: false }),
    reveal_open_at: z.string().datetime({ offset: false }),
  })
  .strict();

export const FhenixRevealBodySchema = z
  .object({
    call_id: z.string().uuid(),
    binary_index: z.union([z.literal(0), z.literal(1)]),
    confidence_bps: z.number().int().min(5100).max(9500),
    revealed_at: z.string().datetime({ offset: false }),
    reveal_tx_hash: Hex32Schema,
    reveal_log_index: z.number().int().nonnegative(),
  })
  .strict();

export const FhenixInvalidRevealBodySchema = z
  .object({
    call_id: z.string().uuid(),
    binary_index: z.number().int().min(0).max(255),
    confidence_bps: z.number().int().min(0).max(65_535),
    invalid_reason: z.enum(["binary_index", "confidence", "unknown"]),
    revealed_at: z.string().datetime({ offset: false }),
    reveal_tx_hash: Hex32Schema,
    reveal_log_index: z.number().int().nonnegative(),
  })
  .strict();

export type FhenixSubmitEvent = z.infer<typeof FhenixSubmitEventSchema>;
export type FhenixRevealBody = z.infer<typeof FhenixRevealBodySchema>;
export type FhenixInvalidRevealBody = z.infer<typeof FhenixInvalidRevealBodySchema>;

export function normalizeFhenixSubmitEvent(input: FhenixSubmitEvent): {
  chain_id: number;
  contract_address: string;
  onchain_call_id: string;
  submit_tx_hash: string;
  submit_log_index: number;
  binary_index_ct_hash: string;
  confidence_ct_hash: string;
} {
  return {
    chain_id: input.chain_id,
    contract_address: input.contract_address.toLowerCase(),
    onchain_call_id: input.onchain_call_id.toLowerCase(),
    submit_tx_hash: input.submit_tx_hash.toLowerCase(),
    submit_log_index: input.submit_log_index,
    binary_index_ct_hash: input.binary_index_ct_hash.toLowerCase(),
    confidence_ct_hash: input.confidence_ct_hash.toLowerCase(),
  };
}

export function requireAgentWalletBinding(
  db: Database.Database,
  agentId: string,
  chainId: number,
): { wallet_address: string; chain_id: string } {
  const agent = agentsRepo.byId(db, agentId);
  const expectedChainId = `eip155:${chainId}`;
  if (!agent?.wallet_address || !agent.chain_id) {
    throw new VerdictError(
      "agent must bind a wallet before submitting Fhenix-sealed calls",
      ERROR_CODES.agent_not_authorized,
      403,
      { agent_id: agentId, expected_chain_id: expectedChainId },
    );
  }
  if (agent.chain_id !== expectedChainId) {
    throw new VerdictError(
      "agent wallet chain_id does not match Fhenix event chain_id",
      ERROR_CODES.agent_not_authorized,
      403,
      {
        agent_id: agentId,
        agent_chain_id: agent.chain_id,
        fhenix_chain_id: expectedChainId,
      },
    );
  }
  return {
    wallet_address: agent.wallet_address,
    chain_id: agent.chain_id,
  };
}

export function fhenixVerificationToVerdictError(err: unknown): VerdictError {
  if (err instanceof FhenixEventVerificationError) {
    const status = err.kind === "rpc_failure" || err.kind === "not_configured"
      ? 503
      : err.kind === "log_not_found"
        ? 404
        : 400;
    return new VerdictError(
      err.message,
      status === 503 ? ERROR_CODES.oracle_unavailable : ERROR_CODES.schema_invalid,
      status,
      { fhenix_error: err.kind, ...err.context },
    );
  }
  return err instanceof VerdictError
    ? err
    : new VerdictError(
        err instanceof Error ? err.message : String(err),
        ERROR_CODES.internal_error,
        500,
      );
}
