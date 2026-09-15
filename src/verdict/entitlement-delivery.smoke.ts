import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { privateKeyToAccount } from "viem/accounts";

import { openDb } from "./db.js";
import {
  acceptDelivery,
  deliveryActionMessage,
  disputeDelivery,
  openDelivery,
  sweepDeliveryDeadlines,
  type RevealVerifier,
} from "./entitlement-delivery.js";
import { entitlementDeliveryRepo } from "./repos/entitlement-delivery-repo.js";
import { entitlementsRepo } from "./repos/entitlements-repo.js";

// ─── The gate between a sale and a payout ───────────────────────────────────
//
// What this suite exists to defend, in order of how much it would cost to get
// wrong:
//
//   1. A losing prediction is not a delivery defect and can never be disputed.
//   2. Only the buyer's own signature accepts their purchase.
//   3. Silence does not freeze the provider's money — but only a VERIFIED
//      valid public reveal releases it.
//   4. A call murmur cannot show was ever published is refunded, not paid out.
process.stdout.write("murmur entitlement delivery smoke\n");

const CHAIN_ID = 84532;
const CONTRACT = "0x1B74A4bAb1E06Ed107780a245c85337AB9dEcD1A";
const AUDIENCE = "murmur-test";
const HORIZON = "2026-09-13T12:00:00.000Z";
const buyer = privateKeyToAccount(
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
);
const stranger = privateKeyToAccount(
  "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
);

const tmp = mkdtempSync(join(tmpdir(), "delivery-"));
const db = openDb({ path: join(tmp, `${randomUUID()}.db`) });
const agentId = randomUUID();
db.prepare(
  `INSERT INTO agents (agent_id, display_slug, kind, display_name, bio, created_at)
   VALUES (?, ?, 'agent', 'Seller', NULL, ?)`,
).run(agentId, `seller-${agentId.slice(0, 8)}`, HORIZON);

let at = Date.parse("2026-09-13T00:00:00.000Z");
const deps = { db, now: () => new Date(at) };

let n = 0;
function sale(status: "granted" | "grant_queued" = "granted"): number {
  const id = ++n;
  db.prepare(
    `INSERT INTO entitlements
       (id, chain_id, contract_address, onchain_call_id, subscriber_address,
        producer_agent_id, amount, currency, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, '1000000', 'USDC', ?, ?, ?)`,
  ).run(id, CHAIN_ID, CONTRACT, `0xcall${id}`, buyer.address, agentId, status,
        new Date(at).toISOString(), new Date(at).toISOString());
  openDelivery(deps, id, HORIZON);
  return id;
}

const sign = (
  id: number,
  action: "accept_delivery" | "dispute_delivery",
  signer = buyer,
  ground?: "decrypt_unavailable",
) =>
  signer.signMessage({
    message: deliveryActionMessage({
      action,
      audience: AUDIENCE,
      entitlementId: id,
      chainId: CHAIN_ID,
      contractAddress: CONTRACT,
      onchainCallId: `0xcall${id}`,
      subscriberAddress: buyer.address,
      ground,
    }),
  });

// ─── 1. A losing call is not a delivery defect ─────────────────────────────

{
  const id = sale();
  const refused = await disputeDelivery(deps, {
    entitlementId: id,
    subscriberAddress: buyer.address,
    signature: await sign(id, "dispute_delivery"),
    audience: AUDIENCE,
    ground: "prediction_lost",
    evidence: "it did not happen",
  });
  assert.equal(refused.ok, false);
  assert.equal(refused.ok === false && refused.code, "unknown_ground");
  assert.ok(
    refused.ok === false && refused.message.includes("no bearing on payment"),
    "and the refusal says why, in the buyer's own error",
  );
  assert.equal(
    entitlementDeliveryRepo.byEntitlementId(db, id)?.state,
    "pending",
    "the sale is untouched",
  );
}

// ─── 2. Only the buyer's signature counts ──────────────────────────────────

{
  const id = sale();
  const forged = await acceptDelivery(deps, {
    entitlementId: id,
    subscriberAddress: buyer.address,
    signature: await sign(id, "accept_delivery", stranger),
    audience: AUDIENCE,
  });
  assert.equal(forged.ok === false && forged.code, "bad_signature");

  // A signature for a DIFFERENT action does not accept either: the message
  // binds the action, so a dispute signature cannot be replayed as consent.
  const crossed = await acceptDelivery(deps, {
    entitlementId: id,
    subscriberAddress: buyer.address,
    signature: await sign(id, "dispute_delivery"),
    audience: AUDIENCE,
  });
  assert.equal(crossed.ok === false && crossed.code, "bad_signature");

  const real = await acceptDelivery(deps, {
    entitlementId: id,
    subscriberAddress: buyer.address,
    signature: await sign(id, "accept_delivery"),
    audience: AUDIENCE,
  });
  assert.equal(real.ok, true);
  assert.equal(entitlementDeliveryRepo.byEntitlementId(db, id)?.state, "buyer_accepted");
}

// Nothing to accept before access exists.
{
  const id = sale("grant_queued");
  const early = await acceptDelivery(deps, {
    entitlementId: id,
    subscriberAddress: buyer.address,
    signature: await sign(id, "accept_delivery"),
    audience: AUDIENCE,
  });
  assert.equal(early.ok === false && early.code, "not_granted");
}

// ─── 3. Silence releases ONLY against a verified valid reveal ──────────────

const verifier = (answer: boolean | null): RevealVerifier => ({
  hasValidPublicReveal: async () => answer,
});

{
  const id = sale();
  at = Date.parse(HORIZON) + 60_000; // past the horizon

  // The deadline alone proves nothing: a reveal that never happened, or one
  // that landed Invalid, must not pay the provider.
  let swept = await sweepDeliveryDeadlines(deps, verifier(false));
  assert.equal(swept.autoAccepted, 0, "an unrevealed call is not accepted by the clock");
  assert.equal(swept.rejected, 0, "and not yet refused either — the longstop has not passed");
  assert.equal(entitlementDeliveryRepo.byEntitlementId(db, id)?.state, "pending");

  // An unreadable chain defers rather than guessing in either direction.
  swept = await sweepDeliveryDeadlines(deps, verifier(null));
  assert.ok(swept.deferred >= 1);
  assert.equal(entitlementDeliveryRepo.byEntitlementId(db, id)?.state, "pending");

  // A finalized valid reveal makes the call publicly checkable: accept.
  swept = await sweepDeliveryDeadlines(deps, verifier(true));
  assert.ok(swept.autoAccepted >= 1);
  assert.equal(entitlementDeliveryRepo.byEntitlementId(db, id)?.state, "auto_accepted");
  assert.equal(entitlementDeliveryRepo.byEntitlementId(db, id)?.decided_by, "auto");
}

// ─── 4. No reveal by the longstop → the BUYER is refunded ──────────────────

{
  at = Date.parse("2026-09-13T00:00:00.000Z");
  const id = sale();
  at = Date.parse(HORIZON) + 25 * 60 * 60 * 1000; // past the longstop
  const swept = await sweepDeliveryDeadlines(deps, verifier(false));
  assert.ok(swept.rejected >= 1);
  assert.equal(entitlementDeliveryRepo.byEntitlementId(db, id)?.state, "rejected");
  assert.equal(
    entitlementsRepo.byId(db, id)?.refund_status,
    "refund_due",
    "murmur owes the buyer back what it could not show it delivered",
  );
}

// ─── A live dispute is never swept away by a reveal ────────────────────────

{
  at = Date.parse("2026-09-13T00:00:00.000Z");
  const id = sale();
  const raised = await disputeDelivery(deps, {
    entitlementId: id,
    subscriberAddress: buyer.address,
    signature: await sign(id, "dispute_delivery", buyer, "decrypt_unavailable"),
    audience: AUDIENCE,
    ground: "decrypt_unavailable",
    evidence: "gateway 500s for an hour",
  });
  assert.equal(raised.ok, true);

  at = Date.parse(HORIZON) + 60_000;
  await sweepDeliveryDeadlines(deps, verifier(true));
  assert.equal(
    entitlementDeliveryRepo.byEntitlementId(db, id)?.state,
    "disputed",
    "a published call does not disprove an earlier outage",
  );

  // The buyer can still end their own dispute by accepting.
  const settled = await acceptDelivery(deps, {
    entitlementId: id,
    subscriberAddress: buyer.address,
    signature: await sign(id, "accept_delivery"),
    audience: AUDIENCE,
  });
  assert.equal(settled.ok, true);
  assert.equal(entitlementDeliveryRepo.byEntitlementId(db, id)?.state, "buyer_accepted");
}

// A complaint raised after the call is public is too late.
{
  at = Date.parse("2026-09-13T00:00:00.000Z");
  const id = sale();
  at = Date.parse(HORIZON) + 60_000;
  const late = await disputeDelivery(deps, {
    entitlementId: id,
    subscriberAddress: buyer.address,
    signature: await sign(id, "dispute_delivery", buyer, "decrypt_unavailable"),
    audience: AUDIENCE,
    ground: "decrypt_unavailable",
    evidence: null,
  });
  assert.equal(late.ok === false && late.code, "window_closed");
}

db.close();
rmSync(tmp, { recursive: true, force: true });
process.stdout.write("OK entitlement delivery smoke\n");
