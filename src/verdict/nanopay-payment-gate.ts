import type { NextFunction, Request, RequestHandler, Response } from "express";

import {
  createGatewayMiddleware,
  DEFAULT_MAINNET_FACILITATOR_URL,
  DEFAULT_TESTNET_FACILITATOR_URL,
  type GatewayMiddleware,
  type GatewayMiddlewareConfig,
  type PaymentRequest,
} from "../integrations/circle-gateway.js";
import { handleNanopayAfterPayment } from "./nanopay-handler.js";
import { processDurableNanopay } from "./nanopay-durable-settlement.js";
import { preflightServable } from "./nanopay-preflight.js";
import { extractPipelineId } from "./nanopay-request.js";
import type { NanopayRouterDeps } from "./nanopay-types.js";

export type NanopayNetwork = NonNullable<NanopayRouterDeps["network"]>;
export type NanopayGatewayFactory = (
  config: GatewayMiddlewareConfig,
) => GatewayMiddleware;

export interface NanopayPaymentGate {
  facilitatorUrl: string;
  price: string;
  preflight: RequestHandler;
  requirePayment: RequestHandler;
  afterPayment: (req: Request, res: Response, next: NextFunction) => Promise<void>;
}

/**
 * Paid-inference payment gate. It keeps the servable check before the Circle
 * middleware so buyers are not charged when Murmur already knows it cannot
 * serve a pipeline.
 */
export function createNanopayPaymentGate(
  deps: NanopayRouterDeps,
  gatewayFactory: NanopayGatewayFactory = createGatewayMiddleware,
): NanopayPaymentGate {
  const network = deps.network ?? "testnet";
  const facilitatorUrl = nanopayFacilitatorUrl(network);
  const gateway = gatewayFactory({
    sellerAddress: deps.sellerAddress,
    networks: deps.acceptNetworks,
    facilitatorUrl,
    description: "Murmur per-call paid inference",
  });
  // No fallback price; the config loader already requires one when nanopay is mounted.
  const price = deps.defaultPrice?.trim();
  if (!price) {
    throw new Error(
      "nanopay payment gate requires an explicit price — refusing to charge a " +
        "default nobody configured",
    );
  }
  const challenge = gateway.require(price);

  return {
    facilitatorUrl,
    price,
    preflight: preflightServable(deps),
    requirePayment: async (req, res, next) => {
      const paymentHeader = req.headers["payment-signature"];
      if (paymentHeader === undefined) {
        await challenge(req, res, next);
        return;
      }
      if (typeof paymentHeader !== "string") {
        res.status(400).json({ error: "MalformedPayment" });
        return;
      }
      const pipelineId = extractPipelineId(req);
      if (!pipelineId) {
        res.status(400).json({ error: "BadPipelineId" });
        return;
      }
      const result = await processDurableNanopay({
        deps,
        gateway,
        pipelineId,
        paymentHeader,
      });
      if (result.kind === "error") {
        if (result.retryAfterSeconds !== undefined) {
          res.setHeader("Retry-After", String(result.retryAfterSeconds));
        }
        res.status(result.status).json(result.body);
        return;
      }
      (req as Request & PaymentRequest).payment = result.payment;
      res.setHeader(
        "PAYMENT-RESPONSE",
        Buffer.from(
          JSON.stringify({
            success: true,
            transaction: result.payment.transaction,
            network: result.payment.network,
            payer: result.payment.payer,
          }),
        ).toString("base64"),
      );
      next();
    },
    afterPayment: async (req, res) => {
      await handleNanopayAfterPayment(req as Request & PaymentRequest, res, deps);
    },
  };
}

export function nanopayFacilitatorUrl(network: NanopayNetwork): string {
  return network === "testnet"
    ? DEFAULT_TESTNET_FACILITATOR_URL
    : DEFAULT_MAINNET_FACILITATOR_URL;
}
