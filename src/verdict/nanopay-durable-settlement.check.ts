import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { NextFunction, Request, Response } from "express";

import type { PaymentRequest } from "../integrations/circle-gateway.js";
import { openDb } from "./db-bootstrap.js";
import {
  createNanopayPaymentGate,
  type NanopayGatewayFactory,
} from "./nanopay-payment-gate.js";
import type { NanopayRouterDeps } from "./nanopay-types.js";
import type { FhenixAnchorTuple } from "./single-stream-binding.js";

class FakeResponse {
  statusCode = 200;
  body: unknown = null;
  readonly headers = new Map<string, string>();

  status(code: number): this {
    this.statusCode = code;
    return this;
  }

  json(body: unknown): this {
    this.body = body;
    return this;
  }

  setHeader(name: string, value: string): void {
    this.headers.set(name.toLowerCase(), value);
  }

  end(body?: string): void {
    this.body = body ? JSON.parse(body) : null;
  }
}

process.stdout.write("murmur nanopay durable settlement smoke\n");

const tmp = mkdtempSync(join(tmpdir(), "murmur-nanopay-durable-settlement-"));

try {
  const db = openDb({ path: join(tmp, "test.db") });
  const pipelineId = `0x${"1".repeat(64)}`;
  const otherPipelineId = `0x${"f".repeat(64)}`;
  const sellerAddress = `0x${"2".repeat(40)}` as `0x${string}`;
  const payer = `0x${"a".repeat(40)}` as `0x${string}`;
  const gatewayWallet = `0x${"3".repeat(40)}` as `0x${string}`;
  const nonce = `0x${"4".repeat(64)}` as `0x${string}`;
  let catalogAvailable = true;
  const now = () => new Date("2026-07-10T10:00:00Z");
  const anchor: FhenixAnchorTuple = {
    bindingVersion: 1,
    chainId: 84532,
    sealedVerdictsContractAddress: `0x${"5".repeat(40)}`,
    onchainCallId: `0x${"6".repeat(64)}`,
    marketId: "nanopay-market",
    agent: `0x${"7".repeat(40)}`,
    submitTxHash: `0x${"8".repeat(64)}`,
    submitLogIndex: 1,
    binaryIndexCiphertextHash: `0x${"9".repeat(64)}`,
    confidenceCiphertextHash: `0x${"a".repeat(64)}`,
    revealOpenAt: "2026-07-10T09:00:00Z",
    commitScheme: "fhenix-sealed-v1",
    commitHash: "b".repeat(64),
  };
  const deps: NanopayRouterDeps = {
    db,
    bindingDomain: {
      chainId: 84532,
      verifyingContract: `0x${"c".repeat(40)}`,
    },
    sellerAddress,
    now,
    defaultPrice: "$0.001",
    resolvePipeline: (id) =>
      catalogAvailable && (id === pipelineId || id === otherPipelineId)
        ? { priceAtoms: "1000", recipient: sellerAddress, chainId: 84532 }
        : null,
    resolveLatestSealedCall: (id) =>
      catalogAvailable && (id === pipelineId || id === otherPipelineId)
        ? { anchor, revealArtifact: { verdict: "UP", confidence: 0.75 } }
        : null,
  };
  const requirements = {
    scheme: "exact",
    network: "eip155:84532",
    asset: `0x${"d".repeat(40)}`,
    amount: "1000",
    payTo: sellerAddress,
    maxTimeoutSeconds: 604_860,
    extra: {
      name: "GatewayWalletBatched",
      version: "1",
      verifyingContract: gatewayWallet,
    },
  };
  const paymentPayload = makePaymentPayload({
    requirements,
    payer,
    sellerAddress,
    nonce,
    signatureDigit: "e",
  });
  const paymentHeader = encodePayment(paymentPayload);

  let verifyValid = true;
  let settlementError: Error | null = null;
  let statusDuringSettlement: string | null = null;
  let settleCalls = 0;
  const fakeGatewayFactory = (() => ({
    require() {
      return ((req: Request & PaymentRequest, res: Response, next: NextFunction) => {
        if (req.headers["payment-signature"] === undefined) {
          res.statusCode = 402;
          res.setHeader(
            "PAYMENT-REQUIRED",
            Buffer.from(
              JSON.stringify({
                x402Version: 2,
                resource: {
                  url: req.url,
                  description: "Murmur per-call paid inference",
                  mimeType: "application/json",
                },
                accepts: [requirements],
              }),
            ).toString("base64"),
          );
          res.end?.(JSON.stringify({}));
          return;
        }
        statusDuringSettlement = currentReceiptStatus(db);
        req.payment = {
          verified: true,
          payer,
          amount: "1000",
          network: requirements.network,
          transaction: "legacy-circle-transaction",
        };
        next();
      }) as ReturnType<ReturnType<NanopayGatewayFactory>["require"]>;
    },
    async paymentRequirements() {
      return requirements;
    },
    async verify() {
      return verifyValid
        ? { valid: true, payer }
        : { valid: false, error: "bad signature" };
    },
    async settle() {
      settleCalls += 1;
      statusDuringSettlement = currentReceiptStatus(db);
      if (settlementError) throw settlementError;
      return {
        success: true,
        payer,
        transaction: "circle-transaction-1",
        network: requirements.network,
      };
    },
  })) as unknown as NanopayGatewayFactory;

  const gate = createNanopayPaymentGate(deps, fakeGatewayFactory);

  const challengeReq = {
    params: { pipelineId },
    headers: {},
    url: `/v2/nanopay/infer/${pipelineId}`,
  } as unknown as Request & PaymentRequest;
  const challengeRes = new FakeResponse();
  await gate.requirePayment(
    challengeReq,
    challengeRes as unknown as Response,
    () => assert.fail("a payment challenge must terminate the request"),
  );
  assert.equal(challengeRes.statusCode, 402);
  const challenge = JSON.parse(
    Buffer.from(challengeRes.headers.get("payment-required")!, "base64").toString("utf8"),
  ) as { x402Version: number; accepts: unknown[] };
  assert.equal(challenge.x402Version, 2);
  assert.deepEqual(challenge.accepts, [requirements]);
  assert.equal(currentReceiptStatus(db), null);

  verifyValid = false;
  const rejectedHeader = encodePayment(
    makePaymentPayload({
      requirements,
      payer,
      sellerAddress,
      nonce: `0x${"5".repeat(64)}`,
      signatureDigit: "f",
    }),
  );
  const rejectedReq = {
    params: { pipelineId },
    headers: { "payment-signature": rejectedHeader },
    url: `/v2/nanopay/infer/${pipelineId}`,
  } as unknown as Request & PaymentRequest;
  const rejectedRes = new FakeResponse();
  await gate.requirePayment(
    rejectedReq,
    rejectedRes as unknown as Response,
    () => assert.fail("an invalid payment must not reach the handler"),
  );
  assert.equal(rejectedRes.statusCode, 402);
  assert.deepEqual(rejectedRes.body, {
    error: "PaymentVerificationFailed",
    reason: "bad signature",
  });
  assert.equal(currentReceiptStatus(db), null, "verification failure must not poison a nonce");
  assert.equal(settleCalls, 0);
  verifyValid = true;

  /*
   * Happy path: the fake Circle boundary reads SQLite synchronously from
   * inside settle(), proving the intent committed before the side effect.
   */
  const req = {
    params: { pipelineId },
    headers: { "payment-signature": paymentHeader },
    url: `/v2/nanopay/infer/${pipelineId}`,
  } as unknown as Request & PaymentRequest;
  const res = new FakeResponse();
  let nextCalls = 0;
  await gate.requirePayment(
    req,
    res as unknown as Response,
    () => {
      nextCalls += 1;
    },
  );

  assert.equal(
    statusDuringSettlement,
    "settling",
    "the intent must be durable before Circle settlement begins",
  );
  assert.equal(settleCalls, 1);
  assert.equal(nextCalls, 1);
  assert.equal(currentReceiptStatus(db), "settled");
  assert.deepEqual(decodeHeader(res, "payment-response"), {
    success: true,
    transaction: "circle-transaction-1",
    network: requirements.network,
    payer,
  });

  await gate.afterPayment(
    req,
    res as unknown as Response,
    (() => undefined) as NextFunction,
  );
  assert.equal(res.statusCode, 200);
  const body = res.body as {
    binding: { eip3009Nonce: string; circleTransactionUuid: string | null };
    receiptId: number;
  };
  assert.equal(body.binding.eip3009Nonce, nonce);
  assert.equal(body.binding.circleTransactionUuid, "circle-transaction-1");
  assert.ok(body.receiptId > 0);

  const firstReceiptId = body.receiptId;
  const replayReq = {
    params: { pipelineId },
    headers: { "payment-signature": paymentHeader },
    url: `/v2/nanopay/infer/${pipelineId}`,
  } as unknown as Request & PaymentRequest;
  const replayRes = new FakeResponse();
  let replayNextCalls = 0;
  catalogAvailable = false;
  await gate.requirePayment(
    replayReq,
    replayRes as unknown as Response,
    () => {
      replayNextCalls += 1;
    },
  );
  assert.equal(settleCalls, 1, "an exact replay must not call Circle settle twice");
  assert.equal(replayNextCalls, 1);
  assert.deepEqual(decodeHeader(replayRes, "payment-response"), {
    success: true,
    transaction: "circle-transaction-1",
    network: requirements.network,
    payer,
  });
  await gate.afterPayment(
    replayReq,
    replayRes as unknown as Response,
    (() => undefined) as NextFunction,
  );
  assert.equal(replayRes.statusCode, 200);
  assert.equal((replayRes.body as { receiptId: number }).receiptId, firstReceiptId);

  catalogAvailable = true;

  const crossPipelineReq = {
    params: { pipelineId: otherPipelineId },
    headers: { "payment-signature": paymentHeader },
    url: `/v2/nanopay/infer/${otherPipelineId}`,
  } as unknown as Request & PaymentRequest;
  const crossPipelineRes = new FakeResponse();
  await gate.requirePayment(
    crossPipelineReq,
    crossPipelineRes as unknown as Response,
    () => assert.fail("an authorization bound to another pipeline must not serve"),
  );
  assert.equal(crossPipelineRes.statusCode, 409);
  assert.equal(
    (crossPipelineRes.body as { error: string }).error,
    "PaymentReplayConflict",
  );
  assert.equal(settleCalls, 1);

  const changedPayloadReq = {
    params: { pipelineId },
    headers: {
      "payment-signature": encodePayment({
        ...paymentPayload,
        payload: {
          ...paymentPayload.payload,
          signature: `0x${"1".repeat(130)}`,
        },
      }),
    },
    url: `/v2/nanopay/infer/${pipelineId}`,
  } as unknown as Request & PaymentRequest;
  const changedPayloadRes = new FakeResponse();
  await gate.requirePayment(
    changedPayloadReq,
    changedPayloadRes as unknown as Response,
    () => assert.fail("a nonce collision must not reach the handler"),
  );
  assert.equal(changedPayloadRes.statusCode, 409);
  assert.equal((changedPayloadRes.body as { error: string }).error, "PaymentReplayConflict");
  assert.equal(settleCalls, 1);

  settlementError = new Error("socket closed after request write");
  const unknownNonce = `0x${"6".repeat(64)}` as `0x${string}`;
  const unknownHeader = encodePayment(
    makePaymentPayload({
      requirements,
      payer,
      sellerAddress,
      nonce: unknownNonce,
      signatureDigit: "2",
    }),
  );
  const unknownReq = {
    params: { pipelineId },
    headers: { "payment-signature": unknownHeader },
    url: `/v2/nanopay/infer/${pipelineId}`,
  } as unknown as Request & PaymentRequest;
  const unknownRes = new FakeResponse();
  await gate.requirePayment(
    unknownReq,
    unknownRes as unknown as Response,
    () => assert.fail("unknown settlement state must not serve"),
  );
  assert.equal(unknownRes.statusCode, 503);
  assert.equal(unknownRes.headers.get("retry-after"), "60");
  assert.equal((unknownRes.body as { error: string }).error, "PaymentSettlementPending");
  assert.equal(receiptStatusForHandle(db, unknownNonce), "settling");
  assert.equal(settleCalls, 2);

  settlementError = null;
  const unknownReplayRes = new FakeResponse();
  await gate.requirePayment(
    unknownReq,
    unknownReplayRes as unknown as Response,
    () => assert.fail("stuck settling replay must not serve"),
  );
  assert.equal(unknownReplayRes.statusCode, 503);
  assert.equal(settleCalls, 2, "a stuck intent requires reconciliation, not blind re-settle");

  db.close();
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

process.stdout.write("nanopay durable settlement smoke ok\n");

function currentReceiptStatus(db: NanopayRouterDeps["db"]): string | null {
  const row = db
    .prepare("SELECT status FROM nanopay_receipts ORDER BY id DESC LIMIT 1")
    .get() as { status: string } | undefined;
  return row?.status ?? null;
}

function receiptStatusForHandle(
  db: NanopayRouterDeps["db"],
  paymentHandle: string,
): string | null {
  const row = db
    .prepare("SELECT status FROM nanopay_receipts WHERE payment_handle = ?")
    .get(paymentHandle.toLowerCase()) as { status: string } | undefined;
  return row?.status ?? null;
}

function makePaymentPayload(input: {
  requirements: Record<string, unknown>;
  payer: `0x${string}`;
  sellerAddress: `0x${string}`;
  nonce: `0x${string}`;
  signatureDigit: string;
}) {
  return {
    x402Version: 2,
    accepted: input.requirements,
    payload: {
      signature: `0x${input.signatureDigit.repeat(130)}`,
      authorization: {
        from: input.payer,
        to: input.sellerAddress,
        value: "1000",
        validAfter: "0",
        validBefore: "9999999999",
        nonce: input.nonce,
      },
    },
  };
}

function encodePayment(payload: unknown): string {
  return Buffer.from(JSON.stringify(payload)).toString("base64");
}

function decodeHeader(response: FakeResponse, name: string): unknown {
  const encoded = response.headers.get(name);
  assert.ok(encoded, `missing ${name} header`);
  return JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as unknown;
}
