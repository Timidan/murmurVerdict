import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { privateKeyToAccount } from "viem/accounts";

import type {
  GrantChainAdapter,
  GrantDecryptAccessView,
} from "../integrations/fhenix-grant-env.js";
import { openDb } from "./db.js";
import type { EntitlementAccessDeps, SettleOutcome } from "./entitlement-access.js";
import {
  entitlementAccessResponse,
  entitlementStatusResponse,
  type EntitlementPaymentBroker,
  type EntitlementAccessSurfaceDeps,
} from "./entitlement-access-surface.js";
import { subscriberAuthMessage } from "./gateway-purchases-surface.js";

/**
 * Eligibility now fails closed on an unknown submission class, so a sale test
 * must seed the canonical accepted-call row that records it. An unseeded call
 * is correctly unsellable — that is the point of the check.
 */
function seedEarlyAccessCall(
  db: ReturnType<typeof openDb>,
  chainId: number,
  contractAddress: string,
  onchainCallId: string,
): void {
  const callId = `seed-${onchainCallId.slice(2, 12)}`;
  // These rows exist only to give eligibility a submission_class to read.
  // Building the full agent → submission → sealed-call FK chain would be a lot
  // of scaffolding for one column, so FKs are relaxed for the seed itself.
  db.pragma("foreign_keys = OFF");
  db.prepare(
    `INSERT OR IGNORE INTO submissions
       (call_id, agent_id, client_order_id, horizon_seconds, submitted_at,
        accepted_at, status, schema_version, scoring_version, dedup_key)
     VALUES (@call_id, 'agent', @call_id, 300, @now, @now, 'pending_resolution',
        1, 1, @call_id)`,
  ).run({ call_id: callId, now: "2026-07-20T00:00:00.000Z" });
  db.prepare(
    `INSERT INTO fhenix_sealed_calls
       (call_id, chain_id, contract_address, onchain_call_id, submit_tx_hash,
        submit_log_index, binary_index_ct_hash, confidence_ct_hash, reveal_open_at,
        submission_class, created_at)
     VALUES (@call_id, @chain_id, @contract_address, @onchain_call_id, @tx,
        0, '0x01', '0x02', @reveal, 1, @now)`,
  ).run({
    call_id: callId,
    chain_id: chainId,
    contract_address: contractAddress.toLowerCase(),
    onchain_call_id: onchainCallId.toLowerCase(),
    tx: `0x${onchainCallId.slice(2).padEnd(64, "0").slice(0, 64)}`,
    reveal: "2027-01-01T00:00:00.000Z",
    now: "2026-07-20T00:00:00.000Z",
  });
  db.pragma("foreign_keys = ON");
}

process.stdout.write("murmur entitlement access surface smoke\n");

const CHAIN_ID = 84532;
const CONTRACT = "0x1B74A4bAb1E06Ed107780a245c85337AB9dEcD1A";
const subscriberAccount = privateKeyToAccount(`0x${"11".repeat(32)}`);
const PAYER = subscriberAccount.address;
const CALL = "0x" + "ab".repeat(32);
const NOW = new Date("2026-07-20T00:00:00.000Z");
const NOW_SEC = Math.floor(NOW.getTime() / 1000);

const openView: GrantDecryptAccessView = {
  state: 1,
  grantCloseAt: NOW_SEC + 3600,
  binaryIndexCtHash: "0x0000000000000000000000000000000000000000000000000000000000000abc",
  confidenceCtHash: "0x0000000000000000000000000000000000000000000000000000000000000def",
  alreadyGranted: false,
};

function chain(view: GrantDecryptAccessView | null): GrantChainAdapter {
  return {
    chainId: CHAIN_ID,
    contractAddress: CONTRACT,
    grantorAddress: "0xabc",
    async sendGrant() {
      return "0xGRANTTX";
    },
    async getReceipt() {
      return { blockNumber: 5, success: true, confirmations: 3 };
    },
    async readDecryptAccess() {
      return view;
    },
    async getBalanceWei() {
      return 1n;
    },
    async hasGrantorRole() {
      return true;
    },
  };
}

function fakeBroker(opts: { authorizeCalls: { n: number } }): EntitlementPaymentBroker {
  return {
    async challenge() {
      return {
        scheme: "exact",
        network: "eip155:84532",
        asset: "0xUSDC",
        amount: "1000",
        payTo: "0xSELLER",
        maxTimeoutSeconds: 60,
      };
    },
    async authorize() {
      opts.authorizeCalls.n += 1;
      const settled: SettleOutcome = {
        kind: "settled",
        transaction: "circle-tx-1",
        payer: PAYER,
        amount: "1000",
        currency: "USDC",
      };
      return { ok: true, payment: { verifiedPayer: PAYER, settle: async () => settled } };
    },
  };
}

function deps(
  db: ReturnType<typeof openDb>,
  view: GrantDecryptAccessView | null,
  authorizeCalls: { n: number },
): EntitlementAccessSurfaceDeps {
  const access: EntitlementAccessDeps = {
    db,
    grantChain: chain(view),
    salesSafetySeconds: 180,
    // Every sale freezes a split. Injected rather than read from the ambient
    // environment so this smoke does not depend on the operator's .env.
    protocolFeeBps: 1_000,
    now: () => NOW,
  };
  return {
    access,
    broker: fakeBroker({ authorizeCalls }),
    priceAtoms: "1000",
    currency: "USDC",
    pricingVersion: "v1",
  };
}

function newDb() {
  const tmp = mkdtempSync(join(tmpdir(), "ent-surface-"));
  return { db: openDb({ path: join(tmp, `${randomUUID()}.db`) }), tmp };
}

// Bad callId → 400.
{
  const { db, tmp } = newDb();
  seedEarlyAccessCall(db, CHAIN_ID, CONTRACT, CALL);
  const r = await entitlementAccessResponse({
    deps: deps(db, openView, { n: 0 }),
    onchainCallId: "0xnope",
    paymentHeader: undefined,
  });
  assert.equal(r.status, 400);
  db.close();
  rmSync(tmp, { recursive: true, force: true });
}

// Sale window closed → 409 before any 402 or broker authorize.
{
  const { db, tmp } = newDb();
  seedEarlyAccessCall(db, CHAIN_ID, CONTRACT, CALL);
  const calls = { n: 0 };
  const r = await entitlementAccessResponse({
    deps: deps(db, { ...openView, grantCloseAt: NOW_SEC + 60 }, calls),
    onchainCallId: CALL,
    paymentHeader: "anything",
  });
  assert.equal(r.status, 409);
  assert.equal(calls.n, 0, "broker not invoked when window closed");
  db.close();
  rmSync(tmp, { recursive: true, force: true });
}

// Eligible, no payment → 402 with challenge accepts.
{
  const { db, tmp } = newDb();
  seedEarlyAccessCall(db, CHAIN_ID, CONTRACT, CALL);
  const r = await entitlementAccessResponse({
    deps: deps(db, openView, { n: 0 }),
    onchainCallId: CALL,
    paymentHeader: undefined,
  });
  assert.equal(r.status, 402);
  assert.ok(Array.isArray((r.body as { accepts: unknown[] }).accepts));
  db.close();
  rmSync(tmp, { recursive: true, force: true });
}

// The public status tier contains chain facts only. A proof from this wallet
// adds its private payment/grant state; a bad proof rejects instead of falling
// back to the public tier.
{
  const { db, tmp } = newDb();
  seedEarlyAccessCall(db, CHAIN_ID, CONTRACT, CALL);
  const d = deps(db, openView, { n: 0 });
  const r = await entitlementAccessResponse({
    deps: d,
    onchainCallId: CALL,
    paymentHeader: "base64payment",
  });
  assert.equal(r.status, 200);
  assert.equal((r.body as { granted: boolean }).granted, true);

  db.prepare(
    `UPDATE entitlements
        SET status = 'grant_failed_refund_due', refund_status = 'refund_due',
            grant_tx_hash = @tx, grant_block_number = 42, grant_attempts = 3,
            last_error = @error
      WHERE chain_id = @chain_id AND contract_address = @contract_address
        AND onchain_call_id = @onchain_call_id AND subscriber_address = @subscriber_address`,
  ).run({
    chain_id: CHAIN_ID,
    contract_address: CONTRACT.toLowerCase(),
    onchain_call_id: CALL.toLowerCase(),
    subscriber_address: PAYER.toLowerCase(),
    tx: `0x${"cd".repeat(32)}`,
    error: "provider rejected https://user:secret@rpc.example.test/v1 with Bearer token-secret",
  });

  const publicStatus = await entitlementStatusResponse({
    deps: d,
    onchainCallId: CALL,
    subscriberAddress: PAYER,
  });
  assert.equal(publicStatus.status, 200);
  const publicBody = publicStatus.body as {
    status: string;
    ciphertexts: {
      binaryIndex: { handle: string; fheType: string };
      confidenceBps: { handle: string; fheType: string };
    };
    grantCloseAt: number;
    grant: { onchainGranted: boolean };
    refundStatus?: unknown;
    lastError?: unknown;
  };
  assert.equal(publicBody.status, "none");
  assert.equal(publicBody.ciphertexts.binaryIndex.fheType, "Uint8");
  assert.equal(publicBody.ciphertexts.confidenceBps.fheType, "Uint16");
  assert.equal(publicBody.ciphertexts.binaryIndex.handle, openView.binaryIndexCtHash);
  assert.equal(publicBody.grantCloseAt, openView.grantCloseAt);
  assert.equal(publicBody.refundStatus, undefined);
  assert.equal(publicBody.lastError, undefined);
  assert.deepEqual(publicBody.grant, { onchainGranted: false });
  assert.ok(!JSON.stringify(publicBody).includes("secret"));

  const unixSeconds = Math.floor(NOW.getTime() / 1000);
  const signature = await subscriberAccount.signMessage({
    message: subscriberAuthMessage(PAYER, unixSeconds),
  });
  const privateStatus = await entitlementStatusResponse({
    deps: d,
    onchainCallId: CALL,
    subscriberAddress: PAYER,
    authHeader: `${unixSeconds}:${signature}`,
  });
  assert.equal(privateStatus.status, 200);
  const privateBody = privateStatus.body as {
    status: string;
    refundStatus: string | null;
    grant: { txHash: string | null; attempts: number };
    lastError: string | null;
  };
  assert.equal(privateBody.status, "grant_failed_refund_due");
  assert.equal(privateBody.refundStatus, "refund_due");
  assert.equal(privateBody.grant.txHash, `0x${"cd".repeat(32)}`);
  assert.equal(privateBody.grant.attempts, 3);
  assert.ok(privateBody.lastError?.includes("https://rpc.example.test/<redacted>"));
  assert.ok(!privateBody.lastError?.includes("secret"));

  const invalid = await entitlementStatusResponse({
    deps: d,
    onchainCallId: CALL,
    subscriberAddress: PAYER,
    authHeader: `${unixSeconds}:0x${"00".repeat(65)}`,
  });
  assert.equal(invalid.status, 401);
  assert.equal((invalid.body as { error: string }).error, "SubscriberAuthInvalid");
  db.close();
  rmSync(tmp, { recursive: true, force: true });
}

process.stdout.write("OK entitlement access surface smoke\n");
