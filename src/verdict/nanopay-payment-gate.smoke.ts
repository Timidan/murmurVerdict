import { strict as assert } from "node:assert";

import type Database from "better-sqlite3";
import type { NextFunction, Request, Response } from "express";

import {
  DEFAULT_MAINNET_FACILITATOR_URL,
  DEFAULT_TESTNET_FACILITATOR_URL,
} from "../integrations/circle-gateway.js";
import {
  createNanopayPaymentGate,
  nanopayFacilitatorUrl,
  type NanopayGatewayFactory,
} from "./nanopay-payment-gate.js";
import type { NanopayRouterDeps } from "./nanopay-types.js";

process.stdout.write("murmur nanopay payment gate smoke\n");

const capturedConfigs: Array<Parameters<NanopayGatewayFactory>[0]> = [];
const requiredPrices: string[] = [];
const fakeGatewayFactory: NanopayGatewayFactory = (config) => {
  capturedConfigs.push(config);
  return {
    require(price: string) {
      requiredPrices.push(price);
      return ((_req: unknown, _res: unknown, next: (err?: unknown) => void) => {
        next();
      }) as ReturnType<ReturnType<NanopayGatewayFactory>["require"]>;
    },
  };
};

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

assert.equal(nanopayFacilitatorUrl("testnet"), DEFAULT_TESTNET_FACILITATOR_URL);
assert.equal(nanopayFacilitatorUrl("mainnet"), DEFAULT_MAINNET_FACILITATOR_URL);

const mainnetDeps = fakeDeps({
  acceptNetworks: ["eip155:8453"],
  defaultPrice: "$0.01",
  network: "mainnet",
});
const mainnetGate = createNanopayPaymentGate(mainnetDeps, fakeGatewayFactory);

assert.equal(mainnetGate.facilitatorUrl, DEFAULT_MAINNET_FACILITATOR_URL);
assert.equal(mainnetGate.price, "$0.01");
assert.equal(requiredPrices[0], "$0.01");
assert.equal(capturedConfigs[0]?.sellerAddress, mainnetDeps.sellerAddress);
assert.deepEqual(capturedConfigs[0]?.networks, ["eip155:8453"]);
assert.equal(capturedConfigs[0]?.facilitatorUrl, DEFAULT_MAINNET_FACILITATOR_URL);
assert.equal(capturedConfigs[0]?.description, "Murmur per-call paid inference");

let nextCalled = false;
mainnetGate.requirePayment(
  {} as Request,
  {} as Response,
  () => {
    nextCalled = true;
  },
);
assert.equal(nextCalled, true);

const missingPaymentResponse = new FakeResponse();
await mainnetGate.afterPayment(
  { params: { pipelineId: `0x${"1".repeat(64)}` } } as unknown as Request,
  missingPaymentResponse as unknown as Response,
  (() => undefined) as NextFunction,
);
assert.equal(missingPaymentResponse.statusCode, 500);
assert.deepEqual(missingPaymentResponse.body, {
  error: "PaymentMissing",
  message: "middleware did not populate payment",
});

const defaultGate = createNanopayPaymentGate(fakeDeps({}), fakeGatewayFactory);
assert.equal(defaultGate.facilitatorUrl, DEFAULT_TESTNET_FACILITATOR_URL);
assert.equal(defaultGate.price, "$0.001");
assert.equal(requiredPrices[1], "$0.001");

process.stdout.write("nanopay payment gate smoke ok\n");

function fakeDeps(
  overrides: Partial<Pick<
    NanopayRouterDeps,
    "acceptNetworks" | "defaultPrice" | "network"
  >>,
): NanopayRouterDeps {
  return {
    db: {} as Database.Database,
    bindingDomain: {
      chainId: 84532,
      verifyingContract: `0x${"2".repeat(40)}`,
    },
    sellerAddress: `0x${"3".repeat(40)}`,
    now: () => new Date("2026-06-12T10:05:00Z"),
    resolvePipeline: () => null,
    resolveLatestSealedCall: () => null,
    ...overrides,
  };
}
