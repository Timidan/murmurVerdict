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
 * Wave L.A Phase 1 — Nanopayments HTTP route (SDK-pivot edition).
 *
 * Mounts `POST /v2/nanopay/infer/:pipelineId` on the daemon. The
 * `@circle-fin/x402-batching/server` owns canonical requirement discovery,
 * verification, settlement, and 402 challenge encoding. Murmur deliberately
 * orchestrates those SDK operations separately so persistence can sit between
 * verification and settlement. Responsibilities:
 *   1. Look up the pipeline + the latest sealed-Fhenix anchored call.
 *   2. Compute the EIP-712 `requestSignalId` binding hash.
 *   3. Verify the signed payment with Circle without settling it yet.
 *   4. Insert a durable `nanopay_receipts` row in `settling` state.
 *   5. Settle through Circle, then conditionally transition that same
 *      row to `settled` before serving the bound signal.
 *
 * The no-payment branch still delegates to the SDK middleware so the
 * canonical x402 V2 challenge stays SDK-owned. Signed requests use the
 * SDK's public facilitator methods separately, creating the durable
 * insertion point between `verify` and `settle`. A transport-unknown
 * settlement remains `settling` and is never blindly retried; the
 * production reconciler remains a separate operational phase.
 *
 * Design note: docs/superpowers/specs/2026-05-23-wave-l-a-nanopayments-design.md
 */

export function createNanopayRouter(
  deps: NanopayRouterDeps,
  // Router-construction Adapter (NOT settlement-domain data on
  // NanopayRouterDeps): the Circle facilitator factory. Defaults to the real
  // SDK facade; a fake here lets an end-to-end paid-inference test run through
  // startDaemon without touching Circle.
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
