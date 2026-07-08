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
import { preflightServable } from "./nanopay-preflight.js";
import type { NanopayRouterDeps } from "./nanopay-types.js";

export type NanopayNetwork = NonNullable<NanopayRouterDeps["network"]>;
export type NanopayGatewayFactory = (
  config: GatewayMiddlewareConfig,
) => Pick<GatewayMiddleware, "require">;

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
  const price = deps.defaultPrice ?? "$0.001";

  return {
    facilitatorUrl,
    price,
    preflight: preflightServable(deps),
    requirePayment: gateway.require(price),
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
