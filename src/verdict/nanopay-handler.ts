import type { Request, Response } from "express";

import type { NanopayRouterDeps } from "./nanopay-types.js";
import { type PaymentRequest } from "../integrations/circle-gateway.js";
import { extractPipelineId } from "./nanopay-request.js";
import {
  nanopaySettlementResponse,
  sendNanopaySettlementJsonResponse,
} from "./nanopay-settlement-surface.js";

/**
 * Runs after the durable payment gate has verified, persisted, settled, and
 * finalized the receipt. `req.payment.receiptId` identifies that exact row.
 */
export async function handleNanopayAfterPayment(
  req: Request & PaymentRequest,
  res: Response,
  deps: NanopayRouterDeps,
): Promise<void> {
  const result = nanopaySettlementResponse({
    deps,
    pipelineId: extractPipelineId(req),
    payment: req.payment,
    now: deps.now,
  });
  sendNanopaySettlementJsonResponse(res, result);
}
