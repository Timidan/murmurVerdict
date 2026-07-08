import type { Request, Response } from "express";

import type { NanopayRouterDeps } from "./nanopay-types.js";
import { type PaymentRequest } from "../integrations/circle-gateway.js";
import { extractPipelineId } from "./nanopay-request.js";
import {
  nanopaySettlementResponse,
  sendNanopaySettlementJsonResponse,
} from "./nanopay-settlement-surface.js";

/**
 * Runs AFTER the SDK middleware has verified + settled the payment.
 * `req.payment` carries `{verified, payer, amount, network, transaction}`.
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
