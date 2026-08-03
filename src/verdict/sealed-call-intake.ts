import type Database from "better-sqlite3";
import { z } from "zod";
import {
  marketsRepo,
} from "./repos/market-registry-repo.js";
import { usageRepo } from "./repos/usage-events-repo.js";
import { CommitmentSchema } from "./markets-core.js";
import {
  ERROR_CODES,
  VerdictError,
} from "./schema.js";
import { getMarketMakerRegistry } from "./market-maker/registry.js";
import type { AuthIdentity as DispatchedAuthIdentity } from "./auth/dispatcher.js";
import type { FhenixEventVerifier } from "../integrations/fhenix-events.js";
import {
  FhenixSubmitEventSchema,
  fhenixVerificationToVerdictError,
  normalizeFhenixSubmitEvent,
  requireAgentWalletBinding,
} from "./fhenix-common.js";
import {
  acceptSealedCall,
  makeSealedCallUsage,
  type AcceptSealedCallResult,
  type SealedCallIdAdapter,
} from "./sealed-call-acceptance.js";

export const V2SubmissionBodySchema = z
  .object({
    marketRef: CommitmentSchema.shape.marketRef,
    client_order_id: z.string().min(8).max(128),
    rationale: z.string().max(240).optional(),
    strategy_tag: z.string().min(2).max(32).optional(),
    submitted_at: z
      .string()
      .datetime({ offset: false })
      .optional(),
    privacy_mode: z.literal("sealed_fhenix"),
    fhenix: FhenixSubmitEventSchema,
  })
  .strict()
  .superRefine((v, ctx) => {
    if (!v.rationale && !v.strategy_tag) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "rationale or strategy_tag is required",
        path: ["rationale"],
      });
    }
  });

export type V2SubmissionBody = z.infer<typeof V2SubmissionBodySchema>;

export interface AcceptSealedCallParams {
  db: Database.Database;
  authResult: DispatchedAuthIdentity;
  bodyJson: unknown;
  fhenixVerifier: FhenixEventVerifier | null;
  newCallId?: SealedCallIdAdapter;
  now: () => Date;
}

export type { AcceptSealedCallResult };

export async function acceptSealedCallMetadata(
  params: AcceptSealedCallParams,
): Promise<AcceptSealedCallResult> {
  const { db, authResult, bodyJson, now } = params;
  if (authResult.agent_kind === "attested") {
    throw new VerdictError(
      "attested-tier admin Fhenix backfill is not yet supported",
      ERROR_CODES.agent_not_authorized,
      503,
    );
  }
  if (!authResult.agent_id) {
    throw new VerdictError(
      "X-Murmur-Agent-Slug header required: account owns no default agent",
      ERROR_CODES.agent_slug_required,
      400,
    );
  }
  const agentId = authResult.agent_id;

  const objectBody = isRecord(bodyJson) ? bodyJson : {};
  const modeHint =
    typeof objectBody.privacy_mode === "string"
      ? objectBody.privacy_mode
      : undefined;
  const cleartextAttempt =
    modeHint === "legacy_plaintext" ||
    objectBody.predictedOutcome !== undefined ||
    objectBody.horizon !== undefined ||
    objectBody.confidence !== undefined;
  const retiredFheDirectAttempt =
    modeHint === "fhe_direct" || objectBody.fhe !== undefined;
  if (cleartextAttempt || retiredFheDirectAttempt) {
    usageRepo.emit(
      db,
      makeSealedCallUsage(
        agentId,
        "submission_rejected",
        { reason: cleartextAttempt ? "plaintext_retired" : "fhe_direct_retired" },
        now,
      ),
    );
    throw new VerdictError(
      cleartextAttempt
        ? "plaintext submissions are retired; use /v2/gateway/calls with sealed Fhenix inputs"
        : "privacy_mode='fhe_direct' is retired; use /v2/gateway/calls with sealed Fhenix inputs",
      ERROR_CODES.schema_invalid,
      410,
      { accepted_privacy_mode: "sealed_fhenix" },
    );
  }

  const parsed = V2SubmissionBodySchema.safeParse(bodyJson);
  if (!parsed.success) {
    usageRepo.emit(
      db,
      makeSealedCallUsage(
        agentId,
        "submission_rejected",
        { reason: "schema_invalid" },
        now,
      ),
    );
    throw new VerdictError(
      "v2 submission failed schema validation",
      ERROR_CODES.schema_invalid,
      400,
      { issues: parsed.error.format() },
    );
  }
  const body = parsed.data;

  const adapter = getMarketMakerRegistry().get(body.marketRef.protocol);
  if (!adapter) {
    throw new VerdictError(
      `unsupported marketRef.protocol: '${body.marketRef.protocol}'`,
      ERROR_CODES.asset_not_supported,
      422,
      { protocol: body.marketRef.protocol },
    );
  }

  const market = marketsRepo.get(db, body.marketRef.sourceId);
  if (!market) {
    throw new VerdictError(
      `unknown market: marketRef.sourceId='${body.marketRef.sourceId}' (no row in markets registry)`,
      ERROR_CODES.asset_not_supported,
      404,
      { sourceId: body.marketRef.sourceId },
    );
  }

  // Fail closed: a market with no explicit adapter cannot own a submission.
  const expectedProtocol = market.adapter_id;
  if (!expectedProtocol) {
    throw new VerdictError(
      `market '${market.market_id}' has no adapter_id and cannot accept calls`,
      ERROR_CODES.asset_not_supported,
      400,
      { sourceId: body.marketRef.sourceId },
    );
  }
  if (body.marketRef.protocol !== expectedProtocol) {
    throw new VerdictError(
      `marketRef.protocol mismatch: agent supplied '${body.marketRef.protocol}' but market '${market.market_id}' is owned by adapter '${expectedProtocol}'`,
      ERROR_CODES.schema_invalid,
      400,
      {
        supplied_protocol: body.marketRef.protocol,
        market_adapter_id: expectedProtocol,
        sourceId: body.marketRef.sourceId,
      },
    );
  }

  const verifier = requireFhenixVerifier(params.fhenixVerifier);
  const fhenixEvent = normalizeFhenixSubmitEvent(body.fhenix);
  const walletBinding = requireAgentWalletBinding(db, agentId, fhenixEvent.chain_id);
  try {
    const verifiedSubmit = await verifier.verifySealedCallSubmitted({
      ...fhenixEvent,
      accepted_at: body.fhenix.accepted_at,
      reveal_open_at: body.fhenix.reveal_open_at,
      expected_agent_wallet: walletBinding.wallet_address,
      expected_market_id: market.market_id,
    });
    return acceptSealedCall({
      db,
      authResult,
      market,
      client_order_id: body.client_order_id,
      submitted_at: body.submitted_at,
      rationale: body.rationale,
      strategy_tag: body.strategy_tag,
      verifiedSubmit,
      newCallId: params.newCallId,
      now,
    });
  } catch (err) {
    throw fhenixVerificationToVerdictError(err);
  }
}

function requireFhenixVerifier(
  verifier: FhenixEventVerifier | null,
): FhenixEventVerifier {
  if (!verifier) {
    throw new VerdictError(
      "Fhenix chain verifier is not configured; set FHENIX_RPC_URL before accepting sealed calls",
      ERROR_CODES.oracle_unavailable,
      503,
    );
  }
  return verifier;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
