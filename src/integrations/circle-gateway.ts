/**
 * Wave L.A — Circle Gateway integration via @circle-fin/x402-batching.
 *
 * Thin facade over the published SDK. The SDK provides:
 *   - `createGatewayMiddleware(config)` — Express middleware that
 *     handles 402 challenge + EIP-3009 sig verification + Circle
 *     /v1/x402/settle in one shot, populating `req.payment` with
 *     `{verified, payer, amount, network, transaction}` on success.
 *   - `BatchFacilitatorClient` — REST client for finer-grained
 *     `verify()` / `settle()` / `getSupported()` calls (Phase 3
 *     reconciler will use this).
 *   - Type-safe canonical types: `PaymentPayload`, `PaymentRequirements`.
 *
 * Phase 1 ships only the middleware-based path. Phase 3 will use
 * `BatchFacilitatorClient` for reconciliation lookups.
 *
 * Pivot rationale (codex audit 2026-05-23): the previous hand-rolled
 * client was repeatedly catching wire-format mismatches — wrong
 * settle body shape, wrong response field names, wrong transfer/search
 * filter names, missing `success` check, wrong EIP-712 domain for
 * Base Sepolia USDC. The SDK encodes all these correctly. Use it.
 *
 * Design note: docs/superpowers/specs/2026-05-23-wave-l-a-nanopayments-design.md
 */
import { keccak256, toHex } from "viem";

// Re-export the SDK types so callers don't take a direct dependency
// on the SDK package path.
export type {
  GatewayMiddleware,
  GatewayMiddlewareConfig,
  PaymentRequest,
} from "@circle-fin/x402-batching/server";

export {
  createGatewayMiddleware,
  BatchFacilitatorClient,
} from "@circle-fin/x402-batching/server";

export const DEFAULT_TESTNET_FACILITATOR_URL = "https://gateway-api-testnet.circle.com";
export const DEFAULT_MAINNET_FACILITATOR_URL = "https://gateway-api.circle.com";

/**
 * Deterministic JSON canonicalization: sorted keys, no whitespace.
 * Stable across daemon restarts and JS implementations. Used as the
 * input to `paymentPayloadHash` / `paymentRequirementsHash` so the
 * composite idempotency key doesn't shift when an object is reordered
 * client-side.
 *
 * NOT a general canonicalization (doesn't normalize numbers, doesn't
 * RFC 8785), but sufficient for our hash-as-fingerprint use case
 * because callers control both sides.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys
    .map(
      (k) =>
        `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`,
    )
    .join(",")}}`;
}

/**
 * Compute keccak256(canonicalJson(requirements)) — used as the
 * `payment_requirements_hash` column of `nanopay_receipts` for
 * post-settle duplicate detection (if the SDK middleware ever lets
 * the same payment through twice — shouldn't happen in normal
 * operation; the UNIQUE constraint catches it as defense-in-depth).
 */
export function paymentRequirementsHash(requirements: unknown): `0x${string}` {
  return keccak256(toHex(canonicalJson(requirements)));
}

/**
 * Compute keccak256(canonicalJson(payload)) — same purpose as
 * `paymentRequirementsHash`, used on the payload side of the
 * composite idempotency key.
 */
export function paymentPayloadHash(payload: unknown): `0x${string}` {
  return keccak256(toHex(canonicalJson(payload)));
}
