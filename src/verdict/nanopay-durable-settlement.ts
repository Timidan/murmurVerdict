import type { PaymentRequest } from "../integrations/circle-gateway.js";
import {
  paymentPayloadHash,
  paymentRequirementsHash,
  type GatewayMiddleware,
  type GatewayPaymentRequirements,
} from "../integrations/circle-gateway.js";
import { canonicalize } from "../receipts/canonical.js";
import type { NanopayRouterDeps } from "./nanopay-types.js";
import {
  nanopayReceiptsRepo,
  type NanopayReceiptRow,
} from "./repos/nanopay-receipts-repo.js";
import {
  computeRequestSignalId,
  serializeBinding,
  serializeRevealArtifact,
  type NanopayBinding,
} from "./single-stream-binding.js";

type SettledPayment = NonNullable<PaymentRequest["payment"]>;

export type DurableNanopayResult =
  | { kind: "paid"; payment: SettledPayment }
  | {
      kind: "error";
      status: number;
      body: { error: string; message?: string; reason?: string };
      retryAfterSeconds?: number;
    };

export interface DurableNanopayInput {
  deps: NanopayRouterDeps;
  gateway: GatewayMiddleware;
  pipelineId: string;
  paymentHeader: string;
}

interface ParsedPayment {
  paymentPayload: Record<string, unknown>;
  accepted: GatewayPaymentRequirements;
  payer: `0x${string}`;
  nonce: `0x${string}`;
}

/**
 * Verify → persist intent → settle → conditionally finalize. An error after the intent insert
 * leaves the row `settling`: Circle may have settled, so only a reconciler decides its terminal state.
 */
export async function processDurableNanopay(
  input: DurableNanopayInput,
): Promise<DurableNanopayResult> {
  const parsed = parsePaymentHeader(input.paymentHeader);
  if (!parsed) {
    return error(400, "MalformedPayment", "PAYMENT-SIGNATURE is not valid x402 JSON");
  }

  const verifier = parsed.accepted.extra?.verifyingContract;
  if (typeof verifier !== "string" || !isAddress(verifier)) {
    return error(400, "MalformedPayment", "accepted requirements omit verifyingContract");
  }
  const sourceDomain = `caip2:${parsed.accepted.network}:${verifier.toLowerCase()}`;
  const paymentHandle = parsed.nonce.toLowerCase();
  const payloadHash = paymentPayloadHash(parsed.paymentPayload);
  // Circle's requirements do not include the resource URL/pipeline. Bind the
  // persisted fingerprint to Murmur's path parameter so one signed nonce
  // cannot retrieve a different pipeline with identical price + recipient.
  const requirementsHash = paymentRequirementsHash({
    pipelineId: input.pipelineId,
    paymentRequirements: parsed.accepted,
  });
  const receiptKey = {
    payer: parsed.payer,
    paymentHandle,
    sourceDomain,
  };

  const existing = nanopayReceiptsRepo.findByPayerHandleDomain(
    input.deps.db,
    receiptKey,
  );
  if (existing) {
    return classifyExisting(existing, {
      payloadHash,
      requirementsHash,
      network: parsed.accepted.network,
    });
  }

  const pipeline = input.deps.resolvePipeline(input.pipelineId);
  const sealedCall = input.deps.resolveLatestSealedCall(input.pipelineId);
  if (!pipeline || !sealedCall) {
    return error(
      503,
      "PreflightStateChanged",
      "pipeline became unavailable before payment verification",
    );
  }
  if (
    parsed.accepted.amount !== pipeline.priceAtoms ||
    parsed.accepted.payTo.toLowerCase() !== input.deps.sellerAddress.toLowerCase()
  ) {
    return error(402, "PaymentRequirementsMismatch", "payment does not match this pipeline");
  }

  let canonicalRequirements: GatewayPaymentRequirements | null;
  try {
    canonicalRequirements = await input.gateway.paymentRequirements(
      pipeline.priceAtoms,
      parsed.accepted.network,
    );
  } catch (err) {
    return gatewayUnavailable(err);
  }
  if (
    !canonicalRequirements ||
    canonicalize(canonicalRequirements) !== canonicalize(parsed.accepted)
  ) {
    return error(
      402,
      "PaymentRequirementsMismatch",
      "payment requirements are not the canonical server challenge",
    );
  }

  let verifyResult: Awaited<ReturnType<GatewayMiddleware["verify"]>>;
  try {
    verifyResult = await input.gateway.verify(
      parsed.paymentPayload,
      canonicalRequirements,
    );
  } catch (err) {
    return gatewayUnavailable(err);
  }
  if (!verifyResult.valid) {
    return {
      kind: "error",
      status: 402,
      body: {
        error: "PaymentVerificationFailed",
        ...(verifyResult.error ? { reason: verifyResult.error } : {}),
      },
    };
  }
  if (
    verifyResult.payer &&
    verifyResult.payer.toLowerCase() !== parsed.payer.toLowerCase()
  ) {
    return error(402, "PaymentVerificationFailed", "verified payer does not match authorization");
  }

  const requestSignalId = computeRequestSignalId({
    pipelineId: input.pipelineId as `0x${string}`,
    buyer: parsed.payer,
    eip3009Nonce: parsed.nonce,
    domain: input.deps.bindingDomain,
  });
  const pendingBinding: NanopayBinding = {
    pipelineId: input.pipelineId as `0x${string}`,
    buyerAddress: parsed.payer,
    requestSignalId,
    eip3009Nonce: parsed.nonce,
    circleTransactionUuid: null,
    anchor: sealedCall.anchor,
  };

  let receiptId: number;
  try {
    receiptId = nanopayReceiptsRepo.insertSettlingIntent(input.deps.db, {
      payer: parsed.payer,
      paymentHandle,
      sourceDomain,
      paymentPayloadHash: payloadHash,
      paymentRequirementsHash: requirementsHash,
      pipelineId: input.pipelineId,
      requestSignalId,
      paidAmountUsdcAtoms: canonicalRequirements.amount,
      bindingJson: serializeBinding(pendingBinding),
      revealArtifactJson: serializeRevealArtifact(sealedCall.revealArtifact),
      createdAt: input.deps.now(),
    });
  } catch (err) {
    if (!isSqliteUniqueViolation(err)) throw err;
    const raced = nanopayReceiptsRepo.findByPayerHandleDomain(
      input.deps.db,
      receiptKey,
    );
    if (!raced) {
      return error(500, "InternalStateInconsistent", "duplicate intent has no receipt row");
    }
    return classifyExisting(raced, {
      payloadHash,
      requirementsHash,
      network: canonicalRequirements.network,
    });
  }

  let settleResult: Awaited<ReturnType<GatewayMiddleware["settle"]>>;
  try {
    settleResult = await input.gateway.settle(
      parsed.paymentPayload,
      canonicalRequirements,
    );
  } catch (err) {
    console.warn(`[nanopay] settlement status unknown: ${messageFrom(err)}`);
    return pendingUnknown("Settlement is still being confirmed. Retry shortly.");
  }
  if (!settleResult.success) {
    nanopayReceiptsRepo.markFailed(input.deps.db, {
      id: receiptId,
      reason: settleResult.error ?? "Circle rejected settlement",
      failedAt: input.deps.now(),
    });
    return {
      kind: "error",
      status: 402,
      body: {
        error: "PaymentSettlementFailed",
        ...(settleResult.error ? { reason: settleResult.error } : {}),
      },
    };
  }
  if (!settleResult.transaction) {
    return pendingUnknown("Circle reported success without a transaction UUID");
  }
  if (
    (settleResult.payer &&
      settleResult.payer.toLowerCase() !== parsed.payer.toLowerCase()) ||
    (settleResult.network && settleResult.network !== canonicalRequirements.network)
  ) {
    return pendingUnknown("Circle settlement identity did not match the verified payment");
  }

  const settledBinding: NanopayBinding = {
    ...pendingBinding,
    circleTransactionUuid: settleResult.transaction,
  };
  try {
    nanopayReceiptsRepo.markSettled(input.deps.db, {
      id: receiptId,
      circleTransactionUuid: settleResult.transaction,
      bindingJson: serializeBinding(settledBinding),
      revealArtifactJson: serializeRevealArtifact(sealedCall.revealArtifact),
      settledAt: input.deps.now(),
    });
  } catch {
    const current = nanopayReceiptsRepo.findById(input.deps.db, receiptId);
    if (
      !current ||
      current.status !== "settled" ||
      current.circle_transaction_uuid !== settleResult.transaction
    ) {
      return pendingUnknown("local receipt could not be finalized after settlement");
    }
  }

  return {
    kind: "paid",
    payment: {
      verified: true,
      payer: parsed.payer,
      amount: canonicalRequirements.amount,
      network: canonicalRequirements.network,
      transaction: settleResult.transaction,
      receiptId,
      replayed: false,
    },
  };
}

function classifyExisting(
  row: NanopayReceiptRow,
  expected: { payloadHash: string; requirementsHash: string; network: string },
): DurableNanopayResult {
  if (
    row.payment_payload_hash !== expected.payloadHash ||
    row.payment_requirements_hash !== expected.requirementsHash
  ) {
    return error(
      409,
      "PaymentReplayConflict",
      "payment nonce was already used with different payment data",
    );
  }
  if (row.status === "settled" && row.circle_transaction_uuid) {
    return {
      kind: "paid",
      payment: {
        verified: true,
        payer: row.payer,
        amount: row.paid_amount_usdc_atoms,
        network: expected.network,
        transaction: row.circle_transaction_uuid,
        receiptId: row.id,
        replayed: true,
      },
    };
  }
  if (row.status === "failed") {
    return error(
      402,
      "PaymentPreviouslyFailed",
      "this authorization already failed; submit a fresh nonce",
    );
  }
  return pendingUnknown("payment settlement is pending authoritative reconciliation");
}

function parsePaymentHeader(header: string): ParsedPayment | null {
  try {
    const decoded = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as unknown;
    if (!isRecord(decoded) || !isRecord(decoded.accepted) || !isRecord(decoded.payload)) {
      return null;
    }
    const accepted = decoded.accepted;
    const authorization = isRecord(decoded.payload.authorization)
      ? decoded.payload.authorization
      : null;
    if (
      !authorization ||
      !isAddress(authorization.from) ||
      !isBytes32(authorization.nonce) ||
      accepted.scheme !== "exact" ||
      typeof accepted.network !== "string" ||
      !isAddress(accepted.asset) ||
      typeof accepted.amount !== "string" ||
      !/^\d+$/.test(accepted.amount) ||
      !isAddress(accepted.payTo) ||
      typeof accepted.maxTimeoutSeconds !== "number" ||
      !isRecord(accepted.extra)
    ) {
      return null;
    }
    return {
      paymentPayload: decoded,
      accepted: accepted as unknown as GatewayPaymentRequirements,
      payer: authorization.from.toLowerCase() as `0x${string}`,
      nonce: authorization.nonce.toLowerCase() as `0x${string}`,
    };
  } catch {
    return null;
  }
}

function pendingUnknown(message: string): DurableNanopayResult {
  return {
    kind: "error",
    status: 503,
    body: { error: "PaymentSettlementPending", message },
    retryAfterSeconds: 60,
  };
}

function error(
  status: number,
  code: string,
  message?: string,
): DurableNanopayResult {
  return {
    kind: "error",
    status,
    body: { error: code, ...(message ? { message } : {}) },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAddress(value: unknown): value is `0x${string}` {
  return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value);
}

function isBytes32(value: unknown): value is `0x${string}` {
  return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value);
}

function isSqliteUniqueViolation(err: unknown): boolean {
  return Boolean(
    err &&
      typeof err === "object" &&
      "code" in err &&
      (err as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE",
  );
}

/** Logs the provider's message and returns one the buyer can safely see. */
function gatewayUnavailable(err: unknown): DurableNanopayResult {
  console.warn(`[nanopay] payment gateway error: ${messageFrom(err)}`);
  return error(503, "PaymentGatewayUnavailable", "The payment service is unavailable. Try again shortly.");
}

function messageFrom(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
