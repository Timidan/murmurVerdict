import type Database from "better-sqlite3";
import {
  paymentPayloadHash,
  paymentRequirementsHash,
  type GatewayMiddleware,
  type GatewayPaymentRequirements,
} from "../integrations/circle-gateway.js";
import { canonicalize } from "../receipts/canonical.js";
import { termsFromSnapshot, type CallTerms } from "./call-sale-terms.js";
import {
  checkEntitlementEligibility,
  purchaseEntitlementAccess,
  type EntitlementAccessDeps,
  type PurchaseResult,
  type SettleOutcome,
} from "./entitlement-access.js";
import { fhenixSealedCallsRepo } from "./repos/fhenix-sealed-calls-repo.js";
import { entitlementsRepo } from "./repos/entitlements-repo.js";
import { entitlementPaymentBindingsRepo } from "./repos/entitlement-payment-bindings-repo.js";
import {
  verifySubscriberAuth,
} from "./gateway-purchases-surface.js";
import { redactedErrorText } from "../integrations/fhenix-gateway-runtime.js";

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
  /**
   * Carried so the settlement record stamps the currency this CALL was priced
   * in. The amount already comes from the call's snapshot; recording the
   * deployment-wide currency beside a per-provider amount would make the
   * receipt describe terms that were never offered.
   */
  currency: string;
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

export type { CallTerms };

/**
 * The terms THIS call is sold under, or null when it is not for sale.
 *
 * The rules themselves live in `termsFromSnapshot` (call-sale-terms.ts) — a
 * pure resolver shared with the public sellable listing, so the storefront and
 * the checkout can never disagree about a call's price or about whether it is
 * on offer at all. This function is the payment path's binding of that
 * resolver: it supplies the call's snapshot from the grant deployment's own
 * rows, and this deployment's configured terms as the legacy fallback.
 */
export function termsFor(
  deps: EntitlementAccessSurfaceDeps,
  onchainCallId: string,
): CallTerms | null {
  const call = fhenixSealedCallsRepo.byOnchainCall(deps.access.db, {
    chain_id: deps.access.grantChain.chainId,
    contract_address: deps.access.grantChain.contractAddress,
    onchain_call_id: onchainCallId,
  });
  return termsFromSnapshot(call, {
    priceAtoms: deps.priceAtoms,
    currency: deps.currency,
    pricingVersion: deps.pricingVersion,
  });
}

function bindingFor(
  deps: EntitlementAccessSurfaceDeps,
  onchainCallId: string,
  terms: CallTerms,
): EntitlementResourceBinding {
  return {
    chainId: deps.access.grantChain.chainId,
    contractAddress: deps.access.grantChain.contractAddress,
    onchainCallId,
    priceAtoms: terms.priceAtoms,
    currency: terms.currency,
    pricingVersion: terms.pricingVersion,
  };
}

/**
 * POST handler body. `paymentHeader` is the raw PAYMENT-SIGNATURE value (or
 * undefined for the initial unpaid request → 402 challenge). Eligibility is
 * validated BEFORE the 402 so a buyer is never challenged for a call whose sale
 * window has already closed.
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

  // The owner's price for THIS call. Null means they are not selling access —
  // answered before eligibility because a call with no price cannot be
  // challenged for, whatever its window says.
  const terms = termsFor(deps, onchainCallId);
  if (!terms) {
    return {
      status: 404,
      body: {
        error: "NotForSale",
        message: "this agent does not sell early access to its calls",
      },
    };
  }
  const binding = bindingFor(deps, onchainCallId, terms);

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
        price: terms.priceAtoms,
        currency: terms.currency,
        pricingVersion: terms.pricingVersion,
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
 * hash/status/confirmations, and grantCloseAt. NO plaintext.
 */
export async function entitlementStatusResponse(input: {
  deps: EntitlementAccessSurfaceDeps;
  onchainCallId: string;
  subscriberAddress: string;
  authHeader?: string | undefined;
}): Promise<EntitlementSurfaceResponse> {
  const { deps, onchainCallId, subscriberAddress } = input;
  if (!BYTES32.test(onchainCallId)) {
    return { status: 400, body: { error: "BadCallId" } };
  }
  if (!ADDRESS.test(subscriberAddress)) {
    return { status: 400, body: { error: "BadSubscriber" } };
  }

  const auth = await verifySubscriberAuth({
    header: input.authHeader,
    subscriberAddress,
    now: deps.access.now(),
  });
  if (auth.kind === "rejected") {
    return { status: auth.status, body: { error: auth.error, message: auth.message } };
  }

  const chain = deps.access.grantChain;
  const view = await chain.readDecryptAccess(onchainCallId, subscriberAddress);
  if (!view || view.state === 0) {
    return { status: 404, body: { error: "CallNotFound" } };
  }

  // Public reveal time comes from the canonical sealed-call record. The chain
  // view now returns the GRANT deadline, so it can no longer supply this.
  const sealed = fhenixSealedCallsRepo.byOnchainCall(deps.access.db, {
    chain_id: chain.chainId,
    contract_address: chain.contractAddress,
    onchain_call_id: onchainCallId,
  });
  // Epoch SECONDS, matching the type this field has always had on the wire.
  // Restoring the key with an ISO string would be just as breaking as removing
  // it — a caller doing arithmetic on it silently gets NaN.
  const publicRevealAtSec = (() => {
    const ms = sealed?.reveal_open_at ? Date.parse(sealed.reveal_open_at) : Number.NaN;
    return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
  })();

  const body = {
    chainId: chain.chainId,
    contract: chain.contractAddress,
    callId: onchainCallId,
    subscriber: subscriberAddress,
    // The public tier reflects only the chain view, never a wallet's local
    // payment, refund, or broadcaster state.
    status: view.alreadyGranted ? "granted" : "none",
    grant: {
      // On-chain source of truth for the subscriber's access.
      onchainGranted: view.alreadyGranted,
    },
    ciphertexts: {
      binaryIndex: { handle: view.binaryIndexCtHash, fheType: BINARY_INDEX_FHE_TYPE },
      confidenceBps: { handle: view.confidenceCtHash, fheType: CONFIDENCE_FHE_TYPE },
    },
    // `grantCloseAt` is when BUYING closes (the prediction window opening).
    // Exposed alongside the reveal time because they used to be the same
    // field and are now days apart — a client that assumed one value would
    // otherwise silently read the wrong deadline.
    //
    // Deliberately NOT re-using the old `revealOpenAt` name for this value:
    // keeping the old key with new semantics is how a caller silently starts
    // trusting the wrong timestamp. Clients still reading `revealOpenAt` get
    // the reveal time, which is what that name always meant.
    grantCloseAt: view.grantCloseAt,
    revealOpenAt: publicRevealAtSec,
    publicRevealAt: publicRevealAtSec,
  };
  if (auth.kind !== "ok") return { status: 200, body };

  const row = entitlementsRepo.byReservation(deps.access.db, {
    chainId: chain.chainId,
    contractAddress: chain.contractAddress,
    onchainCallId,
    subscriberAddress,
  });

  // Confirmed once the grant is terminal-granted, or once a broadcast tx has a
  // successful receipt. The on-chain getDecryptAccess.alreadyGranted above is
  // the authority; this is private local broadcaster detail.
  let confirmations = 0;
  if (row?.grant_tx_hash) {
    const receipt = await chain.getReceipt(row.grant_tx_hash);
    if (receipt?.success) confirmations = receipt.confirmations;
  }
  if (confirmations === 0 && row?.status === "granted") {
    confirmations = 1;
  }

  return {
    status: 200,
    body: {
      ...body,
      status: row?.status ?? "none",
      refundStatus: row?.refund_status ?? null,
      grant: {
        ...body.grant,
        txHash: row?.grant_tx_hash ?? null,
        blockNumber: row?.grant_block_number ?? null,
        confirmations,
        attempts: row?.grant_attempts ?? 0,
      },
      lastError: row?.last_error ? redactedErrorText(row.last_error) : null,
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
  reason:
    | "call_not_found"
    | "not_sealed"
    | "sale_window_closed"
    | "cohort_full"
    | "not_sellable",
): EntitlementSurfaceResponse {
  if (reason === "call_not_found") return { status: 404, body: { error: "CallNotFound" } };
  if (reason === "not_sealed") {
    return { status: 409, body: { error: "CallNotSealed", message: "call is no longer sealed" } };
  }
  if (reason === "not_sellable") {
    // Submitted after the early-access cutoff: the contract refuses to grant
    // it, so selling access would take money for undeliverable access.
    return {
      status: 409,
      body: {
        error: "CallNotSellable",
        message:
          "this call is not proven sellable: its on-chain submission class is " +
          "not EarlyAccess, or was never recorded",
      },
    };
  }
  if (reason === "cohort_full") {
    // 409, not 402: this is not a payment problem and retrying with money will
    // not help. The call's cohort is full for everyone.
    return {
      status: 409,
      body: {
        error: "CohortFull",
        message: "this call has reached its maximum number of armed subscribers",
      },
    };
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
  /** Persists the payload-hash → resource binding. See authorize() below. */
  db: Database.Database;
  now: () => Date;
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
        return gatewayUnavailable(err);
      }
      if (!canonical || canonicalize(canonical) !== canonicalize(parsed.accepted)) {
        return brokerError(402, "PaymentRequirementsMismatch", "not the canonical server challenge");
      }
      let verify: Awaited<ReturnType<GatewayMiddleware["verify"]>>;
      try {
        verify = await deps.gateway.verify(parsed.paymentPayload, canonical);
      } catch (err) {
        return gatewayUnavailable(err);
      }
      if (!verify.valid) {
        return brokerError(402, "PaymentVerificationFailed", safeReason(verify.error));
      }
      if (verify.payer && verify.payer.toLowerCase() !== parsed.payer.toLowerCase()) {
        return brokerError(402, "PaymentVerificationFailed", "verified payer does not match authorization");
      }

      // Bind this payment to THIS resource, and enforce it.
      //
      // AFTER verification, deliberately. Binding first meant an unverified
      // header wrote a permanent row: the local parser accepts any
      // address-shaped `from` and any nonempty nonce, so anyone holding the
      // public 402 challenge could write unbounded junk into this table with
      // invalid signatures, and nothing cleans it up. Concurrency is still
      // safe — bind() serializes verified presentations on its own.
      //
      // Both hashes used to be computed and thrown away (`void ...`) under a
      // comment claiming the entitlement reservation was the real guard. It
      // is not: the reservation is unique per (call, subscriber), so the same
      // signed header replayed against a DIFFERENT call at the same price
      // passed every local check — only the facilitator's nonce handling
      // stood in the way, which is not a guarantee this service makes.
      //
      // A repeat of the SAME purchase re-presents the same fingerprint and is
      // allowed through (clients do retry).
      const resourceFingerprint =
        `${binding.chainId}:${binding.contractAddress}:${binding.onchainCallId}:${binding.pricingVersion}`;
      // Keyed on the SIGNED authorization, not on a hash of the whole decoded
      // envelope. `accepted` and `resource` sit OUTSIDE the EIP-712 signature
      // — it covers from/to/value/validity/nonce — so hashing the envelope let
      // the same signed authorization be re-encoded with a different
      // `resource`, produce a different hash, and claim a second call. The
      // nonce is what the facilitator itself replay-protects on; keying on it
      // makes this check agree with that boundary instead of sitting beside it.
      if (!parsed.nonce) {
        return brokerError(
          400,
          "MalformedPayment",
          "payment authorization carries no nonce",
        );
      }
      const payloadHash = paymentPayloadHash({
        network: parsed.accepted.network,
        payTo: parsed.accepted.payTo.toLowerCase(),
        amount: parsed.accepted.amount,
        from: parsed.payer,
        nonce: parsed.nonce,
      });
      const requirementsHash = paymentRequirementsHash({
        pipelineId: resourceFingerprint,
        paymentRequirements: canonical,
      });
      const bound = entitlementPaymentBindingsRepo.bind(deps.db, {
        payload_hash: payloadHash,
        resource_fingerprint: resourceFingerprint,
        requirements_hash: requirementsHash,
        now_iso: deps.now().toISOString(),
      });
      if (!bound) {
        return brokerError(
          402,
          "PaymentRequirementsMismatch",
          "this payment was already presented for a different resource",
        );
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
              currency: binding.currency,
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

/** Logs the provider's message and returns one the buyer can safely see. */
function gatewayUnavailable(err: unknown): BrokerAuthorization {
  console.warn(`[entitlement-access] payment gateway error: ${redactedErrorText(messageFrom(err))}`);
  return brokerError(503, "PaymentGatewayUnavailable", "The payment service is unavailable. Try again shortly.");
}

/** Keeps short machine codes (e.g. insufficient_balance); anything else is withheld. */
function safeReason(reason: string | undefined): string {
  return reason && /^[A-Za-z0-9_.-]{1,64}$/.test(reason) ? reason : "payment verification failed";
}

function messageFrom(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
