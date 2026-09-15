/**
 * Circle Gateway facade over @circle-fin/x402-batching. verify() and settle() are
 * separate so a settlement intent is recorded durably before the irreversible settle.
 * Never infers settlement after a transport error; reconciliation is a separate path.
 */
import type { RequestHandler } from "express";

import { canonicalHash } from "../receipts/canonical.js";

/** The only asset this rail settles in; challenge amounts are always USDC atoms. */
export const SETTLEMENT_CURRENCY = "USDC" as const;

export interface GatewayMiddlewareConfig {
  sellerAddress: string;
  networks?: string[];
  facilitatorUrl: string;
  description?: string;
}

export interface GatewayMiddleware {
  require(price: string): RequestHandler;
  paymentRequirements(
    amountAtoms: string,
    network: string,
  ): Promise<GatewayPaymentRequirements | null>;
  verify(
    paymentPayload: unknown,
    paymentRequirements: GatewayPaymentRequirements,
  ): Promise<GatewayVerifyResponse>;
  settle(
    paymentPayload: unknown,
    paymentRequirements: GatewayPaymentRequirements,
  ): Promise<GatewaySettleResponse>;
}

export interface GatewayPaymentRequirements {
  scheme: string;
  network: string;
  asset: string;
  amount: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra?: Record<string, unknown>;
}

export interface GatewayVerifyResponse {
  valid: boolean;
  payer?: string;
  error?: string;
}

export interface GatewaySettleResponse {
  success: boolean;
  payer?: string;
  transaction?: string;
  network?: string;
  error?: string;
}

export interface PaymentRequest {
  payment?: {
    verified?: boolean;
    payer?: string;
    amount?: string;
    network?: string;
    transaction?: string;
    /** Durable local receipt created before Circle settlement. */
    receiptId?: number;
    /** True when no new settlement was attempted and a cached receipt was used. */
    replayed?: boolean;
  };
}

interface CircleSupportedKind {
  scheme: string;
  network: string;
  extra?: {
    verifyingContract?: string;
    assets?: Array<{ symbol?: string; address?: string }>;
    [key: string]: unknown;
  };
}

interface CircleFacilitatorClient {
  getSupported(): Promise<{ kinds: CircleSupportedKind[] }>;
  verify(
    paymentPayload: unknown,
    paymentRequirements: GatewayPaymentRequirements,
  ): Promise<{ isValid: boolean; invalidReason?: string; payer?: string }>;
  settle(
    paymentPayload: unknown,
    paymentRequirements: GatewayPaymentRequirements,
  ): Promise<{
    success: boolean;
    errorReason?: string;
    payer?: string;
    transaction?: string;
    network?: string;
  }>;
}

interface CircleGatewayServerModule {
  createGatewayMiddleware(config: GatewayMiddlewareConfig): {
    require(price: string): RequestHandler;
  };
  BatchFacilitatorClient: new (config: { url?: string }) => CircleFacilitatorClient;
  GATEWAY_AUTH_VALIDITY_WINDOW_SECONDS: number;
}

let gatewayServerModule: Promise<CircleGatewayServerModule> | null = null;

async function loadCircleGatewayServer(): Promise<CircleGatewayServerModule> {
  gatewayServerModule ??= import("@circle-fin/x402-batching/server") as Promise<
    CircleGatewayServerModule
  >;
  return gatewayServerModule;
}

export function createGatewayMiddleware(
  config: GatewayMiddlewareConfig,
): GatewayMiddleware {
  const requiredByPrice = new Map<string, Promise<RequestHandler>>();
  let facilitator: Promise<CircleFacilitatorClient> | null = null;
  let supportedKinds: Promise<CircleSupportedKind[]> | null = null;

  const loadFacilitator = async (): Promise<CircleFacilitatorClient> => {
    facilitator ??= loadCircleGatewayServer().then(
      (sdk) => new sdk.BatchFacilitatorClient({ url: config.facilitatorUrl }),
    );
    return facilitator;
  };

  return {
    require(price: string): RequestHandler {
      return async (req, res, next) => {
        try {
          let middleware = requiredByPrice.get(price);
          if (!middleware) {
            middleware = loadCircleGatewayServer().then((sdk) =>
              sdk.createGatewayMiddleware(config).require(price),
            );
            requiredByPrice.set(price, middleware);
          }
          const handler = await middleware;
          return handler(req, res, next);
        } catch (err) {
          return next(err);
        }
      };
    },
    async paymentRequirements(
      amountAtoms: string,
      network: string,
    ): Promise<GatewayPaymentRequirements | null> {
      if (!/^\d+$/.test(amountAtoms) || BigInt(amountAtoms) <= 0n) {
        throw new Error(`invalid USDC atom amount: ${amountAtoms}`);
      }
      if (config.networks && !config.networks.includes(network)) {
        return null;
      }
      const sdk = await loadCircleGatewayServer();
      supportedKinds ??= loadFacilitator().then((client) =>
        client.getSupported().then((result) => result.kinds),
      );
      const kinds = await supportedKinds;
      const kind = kinds.find(
        (candidate) =>
          candidate.network === network &&
          candidate.scheme === "exact" &&
          typeof candidate.extra?.verifyingContract === "string",
      );
      const usdc = kind?.extra?.assets?.find(
        (asset) => asset.symbol?.toUpperCase() === SETTLEMENT_CURRENCY,
      );
      if (!kind || !usdc?.address || !kind.extra?.verifyingContract) {
        return null;
      }
      return {
        scheme: "exact",
        network,
        asset: usdc.address,
        amount: amountAtoms,
        payTo: config.sellerAddress,
        maxTimeoutSeconds: sdk.GATEWAY_AUTH_VALIDITY_WINDOW_SECONDS,
        extra: {
          name: "GatewayWalletBatched",
          version: "1",
          verifyingContract: kind.extra.verifyingContract,
        },
      };
    },
    async verify(paymentPayload, paymentRequirements) {
      const result = await (await loadFacilitator()).verify(
        paymentPayload,
        paymentRequirements,
      );
      return {
        valid: result.isValid,
        ...(result.payer ? { payer: result.payer } : {}),
        ...(result.invalidReason ? { error: result.invalidReason } : {}),
      };
    },
    async settle(paymentPayload, paymentRequirements) {
      const result = await (await loadFacilitator()).settle(
        paymentPayload,
        paymentRequirements,
      );
      return {
        success: result.success,
        ...(result.payer ? { payer: result.payer } : {}),
        ...(result.transaction ? { transaction: result.transaction } : {}),
        ...(result.network ? { network: result.network } : {}),
        ...(result.errorReason ? { error: result.errorReason } : {}),
      };
    },
  };
}

export const DEFAULT_TESTNET_FACILITATOR_URL = "https://gateway-api-testnet.circle.com";
export const DEFAULT_MAINNET_FACILITATOR_URL = "https://gateway-api.circle.com";

/** keccak256(canonicalize(requirements)); `nanopay_receipts.payment_requirements_hash`. */
export function paymentRequirementsHash(requirements: unknown): `0x${string}` {
  return canonicalHash(requirements);
}

/** keccak256(canonicalize(payload)); payload side of the idempotency key. */
export function paymentPayloadHash(payload: unknown): `0x${string}` {
  return canonicalHash(payload);
}
