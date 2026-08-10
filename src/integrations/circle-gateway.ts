/**
 * Wave L.A — Circle Gateway integration via @circle-fin/x402-batching.
 *
 * Thin facade over the published SDK. The no-payment branch uses
 * `createGatewayMiddleware(config)` for canonical x402 challenges. Signed
 * requests use `BatchFacilitatorClient`'s `getSupported()`, `verify()`, and
 * `settle()` separately so Murmur can durably record a settlement intent
 * between verification and the irreversible settle call.
 *   - Type-safe canonical types: `PaymentPayload`, `PaymentRequirements`.
 *
 * This module deliberately does not infer settlement after a transport
 * error. Authoritative reconciliation remains a separate operational path.
 *
 * Pivot rationale (codex audit 2026-05-23): the previous hand-rolled
 * client was repeatedly catching wire-format mismatches — wrong
 * settle body shape, wrong response field names, wrong transfer/search
 * filter names, missing `success` check, wrong EIP-712 domain for
 * Base Sepolia USDC. The SDK encodes all these correctly. Use it.
 *
 * Design note: docs/superpowers/specs/2026-05-23-wave-l-a-nanopayments-design.md
 */
import type { RequestHandler } from "express";

import { canonicalHash } from "../receipts/canonical.js";

/**
 * The only asset this rail settles in.
 *
 * Circle Gateway batching selects the USDC asset from the facilitator's
 * supported kinds — the amount in a challenge is always USDC atoms. Exported
 * so surfaces that let a human name a currency validate against what will
 * ACTUALLY be charged, rather than recording a label nothing enforces: a
 * provider who typed "ETH" got buyers charged that number of USDC atoms and
 * receipts stamped ETH.
 */
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

/**
 * Compute keccak256(canonicalize(requirements)) — used as the
 * `payment_requirements_hash` column of `nanopay_receipts` for post-settle
 * duplicate detection. Uses the single strict canonical-JSON encoder
 * (src/receipts/canonical.ts) so payment-hash pre-images share one definition
 * with every other hash pre-image in the codebase (a looser second encoder
 * risked hashing the same logical value differently).
 */
export function paymentRequirementsHash(requirements: unknown): `0x${string}` {
  return canonicalHash(requirements);
}

/**
 * Compute keccak256(canonicalize(payload)) — same purpose as
 * `paymentRequirementsHash`, on the payload side of the composite
 * idempotency key.
 */
export function paymentPayloadHash(payload: unknown): `0x${string}` {
  return canonicalHash(payload);
}
