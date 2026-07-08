import { Router } from "express";

import { createNanopayPaymentGate } from "../nanopay-payment-gate.js";
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
 * `@circle-fin/x402-batching/server` middleware handles:
 *   - 402 challenge generation with correct x402 V2 headers (Base64-
 *     encoded JSON per spec).
 *   - EIP-3009 signature verification against the correct
 *     `GatewayWalletBatched` domain (NOT the USDC token contract).
 *   - Circle `/v1/x402/settle` call with the SDK's canonical
 *     PaymentRequirements + PaymentPayload shapes.
 *   - Populating `req.payment = {verified, payer, amount, network,
 *     transaction}` on successful settlement.
 *
 * Murmur's handler runs ONLY after the middleware has settled the
 * payment. Responsibilities:
 *   1. Look up the pipeline + the latest sealed-Fhenix anchored call.
 *   2. Compute the EIP-712 `requestSignalId` binding hash.
 *   3. Insert a `nanopay_receipts` row (status='settled' directly,
 *      since the middleware has already settled). Replay protection
 *      via the prefix UNIQUE index — concurrent identical payments
 *      hit `SQLITE_CONSTRAINT_UNIQUE` and we re-read + serve cached.
 *   4. Return the signal + full single-stream binding.
 *
 * Phase 1 is a TESTNET MVP. The original design specified a
 * `settling_intent` state-machine row written BEFORE Circle settle.
 * The SDK middleware does verify+settle in one shot so that ordering
 * isn't possible without dropping the middleware. Deviation:
 *
 *   - Receipts go directly to `settled` (no intermediate `settling`).
 *   - Crash recovery is Circle-side: if the daemon crashes between
 *     SDK middleware completing settle and Murmur inserting the row,
 *     Phase 3 reconciler queries Circle's `/v1/x402/transfers` to
 *     reconstruct missed receipts.
 *
 * If a tighter crash story is required in a later phase, swap to
 * `BatchFacilitatorClient.verify(...)` then `settle(...)` directly
 * (without the middleware) and write a `settling_intent` row between
 * the two.
 *
 * Design note: docs/superpowers/specs/2026-05-23-wave-l-a-nanopayments-design.md
 */

export function createNanopayRouter(deps: NanopayRouterDeps): Router {
  const router = Router();
  const paymentGate = createNanopayPaymentGate(deps);

  router.post(
    "/v2/nanopay/infer/:pipelineId",
    paymentGate.preflight,
    paymentGate.requirePayment,
    asyncHandler(paymentGate.afterPayment),
  );

  return router;
}

export const nanopayRouter = (deps: NanopayRouterDeps): Router =>
  createNanopayRouter(deps);
