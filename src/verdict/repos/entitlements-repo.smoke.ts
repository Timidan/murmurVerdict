import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDb } from "../db.js";
import { entitlementsRepo } from "./entitlements-repo.js";

process.stdout.write("murmur entitlements repo smoke\n");

const CHAIN_ID = 84532;
const CONTRACT = "0xDEADBEEFdeadbeefDEADBEEFdeadbeefDEADBEEF";
const ONCHAIN_CALL = "0xAA" + "11".repeat(31);
const SUBSCRIBER = "0xCAFEbabeCAFEbabeCAFEbabeCAFEbabeCAFEbabe";

const tmp = mkdtempSync(join(tmpdir(), "entitlements-"));
const db = openDb({ path: join(tmp, `${randomUUID()}.db`) });

const key = {
  chainId: CHAIN_ID,
  contractAddress: CONTRACT,
  onchainCallId: ONCHAIN_CALL,
  subscriberAddress: SUBSCRIBER,
};

// reserve inserts a payment_settling row.
const id = entitlementsRepo.reserve(db, {
  ...key,
  callId: null,
  producerAgentId: "agent-1",
  amount: "1000",
  currency: "USDC",
  now: "2026-07-20T00:00:00.000Z",
});
assert.ok(id > 0, "reserve returns row id");

const reserved = entitlementsRepo.byId(db, id);
assert.equal(reserved?.status, "payment_settling");
assert.equal(reserved?.grant_attempts, 0);
// Contract + subscriber + onchain call id are normalized to lowercase.
assert.equal(reserved?.contract_address, CONTRACT.toLowerCase());
assert.equal(reserved?.subscriber_address, SUBSCRIBER.toLowerCase());
assert.equal(reserved?.onchain_call_id, ONCHAIN_CALL.toLowerCase());

// A concurrent double-buy of the same (chain, contract, call, subscriber) hits
// the UNIQUE reservation index — case variants must not bypass it.
let duped = false;
try {
  entitlementsRepo.reserve(db, {
    ...key,
    contractAddress: CONTRACT.toUpperCase(),
    callId: null,
    producerAgentId: null,
    amount: null,
    currency: null,
    now: "2026-07-20T00:00:01.000Z",
  });
} catch (err) {
  duped = (err as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE";
}
assert.ok(duped, "duplicate reservation rejected by UNIQUE index");

// byReservation resolves case-insensitively.
const found = entitlementsRepo.byReservation(db, {
  ...key,
  subscriberAddress: SUBSCRIBER.toUpperCase(),
});
assert.equal(found?.id, id, "byReservation is case-insensitive");

// Ordered path: payment_settling → grant_queued → grant_broadcast → granted.
assert.ok(
  entitlementsRepo.transition(db, id, ["payment_settling"], {
    status: "grant_queued",
    nanopayReceiptId: "receipt-9",
    callId: "internal-call-1",
    now: "2026-07-20T00:01:00.000Z",
  }),
  "settle → grant_queued",
);
assert.equal(entitlementsRepo.byId(db, id)?.nanopay_receipt_id, "receipt-9");
assert.equal(entitlementsRepo.byId(db, id)?.call_id, "internal-call-1");

assert.ok(
  entitlementsRepo.transition(db, id, ["grant_queued", "grant_broadcast"], {
    status: "grant_broadcast",
    grantTxHash: "0xabc",
    incrementAttempts: true,
    nextAttemptAt: "2026-07-20T00:02:00.000Z",
    now: "2026-07-20T00:01:30.000Z",
  }),
  "grant_queued → grant_broadcast",
);
assert.equal(entitlementsRepo.byId(db, id)?.grant_attempts, 1);
assert.equal(entitlementsRepo.byId(db, id)?.grant_tx_hash, "0xabc");

assert.ok(
  entitlementsRepo.transition(db, id, ["grant_broadcast"], {
    status: "granted",
    grantBlockNumber: 123,
    grantedAt: "2026-07-20T00:03:00.000Z",
    nextAttemptAt: null,
    now: "2026-07-20T00:03:00.000Z",
  }),
  "grant_broadcast → granted",
);
const granted = entitlementsRepo.byId(db, id);
assert.equal(granted?.status, "granted");
assert.equal(granted?.grant_block_number, 123);
assert.equal(granted?.granted_at, "2026-07-20T00:03:00.000Z");

// A conditional transition from the wrong state is a no-op (no regression).
assert.equal(
  entitlementsRepo.transition(db, id, ["payment_settling"], {
    status: "grant_queued",
    now: "2026-07-20T00:04:00.000Z",
  }),
  false,
  "wrong-from transition does not regress a granted row",
);
assert.equal(entitlementsRepo.byId(db, id)?.status, "granted");

// A settled-but-ungrantable entitlement moves to refund_due, NEVER to a plain
// failure that would strand the payer's money.
const id2 = entitlementsRepo.reserve(db, {
  chainId: CHAIN_ID,
  contractAddress: CONTRACT,
  onchainCallId: "0xBB" + "22".repeat(31),
  subscriberAddress: SUBSCRIBER,
  callId: null,
  producerAgentId: null,
  amount: "1000",
  currency: "USDC",
  now: "2026-07-20T00:00:00.000Z",
});
entitlementsRepo.transition(db, id2, ["payment_settling"], {
  status: "grant_queued",
  now: "2026-07-20T00:01:00.000Z",
});
assert.ok(
  entitlementsRepo.transition(
    db,
    id2,
    ["grant_queued", "grant_broadcast", "settlement_unknown"],
    {
      status: "grant_failed_refund_due",
      refundStatus: "refund_due",
      lastError: "grant tx reverted: DecryptGrantWindowClosed",
      now: "2026-07-20T00:05:00.000Z",
    },
  ),
  "grant failure → refund_due",
);
assert.equal(entitlementsRepo.byId(db, id2)?.refund_status, "refund_due");

// listDue returns the still-owed refund row but not the terminal granted one.
const due = entitlementsRepo.listDue(db, {
  now: "2026-07-20T01:00:00.000Z",
  limit: 10,
});
const dueIds = due.map((r) => r.id);
assert.ok(dueIds.includes(id2), "refund_due row is still due");
assert.ok(!dueIds.includes(id), "granted row is terminal, not due");

// Refund settles the owed row.
assert.ok(
  entitlementsRepo.transition(db, id2, ["grant_failed_refund_due"], {
    status: "refunded",
    refundStatus: "refunded",
    now: "2026-07-20T02:00:00.000Z",
  }),
  "refund_due → refunded",
);
assert.equal(entitlementsRepo.byId(db, id2)?.status, "refunded");

const counts = entitlementsRepo.counts(db);
assert.equal(counts.granted, 1);
assert.equal(counts.refunded, 1);

db.close();
rmSync(tmp, { recursive: true, force: true });
process.stdout.write("OK entitlements repo smoke\n");
