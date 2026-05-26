import { Router, type Request, type Response, type NextFunction } from "express";
import type Database from "better-sqlite3";
import { keccak256, toHex } from "viem";

import {
  nanopayReceiptsRepo,
  type NanopayReceiptRow,
} from "../repos/nanopay-receipts-repo.js";
import {
  computeRequestSignalId,
  serializeBinding,
  type DomainParams,
  type FhenixAnchorTuple,
  type NanopayBinding,
} from "../single-stream-binding.js";
import {
  createGatewayMiddleware,
  paymentPayloadHash,
  paymentRequirementsHash,
  type GatewayMiddleware,
  type PaymentRequest,
  DEFAULT_TESTNET_FACILITATOR_URL,
  DEFAULT_MAINNET_FACILITATOR_URL,
} from "../../integrations/circle-gateway.js";

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

export interface NanopayRouterDeps {
  readonly db: Database.Database;
  /**
   * Resolves a pipeline by id → price + recipient. Phase 1 stub
   * returns null; Phase 2 wires a real catalog. Route returns 404
   * when this returns null.
   */
  readonly resolvePipeline: (pipelineId: string) => PipelineInfo | null;
  /**
   * Resolves the latest sealed-Fhenix call for a pipeline → full
   * anchor tuple + reveal artifact (or null if pre-reveal). Route
   * returns 503 when this returns null.
   */
  readonly resolveLatestSealedCall: (
    pipelineId: string,
  ) => { anchor: FhenixAnchorTuple; revealArtifact: unknown | null } | null;
  /** Network — defaults to testnet for Phase 1. */
  readonly network?: "testnet" | "mainnet";
  /** EIP-712 domain for `requestSignalId` hashing. */
  readonly bindingDomain: DomainParams;
  /** Seller wallet that receives Nanopayments. */
  readonly sellerAddress: `0x${string}`;
  /**
   * Optional CAIP-2 network restrictions for the SDK middleware.
   * If omitted, the SDK accepts payments on ALL Gateway-supported
   * networks (recommended). Example: `["eip155:84532"]` for
   * Base-Sepolia-only.
   */
  readonly acceptNetworks?: string[];
  /**
   * Default per-call price in dollar string form (e.g. "$0.001"),
   * used as the `gateway.require(price)` argument. The SDK
   * converts this to USDC atomic units via its money-parser
   * registry. Phase 1: pipelines all share the same default; Phase 2
   * will switch to per-pipeline pricing.
   *
   * Note: pipeline-specific pricing requires generating one middleware
   * per pipeline OR passing dynamic price through the SDK; defer.
   */
  readonly defaultPrice?: string;
}

export interface PipelineInfo {
  /** USDC atoms (6-decimal) per call. */
  readonly priceAtoms: string;
  /** Address that receives the settled payment. */
  readonly recipient: `0x${string}`;
  /** Chain id where the recipient holds their Gateway Wallet. */
  readonly chainId: number;
  /** Optional human-readable description; do NOT include in 402 headers (privacy). */
  readonly internalDescription?: string;
}

/**
 * Construct a Nanopayments router. Mounted on the daemon at the root;
 * the router itself prefixes its paths with `/v2/nanopay/`.
 */
export function createNanopayRouter(deps: NanopayRouterDeps): Router {
  const router = Router();
  const network = deps.network ?? "testnet";
  const facilitatorUrl =
    network === "testnet"
      ? DEFAULT_TESTNET_FACILITATOR_URL
      : DEFAULT_MAINNET_FACILITATOR_URL;

  // Single shared middleware instance — the SDK handles 402 challenge
  // construction (with correct Base64-encoded x402 V2 headers + correct
  // GatewayWalletBatched EIP-712 domain) and Circle /v1/x402/settle.
  const gateway: GatewayMiddleware = createGatewayMiddleware({
    sellerAddress: deps.sellerAddress,
    networks: deps.acceptNetworks,
    facilitatorUrl,
    description: "Murmur per-call paid inference",
  });

  const price = deps.defaultPrice ?? "$0.001";

  router.post(
    "/v2/nanopay/infer/:pipelineId",
    // CRITICAL: pre-middleware servable-check runs BEFORE
    // `gateway.require(price)` so we don't charge a buyer when we
    // know we can't serve. Codex audit 2026-05-23 flagged the
    // paid-but-unserved black hole when stubs return null after
    // settlement; this check moves the failure to BEFORE Circle
    // settles. The resolvers are expected to be stable within a
    // request (read from local DB), so a successful pre-check
    // implies a successful post-settle resolution under normal
    // conditions. Race-window failures still hit the
    // settled-but-unservable path, which logs + alerts for operator
    // reconciliation.
    preflightServable(deps),
    gateway.require(price),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        await handleAfterPayment(req as Request & PaymentRequest, res, deps);
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}

/**
 * Pre-middleware servable check. Rejects the request BEFORE the SDK
 * middleware settles payment if:
 *   - pipelineId path param is malformed.
 *   - resolvePipeline returns null (unknown pipeline).
 *   - resolveLatestSealedCall returns null (no signal anchored yet).
 *
 * Buyers don't get charged in any of these cases. Operator visibility
 * is via standard 4xx/5xx responses + access logs.
 */
function preflightServable(deps: NanopayRouterDeps) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const pipelineId = extractPipelineId(req);
    if (!pipelineId) {
      res
        .status(400)
        .json({ error: "BadPipelineId", message: "pipelineId must be 32-byte hex" });
      return;
    }
    const pipeline = deps.resolvePipeline(pipelineId);
    if (!pipeline) {
      res.status(404).json({ error: "PipelineNotFound", pipelineId });
      return;
    }
    const sealedCall = deps.resolveLatestSealedCall(pipelineId);
    if (!sealedCall) {
      res.status(503).json({
        error: "NoSignalAvailable",
        message:
          "Pipeline has no anchored sealed-Fhenix call yet; retry once the agent has submitted.",
      });
      return;
    }
    next();
  };
}

export const nanopayRouter = (deps: NanopayRouterDeps): Router =>
  createNanopayRouter(deps);

/**
 * Runs AFTER the SDK middleware has verified + settled the payment.
 * `req.payment` carries `{verified, payer, amount, network, transaction}`.
 */
async function handleAfterPayment(
  req: Request & PaymentRequest,
  res: Response,
  deps: NanopayRouterDeps,
): Promise<void> {
  const payment = req.payment;
  if (!payment || !payment.verified) {
    // Should not happen — the middleware would have rejected.
    res
      .status(500)
      .json({ error: "PaymentMissing", message: "middleware did not populate payment" });
    return;
  }
  // SDK marks `payment.transaction` optional. Narrow before any
  // downstream use; absence here means the SDK middleware set
  // `verified: true` without finishing settle — a bug we surface
  // rather than swallow.
  if (!payment.transaction || !payment.payer || !payment.amount || !payment.network) {
    console.error(
      "[nanopay] middleware reported verified payment with missing fields:",
      payment,
    );
    res
      .status(500)
      .json({ error: "PaymentFieldsIncomplete" });
    return;
  }

  // ── Validate pipelineId path param ────────────────────────────────────
  // Should never fail here because preflightServable already rejected
  // bad pipelineIds before the middleware charged the buyer. Defense
  // in depth in case the router wiring changes.
  const pipelineId = extractPipelineId(req);
  if (!pipelineId) {
    console.error(
      `[nanopay] settled payment ${payment.transaction} reached handler without valid pipelineId; operator reconciliation required`,
    );
    res
      .status(500)
      .json({ error: "BadPipelineId", message: "pipelineId narrowing failed post-preflight" });
    return;
  }

  const pipeline = deps.resolvePipeline(pipelineId);
  if (!pipeline) {
    console.error(
      `[nanopay] settled payment ${payment.transaction} for unknown pipeline ${pipelineId}; operator reconciliation required`,
    );
    res.status(404).json({ error: "PipelineNotFound", pipelineId });
    return;
  }

  // ── Validate paid amount matches the pipeline (defense-in-depth) ──
  // The SDK middleware advertised the pipeline's price as a payment
  // requirement, so this should always match. Recipient safety comes
  // from the env parser, which rejects per-pipeline entries whose
  // recipient differs from MURMUR_NANOPAY_SELLER_ADDRESS at boot.
  if (BigInt(payment.amount) < BigInt(pipeline.priceAtoms)) {
    console.error(
      `[nanopay] settled payment ${payment.transaction} amount ${payment.amount} < pipeline price ${pipeline.priceAtoms}; refusing to serve`,
    );
    res.status(402).json({
      error: "PaymentInsufficient",
      message: "Settled amount less than pipeline price",
    });
    return;
  }

  // ── Resolve latest sealed-Fhenix call for this pipeline ───────────────
  const sealedCall = deps.resolveLatestSealedCall(pipelineId);
  if (!sealedCall) {
    console.error(
      `[nanopay] settled payment ${payment.transaction} for pipeline ${pipelineId} but no sealed call available; operator reconciliation required`,
    );
    res.status(503).json({
      error: "NoSignalAvailable",
      message: "Pipeline has no anchored sealed-Fhenix call yet; retry shortly",
    });
    return;
  }

  // ── Compute composite idempotency key components ──────────────────────
  // The SDK doesn't expose the raw EIP-3009 nonce post-middleware, so we
  // use the Circle transaction UUID as the unique replay-prevention key.
  // (Circle ensures one settled transaction per signed nonce; UUID is
  // the durable handle.) Hash-based composite key columns get values
  // derived from the post-settle data we have.
  //
  // Address normalization: payer comes from the SDK middleware (already
  // verified); we lowercase to match repo conventions.
  const payer = payment.payer.toLowerCase() as `0x${string}`;
  // source_domain captures the Gateway network the payment landed on.
  // Format `caip2:<network>` so future cross-chain attribution stays
  // disambiguated.
  const sourceDomain = `caip2:${payment.network}`;
  // The Circle transaction UUID is the payment handle — globally unique
  // per Circle settlement, it's the durable replay-prevention key the
  // daemon owns post-middleware. (The raw EIP-3009 nonce is consumed by
  // the SDK middleware before this handler runs.) Phase 1b renamed the
  // schema column from `eip3009_nonce` to `payment_handle` to stop the
  // semantic lie; the binding-wire field below keeps the historical
  // `eip3009Nonce` name for buyer-side backwards compat (Phase 2 will
  // version the wire shape).
  const paymentHandle = payment.transaction;
  // Hash inputs are canonical post-settle artifacts. Stable across
  // restarts because the transaction UUID + amount + payer are
  // immutable once Circle settles.
  const requirementsHash = paymentRequirementsHash({
    sellerAddress: deps.sellerAddress,
    pipelineId,
    network: payment.network,
  });
  const payloadHash = paymentPayloadHash({
    transaction: payment.transaction,
    payer,
    amount: payment.amount,
  });

  // ── Compute requestSignalId binding ───────────────────────────────────
  // `eip3009Nonce` here is the binding-wire field name; the actual value
  // is a digest of the payment handle (Circle's transaction UUID),
  // because the SDK middleware consumed the raw EIP-3009 nonce before
  // we got control. See `paymentHandle` comment above.
  const paymentHandleDigest = transactionUuidToBytes32(paymentHandle);
  const requestSignalId = computeRequestSignalId({
    pipelineId: pipelineId as `0x${string}`,
    buyer: payer,
    eip3009Nonce: paymentHandleDigest,
    domain: deps.bindingDomain,
  });

  const binding: NanopayBinding = {
    pipelineId: pipelineId as `0x${string}`,
    buyerAddress: payer,
    requestSignalId,
    eip3009Nonce: paymentHandleDigest,
    circleTransactionUuid: payment.transaction,
    anchor: sealedCall.anchor,
  };

  // ── Insert nanopay_receipts row (status='settled' directly) ──────────
  // Per the SDK-pivot deviation from the original design: receipts are
  // inserted AFTER settle (the SDK middleware already settled before
  // this handler runs). The prefix UNIQUE on (payer, payment_handle,
  // source_domain) — renamed from eip3009_nonce in v52 — catches
  // concurrent identical inserts → serve cached.
  let receiptId: number;
  try {
    receiptId = nanopayReceiptsRepo.insertSettled(deps.db, {
      payer,
      paymentHandle,
      sourceDomain,
      paymentPayloadHash: payloadHash,
      paymentRequirementsHash: requirementsHash,
      pipelineId,
      requestSignalId,
      paidAmountUsdcAtoms: payment.amount,
      bindingJson: serializeBinding(binding),
      revealArtifactJson:
        sealedCall.revealArtifact !== null
          ? JSON.stringify(sealedCall.revealArtifact)
          : null,
      circleTransactionUuid: payment.transaction,
    });
  } catch (err) {
    if (
      err &&
      typeof err === "object" &&
      "code" in err &&
      (err as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE"
    ) {
      const existing = nanopayReceiptsRepo.findByPayerHandleDomain(deps.db, {
        payer,
        paymentHandle,
        sourceDomain,
      });
      if (existing && existing.status === "settled") {
        respondWithReceipt(res, existing);
        return;
      }
      res
        .status(500)
        .json({ error: "InternalStateInconsistent", message: "duplicate insert without existing settled row" });
      return;
    }
    throw err;
  }

  // ── Serve signal + binding ────────────────────────────────────────────
  res.status(200).json({
    binding,
    revealArtifact: sealedCall.revealArtifact,
    receiptId,
  });
}

/**
 * Respond with a previously-cached settled receipt — used on replay.
 */
function respondWithReceipt(res: Response, row: NanopayReceiptRow): void {
  const binding = JSON.parse(row.binding_json) as NanopayBinding;
  const revealArtifact = row.reveal_artifact_json
    ? JSON.parse(row.reveal_artifact_json)
    : null;
  res
    .status(200)
    .json({ binding, revealArtifact, receiptId: row.id, replayed: true });
}

/**
 * Hash an arbitrary string to a deterministic 32-byte hex handle.
 * Circle's `transaction` UUID isn't 32 bytes; we keccak256 it to get
 * a stable bytes32 we can put in the binding's `eip3009Nonce` slot.
 *
 * Note: the binding-field name `eip3009Nonce` is a misnomer in the
 * SDK-pivot flow — we don't see the raw EIP-3009 nonce because the
 * SDK middleware consumed + verified it before our handler runs.
 * Callers should treat this as a "settlement-handle digest" tying
 * the binding to Circle's transaction UUID rather than to the
 * buyer's signed nonce. Phase 1b (v52) renamed the schema column
 * from `eip3009_nonce` to `payment_handle`; the binding-wire field
 * name above keeps the legacy `eip3009Nonce` slot for buyer-side
 * backwards compat until Phase 2 versions the wire shape.
 */
function transactionUuidToBytes32(uuid: string): `0x${string}` {
  return keccak256(toHex(uuid));
}

/**
 * Extract + narrow `req.params.pipelineId` to a 32-byte hex string.
 * Express 5's `req.params[k]` is typed `string | string[] | undefined`
 * because of repeated-param semantics. Single-segment routes always
 * yield a string at runtime, but the type signature still requires
 * narrowing.
 *
 * Returns null on any malformed input.
 */
function extractPipelineId(req: Request): string | null {
  const raw = req.params.pipelineId;
  if (typeof raw !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(raw)) {
    return null;
  }
  return raw;
}
