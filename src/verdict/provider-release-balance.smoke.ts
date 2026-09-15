import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDb } from "./db.js";
import { readProviderReleaseBalance } from "./provider-release-balance.js";
import { entitlementDeliveryRepo } from "./repos/entitlement-delivery-repo.js";
import { providerPayoutsRepo } from "./repos/provider-payouts-repo.js";
import { providerWithdrawalsRepo } from "./repos/provider-withdrawals-repo.js";

// ─── What a provider may withdraw ───────────────────────────────────────────
//
// The predicate this whole rail exists to defend:
//
//     available = max(0, accepted − paid − reserved)
//
// and, underneath it, the rule that makes murmur a prediction marketplace
// rather than a bookmaker: a sale becomes releasable when the buyer got what
// they paid for, and NOTHING about whether the prediction was right can move
// that number.
process.stdout.write("murmur provider release balance smoke\n");

const NOW = "2026-09-13T00:00:00.000Z";
const DEADLINE = "2026-09-13T01:00:00.000Z";
const LONGSTOP = "2026-09-14T01:00:00.000Z";

const tmp = mkdtempSync(join(tmpdir(), "release-balance-"));
const db = openDb({ path: join(tmp, `${randomUUID()}.db`) });
const agentId = randomUUID();

db.prepare(
  `INSERT INTO agents (agent_id, display_slug, kind, display_name, bio, created_at)
   VALUES (?, ?, 'agent', 'Seller', NULL, ?)`,
).run(agentId, `seller-${agentId.slice(0, 8)}`, NOW);

let nextEntitlement = 0;
/** One accrued sale, with the delivery state under test. `null` = never enrolled. */
function sale(netAtoms: string, delivery: "accepted" | "pending" | "disputed" | "rejected" | null): number {
  const id = ++nextEntitlement;
  db.prepare(
    `INSERT INTO entitlements
       (id, chain_id, contract_address, onchain_call_id, subscriber_address,
        producer_agent_id, amount, currency, status, created_at, updated_at)
     VALUES (?, 84532, '0xc0', ?, '0xbuyer', ?, ?, 'USDC', 'granted', ?, ?)`,
  ).run(id, `0xcall${id}`, agentId, netAtoms, NOW, NOW);
  db.prepare(
    `INSERT INTO provider_earnings
       (entitlement_id, producer_agent_id, chain_id, contract_address, onchain_call_id,
        gross_atoms, fee_bps, fee_atoms, net_atoms, currency, accrual_source, accrued_at)
     VALUES (?, ?, 84532, '0xc0', ?, ?, 1000, '0', ?, 'USDC', 'sale_snapshot', ?)`,
  ).run(id, agentId, `0xcall${id}`, netAtoms, netAtoms, NOW);
  if (delivery === null) return id;
  entitlementDeliveryRepo.open(db, {
    entitlement_id: id,
    accept_deadline_at: DEADLINE,
    dispute_longstop_at: LONGSTOP,
    created_at: NOW,
  });
  if (delivery === "accepted") {
    entitlementDeliveryRepo.transition(db, id, ["pending"], {
      state: "buyer_accepted",
      accepted_at: NOW,
      decided_by: "buyer",
      decided_at: NOW,
      updated_at: NOW,
    });
  } else if (delivery === "disputed") {
    entitlementDeliveryRepo.transition(db, id, ["pending"], {
      state: "disputed",
      dispute_ground: "decrypt_unavailable",
      disputed_at: NOW,
      updated_at: NOW,
    });
  } else if (delivery === "rejected") {
    entitlementDeliveryRepo.transition(db, id, ["pending"], {
      state: "rejected",
      decided_by: "operator",
      decided_at: NOW,
      updated_at: NOW,
    });
  }
  return id;
}

const read = () => {
  const b = readProviderReleaseBalance(db, agentId, "USDC");
  assert.ok(b, "the agent has USDC history");
  return b;
};

// ─── Only accepted delivery is releasable ───────────────────────────────────

sale("1000000", "accepted"); // 1.0
sale("2000000", "pending"); // earned, not yet releasable
sale("4000000", "disputed"); // likewise: a live complaint holds the money
sale("8000000", "rejected"); // adjudicated against; a refund is owed instead

{
  const b = read();
  assert.equal(b.accrued_net_atoms, "15000000", "every sale still shows as accrued");
  assert.equal(b.accepted_net_atoms, "1000000");
  assert.equal(b.held_net_atoms, "6000000", "pending and disputed are held together");
  assert.equal(b.cancelled_net_atoms, "8000000");
  assert.equal(b.available_atoms, "1000000", "only the accepted sale can be taken");
}

// ─── A sale predating the policy is NOT consent ─────────────────────────────
//
// The one thing that must never happen quietly: reading a historical `granted`
// row as though its buyer had accepted delivery.

sale("500000", null);
{
  const b = read();
  assert.equal(b.unenrolled_net_atoms, "500000", "it gets its own bucket");
  assert.equal(b.unenrolled_sales, 1);
  assert.equal(b.accrued_net_atoms, "15500000", "and still counts as accrued");
  assert.equal(b.available_atoms, "1000000", "but adds nothing withdrawable");
}

// ─── Paid and reserved both subtract ────────────────────────────────────────

sale("3000000", "accepted"); // accepted is now 4.0
assert.equal(read().available_atoms, "4000000");

providerPayoutsRepo.insert(db, {
  producer_agent_id: agentId,
  entry_type: "payout",
  currency: "USDC",
  amount_atoms: "1500000",
  tx_ref: "0xsent",
  payout_method: "manual",
  destination_ref: "0xdest",
  note: null,
  earnings_cutoff_at: NOW,
  created_at: NOW,
});
assert.equal(read().net_paid_atoms, "1500000");
assert.equal(read().available_atoms, "2500000", "what murmur already sent is gone");

const held = providerWithdrawalsRepo.reserve(db, {
  producer_agent_id: agentId,
  client_request_id: "req-1",
  chain_id: 84532,
  token_address: "0xusdc",
  currency: "USDC",
  amount_atoms: "2000000",
  destination_address: "0xdest",
  sender_address: "0xseller",
  created_at: NOW,
});
assert.equal(read().reserved_atoms, "2000000");
assert.equal(read().available_atoms, "500000", "an in-flight withdrawal is spoken for");

// A failed transfer releases its hold; an unreadable one never does.
providerWithdrawalsRepo.transition(db, held.id, ["reserved"], {
  state: "failed",
  updated_at: NOW,
});
assert.equal(read().available_atoms, "2500000", "a finalized revert frees the funds");

const unknown = providerWithdrawalsRepo.reserve(db, {
  producer_agent_id: agentId,
  client_request_id: "req-2",
  chain_id: 84532,
  token_address: "0xusdc",
  currency: "USDC",
  amount_atoms: "2500000",
  destination_address: "0xdest",
  sender_address: "0xseller",
  created_at: NOW,
});
providerWithdrawalsRepo.transition(db, unknown.id, ["reserved"], {
  state: "needs_review",
  nonce: 7,
  signed_raw_tx: "0xraw",
  updated_at: NOW,
});
assert.equal(
  read().available_atoms,
  "0",
  "a transfer that MAY have landed keeps holding its funds — this is the double-send guard",
);

// ─── Overpayment can never read as money to take ────────────────────────────

providerPayoutsRepo.insert(db, {
  producer_agent_id: agentId,
  entry_type: "payout",
  currency: "USDC",
  amount_atoms: "9000000",
  tx_ref: "0xoops",
  payout_method: "manual",
  destination_ref: "0xdest",
  note: "operator error",
  earnings_cutoff_at: NOW,
  created_at: NOW,
});
assert.equal(read().available_atoms, "0", "clamped at zero, never negative");

db.close();
rmSync(tmp, { recursive: true, force: true });
process.stdout.write("OK provider release balance smoke\n");
