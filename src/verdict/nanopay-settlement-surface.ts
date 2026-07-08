import type { PaymentRequest } from "../integrations/circle-gateway.js";
import {
  paymentPayloadHash,
  paymentRequirementsHash,
} from "../integrations/circle-gateway.js";
import type { NanopayRouterDeps } from "./nanopay-types.js";
import {
  nanopayReceiptsRepo,
  type NanopayReceiptRow,
} from "./repos/nanopay-receipts-repo.js";
import {
  bindingFromReceipt,
  computeRequestSignalId,
  serializeBinding,
  serializeRevealArtifact,
  revealArtifactFromReceipt,
  type NanopayBinding,
} from "./single-stream-binding.js";
import { transactionUuidToBytes32 } from "./nanopay-request.js";

export interface NanopaySettlementResponse {
  status: number;
  body: unknown;
}

export interface NanopaySettlementJsonResponseTarget {
  status(code: number): { json(body: unknown): unknown };
}

export function sendNanopaySettlementJsonResponse(
  res: NanopaySettlementJsonResponseTarget,
  result: NanopaySettlementResponse,
): void {
  res.status(result.status).json(result.body);
}

export interface NanopaySettlementInput {
  deps: NanopayRouterDeps;
  pipelineId: string | null;
  payment: PaymentRequest["payment"] | undefined;
  now: () => Date;
  logger?: Pick<Console, "error">;
}

export function nanopaySettlementResponse(
  input: NanopaySettlementInput,
): NanopaySettlementResponse {
  const { deps, payment, pipelineId } = input;
  const logger = input.logger ?? console;
  if (!payment || !payment.verified) {
    return {
      status: 500,
      body: {
        error: "PaymentMissing",
        message: "middleware did not populate payment",
      },
    };
  }
  if (!payment.transaction || !payment.payer || !payment.amount || !payment.network) {
    logger.error(
      "[nanopay] middleware reported verified payment with missing fields:",
      payment,
    );
    return { status: 500, body: { error: "PaymentFieldsIncomplete" } };
  }

  if (!pipelineId) {
    logger.error(
      `[nanopay] settled payment ${payment.transaction} reached handler without valid pipelineId; operator reconciliation required`,
    );
    return {
      status: 500,
      body: {
        error: "BadPipelineId",
        message: "pipelineId narrowing failed post-preflight",
      },
    };
  }

  const pipeline = deps.resolvePipeline(pipelineId);
  if (!pipeline) {
    logger.error(
      `[nanopay] settled payment ${payment.transaction} for unknown pipeline ${pipelineId}; operator reconciliation required`,
    );
    return { status: 404, body: { error: "PipelineNotFound", pipelineId } };
  }

  if (BigInt(payment.amount) < BigInt(pipeline.priceAtoms)) {
    logger.error(
      `[nanopay] settled payment ${payment.transaction} amount ${payment.amount} < pipeline price ${pipeline.priceAtoms}; refusing to serve`,
    );
    return {
      status: 402,
      body: {
        error: "PaymentInsufficient",
        message: "Settled amount less than pipeline price",
      },
    };
  }

  const sealedCall = deps.resolveLatestSealedCall(pipelineId);
  if (!sealedCall) {
    logger.error(
      `[nanopay] settled payment ${payment.transaction} for pipeline ${pipelineId} but no sealed call available; operator reconciliation required`,
    );
    return {
      status: 503,
      body: {
        error: "NoSignalAvailable",
        message: "Pipeline has no anchored sealed-Fhenix call yet; retry shortly",
      },
    };
  }

  const payer = payment.payer.toLowerCase() as `0x${string}`;
  const sourceDomain = `caip2:${payment.network}`;
  const paymentHandle = payment.transaction;
  const requirementsHash = paymentRequirementsHash({
    sellerAddress: deps.sellerAddress,
    pipelineId,
    network: payment.network,
  });
  const payloadHash = paymentPayloadHash({
    transaction: payment.transaction,
    payer,
    amount: payment.amount,
  });
  const paymentHandleDigest = transactionUuidToBytes32(paymentHandle);
  const requestSignalId = computeRequestSignalId({
    pipelineId: pipelineId as `0x${string}`,
    buyer: payer,
    eip3009Nonce: paymentHandleDigest,
    domain: deps.bindingDomain,
  });
  const binding: NanopayBinding = {
    pipelineId: pipelineId as `0x${string}`,
    buyerAddress: payer,
    requestSignalId,
    eip3009Nonce: paymentHandleDigest,
    circleTransactionUuid: payment.transaction,
    anchor: sealedCall.anchor,
  };
  const settledAt = input.now();

  try {
    const receiptId = nanopayReceiptsRepo.insertSettled(deps.db, {
      payer,
      paymentHandle,
      sourceDomain,
      paymentPayloadHash: payloadHash,
      paymentRequirementsHash: requirementsHash,
      pipelineId,
      requestSignalId,
      paidAmountUsdcAtoms: payment.amount,
      bindingJson: serializeBinding(binding),
      revealArtifactJson: serializeRevealArtifact(sealedCall.revealArtifact),
      circleTransactionUuid: payment.transaction,
      settledAt,
    });
    return {
      status: 200,
      body: {
        binding,
        revealArtifact: sealedCall.revealArtifact,
        receiptId,
      },
    };
  } catch (err) {
    if (isSqliteUniqueViolation(err)) {
      const existing = nanopayReceiptsRepo.findByPayerHandleDomain(deps.db, {
        payer,
        paymentHandle,
        sourceDomain,
      });
      if (existing && existing.status === "settled") {
        return receiptResponse(existing);
      }
      return {
        status: 500,
        body: {
          error: "InternalStateInconsistent",
          message: "duplicate insert without existing settled row",
        },
      };
    }
    throw err;
  }
}

function receiptResponse(row: NanopayReceiptRow): NanopaySettlementResponse {
  return {
    status: 200,
    body: {
      binding: bindingFromReceipt(row),
      revealArtifact: revealArtifactFromReceipt(row),
      receiptId: row.id,
      replayed: true,
    },
  };
}

function isSqliteUniqueViolation(err: unknown): boolean {
  return Boolean(
    err &&
      typeof err === "object" &&
      "code" in err &&
      (err as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE",
  );
}
