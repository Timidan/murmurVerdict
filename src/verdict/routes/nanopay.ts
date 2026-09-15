import { Router } from "express";

import {
  createNanopayPaymentGate,
  type NanopayGatewayFactory,
} from "../nanopay-payment-gate.js";
import type { NanopayRouterDeps } from "../nanopay-types.js";
import { asyncHandler } from "./async-handler.js";

export type {
  NanopayRouterDeps,
  PipelineInfo,
} from "../nanopay-types.js";

/**
 * `POST /v2/nanopay/infer/:pipelineId`. The Circle x402 SDK owns the 402 challenge, verify and
 * settle; Murmur calls them separately so a durable `settling` receipt is written between verify
 * and settle. A transport-unknown settle stays `settling` and is never blindly retried.
 */

export function createNanopayRouter(
  deps: NanopayRouterDeps,
  // Circle facilitator factory; defaults to the real SDK, a fake lets tests skip Circle.
  gatewayFactory?: NanopayGatewayFactory,
): Router {
  const router = Router();
  const paymentGate = createNanopayPaymentGate(deps, gatewayFactory);

  router.post(
    "/v2/nanopay/infer/:pipelineId",
    paymentGate.preflight,
    paymentGate.requirePayment,
    asyncHandler(paymentGate.afterPayment),
  );

  return router;
}

export const nanopayRouter = (
  deps: NanopayRouterDeps,
  gatewayFactory?: NanopayGatewayFactory,
): Router => createNanopayRouter(deps, gatewayFactory);
