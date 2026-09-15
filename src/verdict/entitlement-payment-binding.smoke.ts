import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { GatewayMiddleware, GatewayPaymentRequirements } from "../integrations/circle-gateway.js";
import { openDb } from "./db.js";
import { createGatewayEntitlementBroker } from "./entitlement-access-surface.js";

// A signed x402 payment buys ONE resource; replaying it against a different call is refused.
process.stdout.write("murmur entitlement payment binding smoke\n");

const SELLER = `0x${"11".repeat(20)}`;
const PAYER = `0x${"22".repeat(20)}`;
const CONTRACT = `0x${"33".repeat(20)}`;
const PRICE = "10000";
const NETWORK = "eip155:84532";

function requirements(): GatewayPaymentRequirements {
  return {
    scheme: "exact",
    network: NETWORK,
    amount: PRICE,
    payTo: SELLER,
  } as GatewayPaymentRequirements;
}

/** One signed payment. Replaying it means presenting these exact bytes again. */
function header(nonce: string): string {
  return Buffer.from(
    JSON.stringify({
      accepted: requirements(),
      payload: { authorization: { from: PAYER, nonce } },
    }),
    "utf8",
  ).toString("base64");
}

function binding(onchainCallId: string) {
  return {
    chainId: 84532,
    contractAddress: CONTRACT,
    onchainCallId,
    priceAtoms: PRICE,
    currency: "USDC",
    pricingVersion: "v1",
  };
}

let verifyValid = true;
const gateway: GatewayMiddleware = {
  require: () => {
    throw new Error("unused");
  },
  paymentRequirements: async () => requirements(),
  verify: async () =>
    verifyValid
      ? { valid: true, payer: PAYER }
      : { valid: false, error: "invalid signature" },
  settle: async () => ({ success: true, transaction: "0xSETTLED" }),
} as unknown as GatewayMiddleware;

const tmp = mkdtempSync(join(tmpdir(), "entitlement-binding-"));
try {
  const db = openDb({ path: join(tmp, `${randomUUID()}.db`) });
  const broker = createGatewayEntitlementBroker({
    db,
    now: () => new Date("2026-07-26T02:00:00.000Z"),
    gateway,
    network: NETWORK,
    sellerAddress: SELLER,
    currency: "USDC",
  });

  const paid = header("nonce-a");

  const first = await broker.authorize(paid, binding("0xCALL_A"));
  assert.equal(first.ok, true, "the first presentation authorizes");

  // Same header, same resource: a client retry, which must still work.
  const retry = await broker.authorize(paid, binding("0xCALL_A"));
  assert.equal(retry.ok, true, "re-presenting for the SAME call is a retry, not a replay");

  // Same header, DIFFERENT call at the same price. This is the replay.
  const replay = await broker.authorize(paid, binding("0xCALL_B"));
  assert.equal(replay.ok, false, "one payment cannot buy a second call");
  if (!replay.ok) {
    assert.equal(replay.status, 402);
    assert.match(
      JSON.stringify(replay.body),
      /already presented for a different resource/,
      "the refusal names the actual problem",
    );
  }

  // Same signed authorization, re-encoded with different unsigned envelope fields (`accepted`, `resource`).
  const reEncoded = Buffer.from(
    JSON.stringify({
      resource: "https://example.invalid/some/other/resource",
      accepted: requirements(),
      payload: { authorization: { from: PAYER, nonce: "nonce-a" } },
      // A field the parser ignores entirely — enough to change an envelope hash.
      extra: "padding",
    }),
    "utf8",
  ).toString("base64");
  const malleated = await broker.authorize(reEncoded, binding("0xCALL_C"));
  assert.equal(
    malleated.ok,
    false,
    "re-encoding the same signed authorization must not buy another call",
  );

  // A genuinely different payment for the second call is fine.
  const second = await broker.authorize(header("nonce-b"), binding("0xCALL_B"));
  assert.equal(second.ok, true, "a distinct payment buys a distinct call");

  // A nonceless authorization is refused: nothing stable to key the binding on.
  const noNonce = Buffer.from(
    JSON.stringify({
      accepted: requirements(),
      payload: { authorization: { from: PAYER } },
    }),
    "utf8",
  ).toString("base64");
  const rejected = await broker.authorize(noNonce, binding("0xCALL_D"));
  assert.equal(rejected.ok, false, "a nonceless authorization is refused");

  // An unverified payment writes no binding row; the 402 challenge is public and nothing cleans this table.
  const before = (
    db
      .prepare("SELECT count(*) c FROM entitlement_payment_bindings")
      .get() as { c: number }
  ).c;
  verifyValid = false;
  const unverified = await broker.authorize(header("nonce-junk"), binding("0xCALL_E"));
  assert.equal(unverified.ok, false, "an unverified payment is refused");
  const after = (
    db
      .prepare("SELECT count(*) c FROM entitlement_payment_bindings")
      .get() as { c: number }
  ).c;
  assert.equal(after, before, "an unverified payment writes no binding row");
  verifyValid = true;

  db.close();
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

process.stdout.write("OK entitlement payment binding smoke\n");
