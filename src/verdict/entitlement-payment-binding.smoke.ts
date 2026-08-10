import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { GatewayMiddleware, GatewayPaymentRequirements } from "../integrations/circle-gateway.js";
import { openDb } from "./db.js";
import { createGatewayEntitlementBroker } from "./entitlement-access-surface.js";

// A signed x402 payment buys ONE resource.
//
// The broker used to compute a payload hash and a requirements hash and throw
// both away, under a comment claiming the entitlement reservation was the real
// guard. It is not: the reservation is unique per (call, subscriber), so the
// same header replayed against a DIFFERENT call at the same price satisfied
// every local check, and whether it settled twice came down to the
// facilitator's nonce handling — someone else's guarantee.
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

  // THE REAL ATTACK: re-encode the SAME signed authorization with different
  // envelope fields. `accepted` and `resource` sit outside the EIP-712
  // signature, so an attacker can change them freely; only from/to/value/
  // validity/nonce are signed. Hashing the decoded envelope made this a
  // different key, which let one signature buy a second call.
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

  // An authorization with no nonce is refused: without one there is nothing
  // stable to key the binding on.
  const noNonce = Buffer.from(
    JSON.stringify({
      accepted: requirements(),
      payload: { authorization: { from: PAYER } },
    }),
    "utf8",
  ).toString("base64");
  const rejected = await broker.authorize(noNonce, binding("0xCALL_D"));
  assert.equal(rejected.ok, false, "a nonceless authorization is refused");

  // An UNVERIFIED payment must leave no trace. The bind used to run before
  // verification, so anyone holding the public 402 challenge could write a
  // permanent row per request with an invalid signature — the local parser
  // accepts any address-shaped `from` and any nonempty nonce, and nothing
  // cleans this table up.
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
