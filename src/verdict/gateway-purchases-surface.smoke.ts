// ─── Subscriber purchases surface smoke ─────────────────────────────────────
//
// `granted` rows are public; everything else needs the wallet's signature.
// nanopay_receipt_id must never appear; checked on the serialized body to catch a stray column.

import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { privateKeyToAccount } from "viem/accounts";

import { openDb } from "./db.js";
import {
  listSubscriberPurchasesResponse,
  subscriberAuthMessage,
  type PurchaseRow,
} from "./gateway-purchases-surface.js";

process.stdout.write("murmur gateway purchases surface smoke\n");

const CHAIN_ID = 84532;
const CONTRACT = "0x1B74A4bAb1E06Ed107780a245c85337AB9dEcD1A";
const OTHER_CONTRACT = "0x00000000000000000000000000000000000000ff";
const NOW = new Date("2026-08-10T12:00:00.000Z");
const NOW_SEC = Math.floor(NOW.getTime() / 1000);
/** Fixed test key; the address below is its EIP-191 signer. */
const SUBSCRIBER_KEY = `0x${"11".repeat(32)}` as const;
const IMPOSTOR_KEY = `0x${"22".repeat(32)}` as const;
const subscriberAccount = privateKeyToAccount(SUBSCRIBER_KEY);
const impostorAccount = privateKeyToAccount(IMPOSTOR_KEY);
const SUBSCRIBER = subscriberAccount.address;
const OTHER_SUBSCRIBER = "0x00000000000000000000000000000000000000aa";
/** Distinctive on purpose: any leak of it into a body is unmistakable. */
const RECEIPT_ID = "receipt-must-never-be-served-42";

interface SeedRow {
  callSuffix: string;
  status: string;
  subscriber?: string;
  contract?: string;
  amount?: string | null;
  currency?: string | null;
  receipt?: string | null;
  refundStatus?: string | null;
  grantTxHash?: string | null;
  grantedAt?: string | null;
  createdAt: string;
}

function onchainCallId(suffix: string): string {
  return `0x${suffix.padStart(64, "0")}`;
}

const SEEDS: SeedRow[] = [
  {
    // Paid + granted, with settlement evidence.
    callSuffix: "a1",
    status: "granted",
    amount: "2500",
    currency: "USDC",
    receipt: RECEIPT_ID,
    grantTxHash: `0x${"cd".repeat(32)}`,
    grantedAt: "2026-08-09T10:00:00.000Z",
    createdAt: "2026-08-09T09:00:00.000Z",
  },
  {
    // Adopted on-chain grant: no payment, so amount/currency/receipt are NULL.
    callSuffix: "a2",
    status: "granted",
    amount: null,
    currency: null,
    receipt: null,
    grantedAt: "2026-08-09T11:00:00.000Z",
    createdAt: "2026-08-09T10:00:00.000Z",
  },
  {
    callSuffix: "a3",
    status: "granted",
    amount: "2500",
    currency: "USDC",
    receipt: RECEIPT_ID,
    grantedAt: "2026-08-09T12:00:00.000Z",
    createdAt: "2026-08-09T11:00:00.000Z",
  },
  {
    // In flight — private.
    callSuffix: "b1",
    status: "payment_settling",
    createdAt: "2026-08-09T12:30:00.000Z",
  },
  {
    // Refund owed with NO receipt: nobody ever established that money moved.
    callSuffix: "b2",
    status: "grant_failed_refund_due",
    refundStatus: "refund_due",
    receipt: null,
    createdAt: "2026-08-09T13:00:00.000Z",
  },
  {
    // Another wallet entirely.
    callSuffix: "c1",
    status: "granted",
    subscriber: OTHER_SUBSCRIBER,
    receipt: RECEIPT_ID,
    createdAt: "2026-08-09T14:00:00.000Z",
  },
  {
    // This wallet, but a different deployment.
    callSuffix: "c2",
    status: "granted",
    contract: OTHER_CONTRACT,
    receipt: RECEIPT_ID,
    createdAt: "2026-08-09T15:00:00.000Z",
  },
];

function seed(db: ReturnType<typeof openDb>): void {
  db.pragma("foreign_keys = OFF");
  const iso = NOW.toISOString();
  db.prepare(
    `INSERT INTO agents (agent_id, display_slug, kind, display_name, created_at)
     VALUES ('agent-1', 'oracle-one', 'agent', 'Oracle One', @now)`,
  ).run({ now: iso });
  SEEDS.forEach((row, index) => {
    const callId = `call-${row.callSuffix}`;
    const onchain = onchainCallId(row.callSuffix);
    db.prepare(
      `INSERT INTO submissions (call_id, agent_id, client_order_id, horizon_seconds,
         submitted_at, accepted_at, status, schema_version, scoring_version, dedup_key)
       VALUES (@call_id, 'agent-1', @call_id, 300, @now, @now, 'accepted', 1, 1, @call_id)`,
    ).run({ call_id: callId, now: iso });
    db.prepare(
      `INSERT INTO fhenix_sealed_calls (call_id, chain_id, contract_address,
         onchain_call_id, submit_tx_hash, submit_log_index, binary_index_ct_hash,
         confidence_ct_hash, reveal_open_at, created_at, submission_class)
       VALUES (@call_id, @chain_id, @contract, @onchain, @tx, 0, '0x01', '0x02',
         @reveal, @now, 1)`,
    ).run({
      call_id: callId,
      chain_id: CHAIN_ID,
      contract: (row.contract ?? CONTRACT).toLowerCase(),
      onchain,
      tx: `0x${index.toString(16).padStart(64, "e")}`,
      reveal: "2026-08-11T00:00:00.000Z",
      now: iso,
    });
    db.prepare(
      `INSERT INTO entitlements (chain_id, contract_address, call_id, onchain_call_id,
         subscriber_address, producer_agent_id, nanopay_receipt_id, amount, currency,
         status, grant_tx_hash, refund_status, granted_at, created_at, updated_at)
       VALUES (@chain_id, @contract, @call_id, @onchain, @subscriber, 'agent-1',
         @receipt, @amount, @currency, @status, @grant_tx, @refund_status,
         @granted_at, @created_at, @created_at)`,
    ).run({
      chain_id: CHAIN_ID,
      contract: (row.contract ?? CONTRACT).toLowerCase(),
      call_id: callId,
      onchain,
      subscriber: (row.subscriber ?? SUBSCRIBER).toLowerCase(),
      receipt: row.receipt ?? null,
      amount: row.amount ?? null,
      currency: row.currency ?? null,
      status: row.status,
      grant_tx: row.grantTxHash ?? null,
      refund_status: row.refundStatus ?? null,
      granted_at: row.grantedAt ?? null,
      created_at: row.createdAt,
    });
  });
  db.pragma("foreign_keys = ON");
}

function newDb() {
  const tmp = mkdtempSync(join(tmpdir(), "purchases-surface-"));
  const db = openDb({ path: join(tmp, "test.db") });
  seed(db);
  return { db, tmp };
}

interface PurchasesBody {
  authenticated: boolean;
  scope: string;
  purchases: PurchaseRow[];
  next_cursor: string | null;
  page: { limit: number; returned: number };
  subscriber: string;
}

function surfaceDeps(db: ReturnType<typeof openDb>) {
  return {
    db,
    chain: { chainId: CHAIN_ID, sealedVerdictsAddress: CONTRACT },
    now: () => NOW,
  };
}

async function signedHeader(input: {
  account: typeof subscriberAccount;
  address: string;
  unixSeconds: number;
}): Promise<string> {
  const signature = await input.account.signMessage({
    message: subscriberAuthMessage(input.address, input.unixSeconds),
  });
  return `${input.unixSeconds}:${signature}`;
}

// ── Unauthenticated: granted rows only, and never the receipt id ─────────────
{
  const { db, tmp } = newDb();
  const res = await listSubscriberPurchasesResponse(surfaceDeps(db), {
    subscriber: SUBSCRIBER,
  });
  assert.equal(res.status, 200);
  const body = res.body as PurchasesBody;
  assert.equal(body.authenticated, false);
  assert.equal(body.scope, "granted_only");
  assert.equal(body.purchases.length, 3, "only this wallet's granted rows on this deployment");
  assert.ok(
    body.purchases.every((p) => p.status === "granted"),
    "no in-flight or refund rows without proof",
  );
  assert.ok(
    body.purchases.every((p) => p.payment_status === undefined && p.refund_status === undefined),
    "settlement detail is full-history only",
  );
  const adopted = body.purchases.find((p) => p.onchain_call_id === onchainCallId("a2"))!;
  assert.equal(adopted.amount, null, "adopted on-chain grants carry no amount by design");
  assert.equal(adopted.currency, null);
  assert.equal(adopted.producer_agent_slug, "oracle-one");
  assert.equal(adopted.reveal_open_at, "2026-08-11T00:00:00.000Z");
  assert.ok(
    !JSON.stringify(res.body).includes(RECEIPT_ID),
    "the settlement receipt id must never reach a response",
  );
  db.close();
  rmSync(tmp, { recursive: true, force: true });
}

// ── Valid proof: full history, with an honest payment status ────────────────
{
  const { db, tmp } = newDb();
  const res = await listSubscriberPurchasesResponse(surfaceDeps(db), {
    subscriber: SUBSCRIBER,
    authHeader: await signedHeader({
      account: subscriberAccount,
      address: SUBSCRIBER,
      unixSeconds: NOW_SEC - 30,
    }),
  });
  assert.equal(res.status, 200);
  const body = res.body as PurchasesBody;
  assert.equal(body.authenticated, true);
  assert.equal(body.scope, "full_history");
  assert.equal(body.purchases.length, 5, "in-flight and refund rows are included");
  assert.equal(body.subscriber, SUBSCRIBER.toLowerCase());

  const paid = body.purchases.find((p) => p.onchain_call_id === onchainCallId("a1"))!;
  assert.equal(paid.payment_confirmed, true);
  assert.equal(paid.payment_status, "confirmed");

  const refundDue = body.purchases.find((p) => p.onchain_call_id === onchainCallId("b2"))!;
  assert.equal(refundDue.refund_status, "refund_due");
  assert.equal(refundDue.payment_confirmed, false);
  assert.equal(
    refundDue.payment_status,
    "unknown",
    "a refund_due row with no receipt is not proof money moved",
  );

  const adopted = body.purchases.find((p) => p.onchain_call_id === onchainCallId("a2"))!;
  assert.equal(adopted.payment_status, "unknown", "an adopted grant never settled a payment");

  assert.ok(
    !JSON.stringify(res.body).includes(RECEIPT_ID),
    "the receipt id stays hidden even from the wallet that paid",
  );
  assert.ok(
    !JSON.stringify(res.body).includes("fee_bps"),
    "provider-side economics are not part of a buyer's record",
  );
  db.close();
  rmSync(tmp, { recursive: true, force: true });
}

// ── Stale timestamp is rejected, not silently downgraded ────────────────────
{
  const { db, tmp } = newDb();
  const res = await listSubscriberPurchasesResponse(surfaceDeps(db), {
    subscriber: SUBSCRIBER,
    authHeader: await signedHeader({
      account: subscriberAccount,
      address: SUBSCRIBER,
      unixSeconds: NOW_SEC - 3_600,
    }),
  });
  assert.equal(res.status, 401);
  assert.equal((res.body as { error: string }).error, "SubscriberAuthStale");
  db.close();
  rmSync(tmp, { recursive: true, force: true });
}

// ── A signature from the wrong wallet is rejected ───────────────────────────
{
  const { db, tmp } = newDb();
  const res = await listSubscriberPurchasesResponse(surfaceDeps(db), {
    subscriber: SUBSCRIBER,
    // Correct message, wrong signer: the impostor holds no key for SUBSCRIBER.
    authHeader: await signedHeader({
      account: impostorAccount,
      address: SUBSCRIBER,
      unixSeconds: NOW_SEC,
    }),
  });
  assert.equal(res.status, 401);
  assert.equal((res.body as { error: string }).error, "SubscriberAuthInvalid");
  assert.notEqual(impostorAccount.address.toLowerCase(), SUBSCRIBER.toLowerCase());
  db.close();
  rmSync(tmp, { recursive: true, force: true });
}

// ── A malformed header is rejected before any signature work ────────────────
{
  const { db, tmp } = newDb();
  const res = await listSubscriberPurchasesResponse(surfaceDeps(db), {
    subscriber: SUBSCRIBER,
    authHeader: "not-a-proof",
  });
  assert.equal(res.status, 401);
  assert.equal((res.body as { error: string }).error, "MalformedSubscriberAuth");
  db.close();
  rmSync(tmp, { recursive: true, force: true });
}

// ── Keyset pagination walks past the limit without repeats or gaps ──────────
{
  const { db, tmp } = newDb();
  const first = await listSubscriberPurchasesResponse(surfaceDeps(db), {
    subscriber: SUBSCRIBER,
    limit: 2,
  });
  const firstBody = first.body as PurchasesBody;
  assert.equal(firstBody.purchases.length, 2);
  assert.ok(firstBody.next_cursor, "a full page offers a cursor");

  const second = await listSubscriberPurchasesResponse(surfaceDeps(db), {
    subscriber: SUBSCRIBER,
    limit: 2,
    cursor: firstBody.next_cursor,
  });
  const secondBody = second.body as PurchasesBody;
  assert.equal(secondBody.purchases.length, 1, "the third granted row is reachable");
  assert.equal(secondBody.next_cursor, null, "a short page ends the walk");

  const seen = [...firstBody.purchases, ...secondBody.purchases].map((p) => p.onchain_call_id);
  assert.equal(new Set(seen).size, 3, "no row is repeated across pages");
  assert.deepEqual(
    seen,
    [onchainCallId("a3"), onchainCallId("a2"), onchainCallId("a1")],
    "newest first, and every row reachable",
  );
  db.close();
  rmSync(tmp, { recursive: true, force: true });
}

// ── Bad inputs ──────────────────────────────────────────────────────────────
{
  const { db, tmp } = newDb();
  const bad = await listSubscriberPurchasesResponse(surfaceDeps(db), { subscriber: "0xnope" });
  assert.equal(bad.status, 400);
  assert.equal((bad.body as { error: string }).error, "BadSubscriber");

  const badCursor = await listSubscriberPurchasesResponse(surfaceDeps(db), {
    subscriber: SUBSCRIBER,
    cursor: "!!!not-a-cursor!!!",
  });
  assert.equal(badCursor.status, 400);
  assert.equal((badCursor.body as { error: string }).error, "BadCursor");

  const unconfigured = await listSubscriberPurchasesResponse(
    { db, chain: null, now: () => NOW },
    { subscriber: SUBSCRIBER },
  );
  assert.equal(unconfigured.status, 503);
  db.close();
  rmSync(tmp, { recursive: true, force: true });
}

process.stdout.write("OK gateway purchases surface smoke\n");
