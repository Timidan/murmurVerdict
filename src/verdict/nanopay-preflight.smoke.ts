import { strict as assert } from "node:assert";

import type Database from "better-sqlite3";
import type { NextFunction, Request, Response } from "express";

import {
  nanopayPreflightResponse,
  preflightServable,
  sendNanopayPreflightJsonResponse,
} from "./nanopay-preflight.js";
import type { NanopayRouterDeps } from "./nanopay-types.js";

process.stdout.write("murmur nanopay preflight smoke\n");

const pipelineId = `0x${"1".repeat(64)}`;

class FakeResponse {
  statusCode = 200;
  body: unknown = null;

  status(code: number): this {
    this.statusCode = code;
    return this;
  }

  json(body: unknown): this {
    this.body = body;
    return this;
  }
}

assert.deepEqual(
  nanopayPreflightResponse({
    deps: fakeDeps({ hasPipeline: true, hasSealedCall: true }),
    pipelineId: null,
  }),
  {
    ok: false,
    status: 400,
    body: {
      error: "BadPipelineId",
      message: "pipelineId must be 32-byte hex",
    },
  },
);

assert.deepEqual(
  nanopayPreflightResponse({
    deps: fakeDeps({ hasPipeline: false, hasSealedCall: true }),
    pipelineId,
  }),
  {
    ok: false,
    status: 404,
    body: { error: "PipelineNotFound", pipelineId },
  },
);

assert.deepEqual(
  nanopayPreflightResponse({
    deps: fakeDeps({ hasPipeline: true, hasSealedCall: false }),
    pipelineId,
  }),
  {
    ok: false,
    status: 503,
    body: {
      error: "NoSignalAvailable",
      message:
        "Pipeline has no anchored sealed-Fhenix call yet; retry once the agent has submitted.",
    },
  },
);

assert.deepEqual(
  nanopayPreflightResponse({
    deps: fakeDeps({ hasPipeline: true, hasSealedCall: true }),
    pipelineId,
  }),
  { ok: true },
);

const response = new FakeResponse();
sendNanopayPreflightJsonResponse(response, {
  ok: false,
  status: 404,
  body: { error: "PipelineNotFound", pipelineId },
});
assert.equal(response.statusCode, 404);
assert.deepEqual(response.body, { error: "PipelineNotFound", pipelineId });

let nextCalled = false;
preflightServable(fakeDeps({ hasPipeline: true, hasSealedCall: true }))(
  { params: { pipelineId } } as unknown as Request,
  new FakeResponse() as unknown as Response,
  (() => {
    nextCalled = true;
  }) as NextFunction,
);
assert.equal(nextCalled, true);

const missing = new FakeResponse();
preflightServable(fakeDeps({ hasPipeline: false, hasSealedCall: true }))(
  { params: { pipelineId } } as unknown as Request,
  missing as unknown as Response,
  (() => {
    throw new Error("next should not run on failed preflight");
  }) as NextFunction,
);
assert.equal(missing.statusCode, 404);
assert.deepEqual(missing.body, { error: "PipelineNotFound", pipelineId });

let signedNextCalled = false;
preflightServable(fakeDeps({ hasPipeline: false, hasSealedCall: false }))(
  {
    params: { pipelineId },
    headers: { "payment-signature": "signed-replay" },
  } as unknown as Request,
  new FakeResponse() as unknown as Response,
  (() => {
    signedNextCalled = true;
  }) as NextFunction,
);
assert.equal(
  signedNextCalled,
  true,
  "signed requests must reach the durable gate so settled replays survive catalog removal",
);

process.stdout.write("nanopay preflight smoke ok\n");

function fakeDeps(input: {
  hasPipeline: boolean;
  hasSealedCall: boolean;
}): NanopayRouterDeps {
  return {
    db: {} as Database.Database,
    bindingDomain: {
      chainId: 84532,
      verifyingContract: `0x${"2".repeat(40)}`,
    },
    sellerAddress: `0x${"3".repeat(40)}`,
    now: () => new Date("2026-06-12T10:05:00Z"),
    resolvePipeline: () =>
      input.hasPipeline
        ? {
            priceAtoms: "1000",
            recipient: `0x${"4".repeat(40)}`,
            chainId: 84532,
          }
        : null,
    resolveLatestSealedCall: () =>
      input.hasSealedCall
        ? {
            anchor: {
              bindingVersion: 1,
              chainId: 84532,
              sealedVerdictsContractAddress: `0x${"5".repeat(40)}`,
              onchainCallId: `0x${"6".repeat(64)}`,
              marketId: "eth.1h",
              agent: `0x${"7".repeat(40)}`,
              submitTxHash: `0x${"7".repeat(64)}`,
              submitLogIndex: 0,
              binaryIndexCiphertextHash: `0x${"8".repeat(64)}`,
              confidenceCiphertextHash: `0x${"9".repeat(64)}`,
              revealOpenAt: "2026-05-14T13:00:00Z",
              commitScheme: "fhenix-sealed-v1",
              commitHash: "a".repeat(64),
            },
            revealArtifact: null,
          }
        : null,
  };
}
