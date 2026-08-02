import {
  paymentPayloadHash,
  paymentRequirementsHash,
  type GatewayMiddleware,
  type GatewayPaymentRequirements,
} from "../integrations/circle-gateway.js";
import { canonicalize } from "../receipts/canonical.js";
import {
  checkEntitlementEligibility,
  purchaseEntitlementAccess,
  type EntitlementAccessDeps,
  type PurchaseResult,
  type SettleOutcome,
} from "./entitlement-access.js";
import { entitlementsRepo } from "./repos/entitlements-repo.js";

// HTTP surface for Flow 2 paid private decrypt-grant (grant-only v1):
//   POST /v2/gateway/calls/:callId/access         — pay, then broker the grant.
//   GET  /v2/gateway/calls/:callId/access/status  — async payment+grant status.
// The payment protocol is isolated behind EntitlementPaymentBroker so the
// surface mapping is testable without Circle. The core durable machine lives in
// entitlement-access.ts; NO plaintext / NO proxy-decrypt endpoint exists — the
// subscriber unseals locally with a self permit (see tools/).

// CoFHE FheTypes hints for the client's decryptForView (see subscriber tooling).
export const BINARY_INDEX_FHE_TYPE = "Uint8" as const;
export const CONFIDENCE_FHE_TYPE = "Uint16" as const;

export interface EntitlementSurfaceResponse {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

export interface AuthorizedPayment {
  verifiedPayer: string;
  settle: () => Promise<SettleOutcome>;
}

export type BrokerAuthorization =
  | { ok: true; payment: AuthorizedPayment }
  | { ok: false; status: number; body: { error: string; message?: string } };

export interface EntitlementResourceBinding {
  chainId: number;
  contractAddress: string;
  onchainCallId: string;
  priceAtoms: string;
  pricingVersion: string;
}

export interface EntitlementPaymentBroker {
  /** Build the 402 challenge requirements for the flat access price. */
  challenge(binding: EntitlementResourceBinding): Promise<GatewayPaymentRequirements | null>;
  /**
   * Verify a presented x402 payment and bind it to the exact resource. Returns
   * the VERIFIED payer plus a settle thunk (settlement happens later, after the
   * unique entitlement reservation). Never derives the subscriber from JSON.
   */
  authorize(
    paymentHeader: string,
    binding: EntitlementResourceBinding,
  ): Promise<BrokerAuthorization>;
}

export interface EntitlementAccessSurfaceDeps {
  readonly access: EntitlementAccessDeps;
  readonly broker: EntitlementPaymentBroker;
  readonly priceAtoms: string;
  readonly currency: string;
  readonly pricingVersion: string;
}

const BYTES32 = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

function bindingFor(
  deps: EntitlementAccessSurfaceDeps,
  onchainCallId: string,
): EntitlementResourceBinding {
  return {
    chainId: deps.access.grantChain.chainId,
    contractAddress: deps.access.grantChain.contractAddress,
    onchainCallId,
    priceAtoms: deps.priceAtoms,
    pricingVersion: deps.pricingVersion,
  };
}

/**
 * POST handler body. `paymentHeader` is the raw PAYMENT-SIGNATURE value (or
 * undefined for the initial unpaid request → 402 challenge). Eligibility is
 * validated BEFORE the 402 so a buyer is never challenged for a call whose sale
 * window has already closed (Codex §3).
 */
export async function entitlementAccessResponse(input: {
  deps: EntitlementAccessSurfaceDeps;
  onchainCallId: string;
  paymentHeader: string | undefined;
}): Promise<EntitlementSurfaceResponse> {
  const { deps, onchainCallId, paymentHeader } = input;
  if (!BYTES32.test(onchainCallId)) {
    return { status: 400, body: { error: "BadCallId", message: "callId must be a 0x bytes32" } };
  }

  const binding = bindingFor(deps, onchainCallId);

  // (1) Eligibility BEFORE any 402 challenge or charge.
  const eligibility = await checkEntitlementEligibility(deps.access, onchainCallId);
  if (eligibility.reason !== "ok") {
    return eligibilityResponse(eligibility.reason);
  }

  if (paymentHeader === undefined) {
    const requirements = await deps.broker.challenge(binding);
    if (!requirements) {
      return { status: 503, body: { error: "PaymentGatewayUnavailable" } };
    }
    return {
      status: 402,
      body: {
        error: "PaymentRequired",
        accepts: [requirements],
        price: deps.priceAtoms,
        currency: deps.currency,
        pricingVersion: deps.pricingVersion,
      },
    };
  }

  const authorization = await deps.broker.authorize(paymentHeader, binding);
  if (!authorization.ok) {
    return { status: authorization.status, body: authorization.body };
  }

  const result = await purchaseEntitlementAccess(deps.access, {
    onchainCallId,
    verifiedPayer: authorization.payment.verifiedPayer,
    settlement: { settle: authorization.payment.settle },
  });
  return purchaseResponse(deps, onchainCallId, result);
}

/**
 * GET handler body: async payment + grant status for (call, subscriber).
 * Returns chain/contract/call, both ct handles + FheTypes hints, grant tx
 * hash/status/confirmations, and revealOpenAt. NO plaintext.
 */
export async function entitlementStatusResponse(input: {
  deps: EntitlementAccessSurfaceDeps;
  onchainCallId: string;
  subscriberAddress: string;
}): Promise<EntitlementSurfaceResponse> {
  const { deps, onchainCallId, subscriberAddress } = input;
  if (!BYTES32.test(onchainCallId)) {
    return { status: 400, body: { error: "BadCallId" } };
  }
  if (!ADDRESS.test(subscriberAddress)) {
    return { status: 400, body: { error: "BadSubscriber" } };
  }

  const chain = deps.access.grantChain;
  const view = await chain.readDecryptAccess(onchainCallId, subscriberAddress);
  if (!view || view.state === 0) {
    return { status: 404, body: { error: "CallNotFound" } };
  }

  const row = entitlementsRepo.byReservation(deps.access.db, {
    chainId: chain.chainId,
    contractAddress: chain.contractAddress,
    onchainCallId,
    subscriberAddress,
  });

  // Confirmed once the grant is terminal-granted, or once a broadcast tx has a
  // successful receipt. The on-chain getDecryptAccess.alreadyGranted below is
  // the authoritative signal; confirmations is a coarse mined/not-mined hint.
  let confirmations = 0;
  if (row?.grant_tx_hash) {
    const receipt = await chain.getReceipt(row.grant_tx_hash);
    if (receipt?.success) confirmations = receipt.confirmations;
  }
  if (confirmations === 0 && row?.status === "granted") {
    // Terminal-granted with the tx unreadable now (or granted via on-chain
    // reconciliation without a stored block) still reports at least 1.
    confirmations = 1;
  }

  return {
    status: 200,
    body: {
      chainId: chain.chainId,
      contract: chain.contractAddress,
      callId: onchainCallId,
      subscriber: subscriberAddress,
      status: row?.status ?? "none",
      refundStatus: row?.refund_status ?? null,
      grant: {
        txHash: row?.grant_tx_hash ?? null,
        blockNumber: row?.grant_block_number ?? null,
        // On-chain source of truth for the subscriber's access.
        onchainGranted: view.alreadyGranted,
        confirmations,
        attempts: row?.grant_attempts ?? 0,
      },
      ciphertexts: {
        binaryIndex: { handle: view.binaryIndexCtHash, fheType: BINARY_INDEX_FHE_TYPE },
        confidenceBps: { handle: view.confidenceCtHash, fheType: CONFIDENCE_FHE_TYPE },
      },
      revealOpenAt: view.revealOpenAt,
      lastError: row?.last_error ?? null,
    },
  };
}

function purchaseResponse(
  deps: EntitlementAccessSurfaceDeps,
  onchainCallId: string,
  result: PurchaseResult,
): EntitlementSurfaceResponse {
  if (result.kind === "error") {
    return { status: result.status, body: result.body };
  }
  const chain = deps.access.grantChain;
  const base = {
    chainId: chain.chainId,
    contract: chain.contractAddress,
    callId: onchainCallId,
    subscriber: result.row.subscriber_address,
    status: result.row.status,
    grantTxHash: result.row.grant_tx_hash,
    statusUrl: `/v2/gateway/calls/${onchainCallId}/access/status`,
  };
  switch (result.kind) {
    case "granted":
    case "already_owned":
      return { status: 200, body: { ...base, granted: true } };
    case "refund_due":
      // The payment settled but the grant could not land; a refund is owed.
      return {
        status: 409,
        body: { ...base, granted: false, refundDue: true },
      };
    case "processing":
      return { status: 202, body: { ...base, granted: false } };
  }
}

function eligibilityResponse(
  reason: "call_not_found" | "not_sealed" | "sale_window_closed",
): EntitlementSurfaceResponse {
  if (reason === "call_not_found") return { status: 404, body: { error: "CallNotFound" } };
  if (reason === "not_sealed") {
    return { status: 409, body: { error: "CallNotSealed", message: "call is no longer sealed" } };
  }
  return {
    status: 409,
    body: {
      error: "SaleWindowClosed",
      message: "the private decrypt-access sale window for this call has closed",
    },
  };
}

// ─── Gateway-backed broker (production wiring) ──────────────────────────────

interface ParsedEntitlementPayment {
  paymentPayload: Record<string, unknown>;
  accepted: GatewayPaymentRequirements;
  payer: string;
  nonce: string;
}

/**
 * Real broker over the Circle Gateway middleware: parse → match canonical
 * requirements → verify → return the verified payer + a settle thunk. Binds the
 * requirements fingerprint to the exact (chain, contract, call, price, pricing
 * version) so one signed nonce cannot buy a different call's access.
 */
export function createGatewayEntitlementBroker(deps: {
  gateway: GatewayMiddleware;
  network: string;
  sellerAddress: string;
  currency: string;
}): EntitlementPaymentBroker {
  return {
    async challenge(binding) {
      return deps.gateway.paymentRequirements(binding.priceAtoms, deps.network);
    },
    async authorize(paymentHeader, binding) {
      const parsed = parsePaymentHeader(paymentHeader);
      if (!parsed) {
        return brokerError(400, "MalformedPayment", "PAYMENT-SIGNATURE is not valid x402 JSON");
      }
      if (
        parsed.accepted.amount !== binding.priceAtoms ||
        parsed.accepted.payTo.toLowerCase() !== deps.sellerAddress.toLowerCase()
      ) {
        return brokerError(402, "PaymentRequirementsMismatch", "payment does not match access price");
      }

      let canonical: GatewayPaymentRequirements | null;
      try {
        canonical = await deps.gateway.paymentRequirements(binding.priceAtoms, parsed.accepted.network);
      } catch (err) {
        return brokerError(503, "PaymentGatewayUnavailable", messageFrom(err));
      }
      if (!canonical || canonicalize(canonical) !== canonicalize(parsed.accepted)) {
        return brokerError(402, "PaymentRequirementsMismatch", "not the canonical server challenge");
      }
      // Bind the resource fingerprint (defensive; the entitlement reservation is
      // the primary anti-double-charge guard).
      void paymentPayloadHash(parsed.paymentPayload);
      void paymentRequirementsHash({
        pipelineId: `${binding.chainId}:${binding.contractAddress}:${binding.onchainCallId}:${binding.pricingVersion}`,
        paymentRequirements: canonical,
      });

      let verify: Awaited<ReturnType<GatewayMiddleware["verify"]>>;
      try {
        verify = await deps.gateway.verify(parsed.paymentPayload, canonical);
      } catch (err) {
        return brokerError(503, "PaymentGatewayUnavailable", messageFrom(err));
      }
      if (!verify.valid) {
        return brokerError(402, "PaymentVerificationFailed", verify.error);
      }
      if (verify.payer && verify.payer.toLowerCase() !== parsed.payer.toLowerCase()) {
        return brokerError(402, "PaymentVerificationFailed", "verified payer does not match authorization");
      }

      const canonicalRequirements = canonical;
      return {
        ok: true,
        payment: {
          verifiedPayer: parsed.payer,
          settle: async (): Promise<SettleOutcome> => {
            let settle: Awaited<ReturnType<GatewayMiddleware["settle"]>>;
            try {
              settle = await deps.gateway.settle(parsed.paymentPayload, canonicalRequirements);
            } catch (err) {
              return { kind: "unknown", reason: messageFrom(err) };
            }
            if (!settle.success) {
              return { kind: "rejected", reason: settle.error ?? "Circle rejected settlement" };
            }
            if (!settle.transaction) {
              return { kind: "unknown", reason: "Circle reported success without a transaction UUID" };
            }
            if (settle.payer && settle.payer.toLowerCase() !== parsed.payer.toLowerCase()) {
              return { kind: "unknown", reason: "Circle settlement identity did not match" };
            }
            return {
              kind: "settled",
              transaction: settle.transaction,
              payer: parsed.payer,
              amount: canonicalRequirements.amount,
              currency: deps.currency,
            };
          },
        },
      };
    },
  };
}

function parsePaymentHeader(header: string): ParsedEntitlementPayment | null {
  try {
    const decoded = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as unknown;
    if (!isRecord(decoded) || !isRecord(decoded.accepted) || !isRecord(decoded.payload)) {
      return null;
    }
    const accepted = decoded.accepted;
    const authorization = isRecord(decoded.payload.authorization)
      ? decoded.payload.authorization
      : null;
    if (
      !authorization ||
      !isAddress(authorization.from) ||
      accepted.scheme !== "exact" ||
      typeof accepted.network !== "string" ||
      typeof accepted.amount !== "string" ||
      !/^\d+$/.test(accepted.amount) ||
      !isAddress(accepted.payTo)
    ) {
      return null;
    }
    return {
      paymentPayload: decoded,
      accepted: accepted as unknown as GatewayPaymentRequirements,
      payer: authorization.from.toLowerCase(),
      nonce: typeof authorization.nonce === "string" ? authorization.nonce.toLowerCase() : "",
    };
  } catch {
    return null;
  }
}

function brokerError(status: number, error: string, message?: string): BrokerAuthorization {
  return { ok: false, status, body: { error, ...(message ? { message } : {}) } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAddress(value: unknown): value is string {
  return typeof value === "string" && ADDRESS.test(value);
}

function messageFrom(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
