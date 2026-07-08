import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PaymentRequest } from "../integrations/circle-gateway.js";
import { openDb } from "./db-bootstrap.js";
import {
  nanopaySettlementResponse,
  sendNanopaySettlementJsonResponse,
} from "./nanopay-settlement-surface.js";
import type { NanopayRouterDeps } from "./nanopay-types.js";
import { nanopayReceiptsRepo } from "./repos/nanopay-receipts-repo.js";
import type { FhenixAnchorTuple } from "./single-stream-binding.js";

const tmp = mkdtempSync(join(tmpdir(), "murmur-nanopay-settlement-surface-"));
const dbPath = join(tmp, "test.db");

try {
  process.stdout.write("murmur nanopay settlement surface smoke\n");
  const db = openDb({ path: dbPath });
  const pipelineId = `0x${"1".repeat(64)}`;
  const sellerAddress = `0x${"2".repeat(40)}` as `0x${string}`;
  const now = () => new Date("2026-06-12T10:05:00Z");
  const logger = {
    errors: [] as unknown[][],
    error(...args: unknown[]) {
      this.errors.push(args);
    },
  };
  const anchor: FhenixAnchorTuple = {
    bindingVersion: 1,
    chainId: 84532,
    sealedVerdictsContractAddress: `0x${"3".repeat(40)}`,
    onchainCallId: `0x${"4".repeat(64)}`,
    marketId: "nanopay-market",
    agent: `0x${"5".repeat(40)}`,
    submitTxHash: `0x${"6".repeat(64)}`,
    submitLogIndex: 7,
    binaryIndexCiphertextHash: `0x${"7".repeat(64)}`,
    confidenceCiphertextHash: `0x${"8".repeat(64)}`,
    revealOpenAt: "2026-06-12T10:00:00Z",
    commitScheme: "fhenix-sealed-v1",
    commitHash: "a".repeat(64),
  };
  const deps: NanopayRouterDeps = {
    db,
    bindingDomain: {
      chainId: 84532,
      verifyingContract: `0x${"9".repeat(40)}`,
    },
    sellerAddress,
    now,
    resolvePipeline: (id) =>
      id === pipelineId
        ? { priceAtoms: "1000", recipient: sellerAddress, chainId: 84532 }
        : null,
    resolveLatestSealedCall: (id) =>
      id === pipelineId
        ? { anchor, revealArtifact: { verdict: "UP", confidence: 0.72 } }
        : null,
  };
  const payment: NonNullable<PaymentRequest["payment"]> = {
    verified: true,
    payer: `0x${"A".repeat(40)}`,
    amount: "1000",
    network: "eip155:84532",
    transaction: "circle-transaction-1",
  };

  assert.deepEqual(
    nanopaySettlementResponse({
      deps,
      pipelineId,
      payment: undefined,
      now,
      logger,
    }),
    {
      status: 500,
      body: {
        error: "PaymentMissing",
        message: "middleware did not populate payment",
      },
    },
  );

  assert.equal(
    nanopaySettlementResponse({
      deps,
      pipelineId,
      payment: { ...payment, transaction: undefined },
      now,
      logger,
    }).status,
    500,
  );

  assert.deepEqual(
    nanopaySettlementResponse({
      deps,
      pipelineId: null,
      payment,
      now,
      logger,
    }),
    {
      status: 500,
      body: {
        error: "BadPipelineId",
        message: "pipelineId narrowing failed post-preflight",
      },
    },
  );

  assert.deepEqual(
    nanopaySettlementResponse({
      deps,
      pipelineId: `0x${"b".repeat(64)}`,
      payment,
      now,
      logger,
    }),
    {
      status: 404,
      body: {
        error: "PipelineNotFound",
        pipelineId: `0x${"b".repeat(64)}`,
      },
    },
  );

  assert.deepEqual(
    nanopaySettlementResponse({
      deps,
      pipelineId,
      payment: { ...payment, amount: "999", transaction: "circle-insufficient" },
      now,
      logger,
    }),
    {
      status: 402,
      body: {
        error: "PaymentInsufficient",
        message: "Settled amount less than pipeline price",
      },
    },
  );

  const noSignal = nanopaySettlementResponse({
    deps: { ...deps, resolveLatestSealedCall: () => null },
    pipelineId,
    payment: { ...payment, transaction: "circle-no-signal" },
    now,
    logger,
  });
  assert.equal(noSignal.status, 503);

  const first = nanopaySettlementResponse({
    deps,
    pipelineId,
    payment,
    now,
    logger,
  });
  assert.equal(first.status, 200);
  const firstBody = first.body as {
    binding: { buyerAddress: string; pipelineId: string; requestSignalId: string };
    receiptId: number;
    revealArtifact: unknown;
  };
  assert.equal(firstBody.binding.pipelineId, pipelineId);
  assert.equal(firstBody.binding.buyerAddress, payment.payer!.toLowerCase());
  assert.match(firstBody.binding.requestSignalId, /^0x[0-9a-f]{64}$/);
  assert.deepEqual(firstBody.revealArtifact, { verdict: "UP", confidence: 0.72 });
  assert.ok(firstBody.receiptId > 0);
  const firstRow = nanopayReceiptsRepo.findById(db, firstBody.receiptId);
  assert.equal(firstRow?.created_at, "2026-06-12T10:05:00Z");
  assert.equal(firstRow?.settled_at, "2026-06-12T10:05:00Z");
  const firstTarget = makeStatusJsonTarget();
  sendNanopaySettlementJsonResponse(firstTarget, first);
  assert.equal(firstTarget.statusCode, 200);
  assert.equal(firstTarget.body, first.body);

  const replay = nanopaySettlementResponse({
    deps,
    pipelineId,
    payment,
    now,
    logger,
  });
  assert.equal(replay.status, 200);
  const replayBody = replay.body as { receiptId: number; replayed: boolean };
  assert.equal(replayBody.receiptId, firstBody.receiptId);
  assert.equal(replayBody.replayed, true);
  const replayTarget = makeStatusJsonTarget();
  sendNanopaySettlementJsonResponse(replayTarget, replay);
  assert.equal(replayTarget.statusCode, 200);
  assert.equal(replayTarget.body, replay.body);

  assert.ok(logger.errors.length >= 4);
  db.close();
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

process.stdout.write("nanopay settlement surface smoke ok\n");

function makeStatusJsonTarget() {
  return {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return {
        json: (body: unknown) => {
          this.body = body;
        },
      };
    },
  };
}
