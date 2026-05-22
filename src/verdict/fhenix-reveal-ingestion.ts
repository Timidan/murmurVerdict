import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import {
  fhenixSealedCallsRepo,
  marketsRepo,
  submissionsRepo,
  usageRepo,
} from "./db.js";
import {
  ERROR_CODES,
  type UsageEvent,
  VerdictError,
} from "./schema.js";
import type { FhenixEventVerifier } from "../integrations/fhenix-events.js";
import {
  type FhenixInvalidRevealBody,
  type FhenixRevealBody,
  fhenixVerificationToVerdictError,
  requireAgentWalletBinding,
} from "./fhenix-common.js";
import {
  binaryCommitmentFromReveal,
  commitmentToWire,
  outcomeLabelsForMarket,
} from "./market-adapter-config.js";
import { nowIso, parseIsoMs } from "./time.js";

export interface FhenixRevealIngestionDeps {
  db: Database.Database;
  verifier: FhenixEventVerifier;
  now: () => Date;
}

export type FhenixRevealIngestionResult =
  | {
      status: 200;
      body:
        | {
            call_id: string;
            privacy_mode: "sealed_fhenix";
            status: "revealed";
            idempotent_hit: true;
          }
        | {
            call_id: string;
            privacy_mode: "sealed_fhenix";
            status: "revealed";
            revealed_at: string;
            revealed_verdict: {
              binary_index: 0 | 1;
              outcome_label: string;
              confidence_bps: number;
              confidence: number;
            };
          };
    }
  | { status: 404; body: { code: "not_found"; message: "call not found" } };

export type FhenixInvalidRevealIngestionResult =
  | {
      status: 200;
      body:
        | {
            call_id: string;
            privacy_mode: "sealed_fhenix";
            status: "invalid_reveal";
            idempotent_hit: true;
          }
        | {
            call_id: string;
            privacy_mode: "sealed_fhenix";
            status: "invalid_reveal";
            invalid_reason: "binary_index" | "confidence" | "unknown";
            revealed_at: string;
            revealed_verdict: {
              binary_index: number;
              confidence_bps: number;
            };
          };
    }
  | { status: 404; body: { code: "not_found"; message: "call not found" } };

export async function attachValidFhenixReveal(
  deps: FhenixRevealIngestionDeps,
  body: FhenixRevealBody & { reveal_block_number?: number | null },
): Promise<FhenixRevealIngestionResult> {
  const target = loadSealedRevealTarget(deps.db, body.call_id);
  if (target.kind === "not_found") {
    return { status: 404, body: { code: "not_found", message: "call not found" } };
  }
  const { ctx, sealed } = target;
  if (sealed.revealed_at !== null) {
    if (
      sealed.revealed_binary_index === body.binary_index &&
      sealed.revealed_confidence_bps === body.confidence_bps &&
      sealed.reveal_tx_hash === body.reveal_tx_hash.toLowerCase() &&
      sealed.reveal_log_index === body.reveal_log_index
    ) {
      return {
        status: 200,
        body: {
          call_id: body.call_id,
          privacy_mode: "sealed_fhenix",
          status: "revealed",
          idempotent_hit: true,
        },
      };
    }
    throw new VerdictError(
      "call already has a different Fhenix reveal",
      ERROR_CODES.duplicate,
      409,
    );
  }

  if (!ctx.market_id) {
    throw new VerdictError(
      "sealed_fhenix call has no market_id",
      ERROR_CODES.schema_invalid,
      409,
    );
  }
  const revealWallet = requireAgentWalletBinding(
    deps.db,
    ctx.agent_id,
    sealed.chain_id,
  );
  let verifiedReveal;
  try {
    verifiedReveal = await deps.verifier.verifyVerdictRevealed({
      chain_id: sealed.chain_id,
      contract_address: sealed.contract_address,
      onchain_call_id: sealed.onchain_call_id,
      reveal_tx_hash: body.reveal_tx_hash,
      reveal_log_index: body.reveal_log_index,
      binary_index: body.binary_index,
      confidence_bps: body.confidence_bps,
      revealed_at: body.revealed_at,
      expected_agent_wallet: revealWallet.wallet_address,
      expected_market_id: ctx.market_id,
    });
  } catch (err) {
    throw fhenixVerificationToVerdictError(err);
  }

  assertRevealWindowOpen(verifiedReveal.revealed_at, sealed.reveal_open_at, "Fhenix reveal");
  const market = marketsRepo.get(deps.db, ctx.market_id);
  if (!market) {
    throw new VerdictError(
      `unknown market for sealed_fhenix call: ${ctx.market_id}`,
      ERROR_CODES.asset_not_supported,
      404,
    );
  }

  const confidence = verifiedReveal.confidence_bps / 10_000;
  const commitment = binaryCommitmentFromReveal({
    binary_index: verifiedReveal.binary_index,
    confidence,
    market,
    accepted_at: ctx.accepted_at,
  });
  const commitmentWire = commitmentToWire(commitment);
  const outcomeLabels = outcomeLabelsForMarket(market);
  const tx = deps.db.transaction(() => {
    fhenixSealedCallsRepo.attachReveal(deps.db, {
      call_id: body.call_id,
      revealed_binary_index: verifiedReveal.binary_index,
      revealed_confidence: confidence,
      revealed_confidence_bps: verifiedReveal.confidence_bps,
      revealed_at: verifiedReveal.revealed_at,
      reveal_tx_hash: verifiedReveal.reveal_tx_hash,
      reveal_log_index: verifiedReveal.reveal_log_index,
      reveal_block_number: body.reveal_block_number ?? null,
    });
    submissionsRepo.attachRevealedCommitment(deps.db, {
      call_id: body.call_id,
      commitment_json: JSON.stringify(commitmentWire),
      predicted_outcome_json: JSON.stringify(commitmentWire.predictedOutcome),
      outcome_labels_json: JSON.stringify(outcomeLabels),
    });
  });
  tx();

  return {
    status: 200,
    body: {
      call_id: body.call_id,
      privacy_mode: "sealed_fhenix",
      status: "revealed",
      revealed_at: verifiedReveal.revealed_at,
      revealed_verdict: {
        binary_index: verifiedReveal.binary_index,
        outcome_label:
          outcomeLabels[verifiedReveal.binary_index] ??
          `outcome_${verifiedReveal.binary_index}`,
        confidence_bps: verifiedReveal.confidence_bps,
        confidence,
      },
    },
  };
}

export async function attachInvalidFhenixReveal(
  deps: FhenixRevealIngestionDeps,
  body: FhenixInvalidRevealBody & { reveal_block_number?: number | null },
): Promise<FhenixInvalidRevealIngestionResult> {
  const target = loadSealedRevealTarget(deps.db, body.call_id);
  if (target.kind === "not_found") {
    return { status: 404, body: { code: "not_found", message: "call not found" } };
  }
  const { ctx, sealed } = target;
  if (sealed.reveal_status === "invalid" && sealed.revealed_at !== null) {
    if (
      sealed.revealed_binary_index === body.binary_index &&
      sealed.revealed_confidence_bps === body.confidence_bps &&
      sealed.invalid_reason === body.invalid_reason &&
      sealed.reveal_tx_hash === body.reveal_tx_hash.toLowerCase() &&
      sealed.reveal_log_index === body.reveal_log_index
    ) {
      return {
        status: 200,
        body: {
          call_id: body.call_id,
          privacy_mode: "sealed_fhenix",
          status: "invalid_reveal",
          idempotent_hit: true,
        },
      };
    }
    throw new VerdictError(
      "call already has a different Fhenix invalid reveal",
      ERROR_CODES.duplicate,
      409,
    );
  }
  if (sealed.revealed_at !== null || sealed.reveal_status !== "pending") {
    throw new VerdictError(
      "call already has a terminal Fhenix reveal status",
      ERROR_CODES.duplicate,
      409,
      { reveal_status: sealed.reveal_status },
    );
  }
  if (!ctx.market_id) {
    throw new VerdictError(
      "sealed_fhenix call has no market_id",
      ERROR_CODES.schema_invalid,
      409,
    );
  }

  const revealWallet = requireAgentWalletBinding(
    deps.db,
    ctx.agent_id,
    sealed.chain_id,
  );
  let verifiedInvalid;
  try {
    verifiedInvalid = await deps.verifier.verifyVerdictRevealInvalid({
      chain_id: sealed.chain_id,
      contract_address: sealed.contract_address,
      onchain_call_id: sealed.onchain_call_id,
      reveal_tx_hash: body.reveal_tx_hash,
      reveal_log_index: body.reveal_log_index,
      binary_index: body.binary_index,
      confidence_bps: body.confidence_bps,
      invalid_reason: body.invalid_reason,
      revealed_at: body.revealed_at,
      expected_agent_wallet: revealWallet.wallet_address,
      expected_market_id: ctx.market_id,
    });
  } catch (err) {
    throw fhenixVerificationToVerdictError(err);
  }

  assertRevealWindowOpen(
    verifiedInvalid.revealed_at,
    sealed.reveal_open_at,
    "Fhenix invalid reveal",
  );

  const tx = deps.db.transaction(() => {
    fhenixSealedCallsRepo.attachInvalidReveal(deps.db, {
      call_id: body.call_id,
      revealed_binary_index: verifiedInvalid.binary_index,
      revealed_confidence_bps: verifiedInvalid.confidence_bps,
      invalid_reason: verifiedInvalid.invalid_reason,
      revealed_at: verifiedInvalid.revealed_at,
      reveal_tx_hash: verifiedInvalid.reveal_tx_hash,
      reveal_log_index: verifiedInvalid.reveal_log_index,
      reveal_block_number: body.reveal_block_number ?? null,
    });
    submissionsRepo.setStatus(deps.db, body.call_id, "invalid_reveal");
    usageRepo.emit(
      deps.db,
      makeUsage(ctx.agent_id, "resolution_completed", {
        call_id: body.call_id,
        outcome: "invalid_reveal",
        invalid_reason: verifiedInvalid.invalid_reason,
      }, deps.now),
    );
  });
  tx();

  return {
    status: 200,
    body: {
      call_id: body.call_id,
      privacy_mode: "sealed_fhenix",
      status: "invalid_reveal",
      invalid_reason: verifiedInvalid.invalid_reason,
      revealed_at: verifiedInvalid.revealed_at,
      revealed_verdict: {
        binary_index: verifiedInvalid.binary_index,
        confidence_bps: verifiedInvalid.confidence_bps,
      },
    },
  };
}

export function markMissedFhenixReveals(input: {
  db: Database.Database;
  cutoffIso: string;
  terminalAt: string;
  now: () => Date;
}): number {
  const rows = fhenixSealedCallsRepo.listMissable(input.db, input.cutoffIso);
  let marked = 0;
  for (const row of rows) {
    const changed = input.db.transaction(() => {
      const ok = fhenixSealedCallsRepo.markMissedReveal(input.db, {
        call_id: row.call_id,
        terminal_at: input.terminalAt,
        invalid_reason: "reveal_timeout",
      });
      if (!ok) return false;
      submissionsRepo.setStatus(input.db, row.call_id, "missed_reveal");
      usageRepo.emit(
        input.db,
        makeUsage(row.agent_id, "resolution_completed", {
          call_id: row.call_id,
          outcome: "missed_reveal",
        }, input.now),
      );
      return true;
    })();
    if (changed) marked++;
  }
  return marked;
}

type SealedRevealTarget =
  | { kind: "not_found" }
  | {
      kind: "sealed";
      ctx: NonNullable<ReturnType<typeof submissionsRepo.loadResolverContext>>;
      sealed: NonNullable<ReturnType<typeof fhenixSealedCallsRepo.byCallId>>;
    };

function loadSealedRevealTarget(
  db: Database.Database,
  callId: string,
): SealedRevealTarget {
  const ctx = submissionsRepo.loadResolverContext(db, callId);
  if (!ctx) return { kind: "not_found" };
  if (ctx.privacy_mode !== "sealed_fhenix") {
    throw new VerdictError(
      "call is not a sealed_fhenix submission",
      ERROR_CODES.schema_invalid,
      409,
      { privacy_mode: ctx.privacy_mode },
    );
  }
  const sealed = fhenixSealedCallsRepo.byCallId(db, callId);
  if (!sealed) {
    throw new VerdictError(
      "sealed_fhenix metadata missing for call",
      ERROR_CODES.schema_invalid,
      409,
    );
  }
  return { kind: "sealed", ctx, sealed };
}

function assertRevealWindowOpen(
  revealedAt: string,
  revealOpenAt: string,
  label: string,
): void {
  const revealedAtMs = parseIsoMs(revealedAt, "revealed_at");
  const revealOpenMs = parseIsoMs(revealOpenAt, "reveal_open_at");
  if (revealedAtMs >= revealOpenMs) return;
  throw new VerdictError(
    `${label} cannot be attached before reveal_open_at`,
    ERROR_CODES.schema_invalid,
    400,
    {
      revealed_at: revealedAt,
      reveal_open_at: revealOpenAt,
    },
  );
}

function makeUsage(
  agent_id: string,
  kind: UsageEvent["kind"],
  attributes: Record<string, unknown>,
  now: () => Date,
): UsageEvent {
  return {
    event_id: randomUUID(),
    agent_id,
    kind,
    ts: nowIso(now()),
    attributes,
  };
}
