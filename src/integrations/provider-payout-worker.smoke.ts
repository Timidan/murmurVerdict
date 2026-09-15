import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDb } from "../verdict/db.js";
import { providerWithdrawalsRepo } from "../verdict/repos/provider-withdrawals-repo.js";
import { providerPayoutsRepo } from "../verdict/repos/provider-payouts-repo.js";
import type { PayoutChainAdapter, SignedTransfer, TransferReceipt } from "./payout-chain-env.js";
import { payoutWorkerTick, type PayoutWorkerDeps } from "./provider-payout-worker.js";

// ─── The worker that spends money ───────────────────────────────────────────
//
// One property dominates every other thing this file checks:
//
//     A CRASH BETWEEN BROADCASTING AND RECORDING MUST NOT SEND TWICE.
//
// An ERC-20 transfer has no idempotency of its own, so the guard is entirely
// procedural: bytes and nonce are persisted before the first broadcast, and
// recovery rebroadcasts those exact bytes rather than signing new ones. The
// scripted chain below counts how many DISTINCT transactions were ever signed,
// because that — not how many times broadcast() was called — is the number
// that would cost real money.
process.stdout.write("murmur provider payout worker smoke\n");

const CHAIN_ID = 84532;
const SENDER = "0x1111111111111111111111111111111111111111";
const DEST = "0x2222222222222222222222222222222222222222";
const NOW = Date.parse("2026-09-13T00:00:00.000Z");

interface Script {
  signed: SignedTransfer[];
  broadcasts: string[];
  receipt: TransferReceipt | null;
  receiptThrows?: boolean;
  broadcastThrows?: string;
  tokenBalance: bigint;
  gasWei: bigint;
  pendingNonce: number;
}

function chainOf(script: Script): PayoutChainAdapter {
  return {
    chainId: CHAIN_ID,
    tokenAddress: "0xusdc",
    senderAddress: SENDER,
    getPendingNonce: async () => script.pendingNonce,
    signTransfer: async ({ nonce }) => {
      // A DISTINCT transaction every call — exactly what must not happen twice.
      const t: SignedTransfer = {
        raw: `0xraw-${script.signed.length}-nonce${nonce}`,
        hash: `0xhash-${script.signed.length}-nonce${nonce}`,
        nonce,
      };
      script.signed.push(t);
      return t;
    },
    broadcast: async (raw) => {
      script.broadcasts.push(raw);
      if (script.broadcastThrows) throw new Error(script.broadcastThrows);
    },
    getReceipt: async () => {
      if (script.receiptThrows) throw new Error("rpc unavailable");
      return script.receipt;
    },
    getTokenBalance: async () => script.tokenBalance,
    getGasBalanceWei: async () => script.gasWei,
  };
}

const tmp = mkdtempSync(join(tmpdir(), "payout-worker-"));
const db = openDb({ path: join(tmp, `${randomUUID()}.db`) });
const agentId = randomUUID();
db.prepare(
  `INSERT INTO agents (agent_id, display_slug, kind, display_name, bio, created_at)
   VALUES (?, ?, 'agent', 'Seller', NULL, ?)`,
).run(agentId, `seller-${agentId.slice(0, 8)}`, new Date(NOW).toISOString());

let reqNo = 0;
function reserve(amount: string) {
  return providerWithdrawalsRepo.reserve(db, {
    producer_agent_id: agentId,
    client_request_id: `req-${++reqNo}`,
    chain_id: CHAIN_ID,
    token_address: "0xusdc",
    currency: "USDC",
    amount_atoms: amount,
    destination_address: DEST,
    sender_address: SENDER,
    created_at: new Date(NOW).toISOString(),
  });
}

let at = NOW;
function depsFor(script: Script): PayoutWorkerDeps {
  return {
    db,
    now: () => new Date(at),
    chain: chainOf(script),
    config: {
      confirmations: 2,
      maxJobsPerTick: 10,
      retryBaseMs: 1000,
      retryMaxMs: 60_000,
      minGasBalanceWei: 10n,
    },
  };
}

const fresh = (over: Partial<Script> = {}): Script => ({
  signed: [],
  broadcasts: [],
  receipt: null,
  tokenBalance: 1_000_000_000n,
  gasWei: 1_000_000n,
  pendingNonce: 0,
  ...over,
});

const good = (): TransferReceipt => ({
  blockNumber: 100,
  success: true,
  confirmations: 5,
  matchedTransfer: true,
});

// ─── Happy path: one signature, one journal entry ──────────────────────────

{
  const w = reserve("1000000");
  const script = fresh();
  await payoutWorkerTick(depsFor(script)); // reserved → signed → submitted
  assert.equal(providerWithdrawalsRepo.byId(db, w.id)?.state, "submitted");
  assert.equal(script.signed.length, 1);

  script.receipt = good();
  at += 60_000;
  const tick = await payoutWorkerTick(depsFor(script));
  assert.equal(tick.paid, 1);
  const row = providerWithdrawalsRepo.byId(db, w.id);
  assert.equal(row?.state, "paid");
  assert.ok(row?.payout_id, "paid and journalled in one transaction");
  const journal = providerPayoutsRepo.byId(db, row!.payout_id!);
  assert.equal(journal?.amount_atoms, "1000000");
  assert.equal(
    journal?.tx_ref,
    `eip155:${CHAIN_ID}:${script.signed[0].hash}`,
    "the reference is chain-qualified, so a hash from another network cannot collide",
  );
  assert.equal(journal?.destination_ref, DEST, "and records where it actually went");
}

// ─── THE ONE: a crash after broadcasting must not send twice ───────────────

{
  const w = reserve("2000000");
  const script = fresh({ pendingNonce: 1 });

  // Tick 1 signs, persists, broadcasts — then the process "dies" before the
  // receipt is ever read. The row is left exactly as a crash would leave it.
  await payoutWorkerTick(depsFor(script));
  const afterCrash = providerWithdrawalsRepo.byId(db, w.id);
  assert.equal(script.signed.length, 1, "one signature so far");
  const bytes = afterCrash?.signed_raw_tx;
  const nonce = afterCrash?.nonce;
  assert.ok(bytes && nonce !== null, "the bytes and the nonce were written down BEFORE sending");

  // Restart: the chain still has no receipt, and the mempool may have dropped
  // it. The worker must rebroadcast the SAME bytes.
  at += 60_000;
  script.receipt = null;
  await payoutWorkerTick(depsFor(script));
  assert.equal(script.signed.length, 1, "NOT re-signed — a second signature is a second transfer");
  assert.ok(
    script.broadcasts.every((b) => b === bytes),
    "every broadcast carried the identical bytes",
  );
  assert.equal(providerWithdrawalsRepo.byId(db, w.id)?.nonce, nonce, "and kept its nonce");

  // The original finally mines. Exactly one journal entry results.
  at += 60_000;
  script.receipt = good();
  const before = providerPayoutsRepo.totalsForAgent(db, agentId)[0]?.entries ?? 0;
  await payoutWorkerTick(depsFor(script));
  const after = providerPayoutsRepo.totalsForAgent(db, agentId)[0]?.entries ?? 0;
  assert.equal(after - before, 1, "one transfer, one journal row");
  assert.equal(providerWithdrawalsRepo.byId(db, w.id)?.state, "paid");
  assert.equal(script.signed.length, 1, "still exactly one signature, end to end");
}

// ─── A nonce is owned for the life of the row ──────────────────────────────

{
  const a = reserve("100000");
  const script = fresh({ pendingNonce: 0 }); // the node has forgotten the pool
  await payoutWorkerTick(depsFor(script));
  const nonces = [a.id].map((id) => providerWithdrawalsRepo.byId(db, id)?.nonce);
  assert.ok(
    nonces[0] !== null && nonces[0]! > 1,
    "allocation counts nonces this deployment already claimed, not just the chain's pending count",
  );
}

// ─── Succeeded, but moved nothing we recognise ─────────────────────────────

{
  const w = reserve("300000");
  const script = fresh({ pendingNonce: 50 });
  await payoutWorkerTick(depsFor(script));
  at += 60_000;
  script.receipt = { ...good(), matchedTransfer: false };
  const tick = await payoutWorkerTick(depsFor(script));
  assert.ok(tick.needsReview >= 1);
  const row = providerWithdrawalsRepo.byId(db, w.id);
  assert.equal(row?.state, "needs_review");
  assert.equal(row?.payout_id, null, "never journalled on an unverified transfer");
  // And the funds stay held — releasing them would let the same earnings pay twice.
  assert.ok(
    providerWithdrawalsRepo.heldAtoms(db, { producerAgentId: agentId, currency: "USDC" }) >= 300000n,
    "a transfer that MAY have landed keeps holding its reservation",
  );
}

// ─── An unreadable chain defers; it never resolves either way ──────────────

{
  const w = reserve("400000");
  const script = fresh({ pendingNonce: 60 });
  await payoutWorkerTick(depsFor(script));
  at += 60_000;
  script.receiptThrows = true;
  const tick = await payoutWorkerTick(depsFor(script));
  assert.ok(tick.deferred >= 1);
  const row = providerWithdrawalsRepo.byId(db, w.id);
  assert.equal(row?.state, "submitted", "still in flight, not guessed at");
  assert.ok(row?.next_attempt_at, "and backed off");
}

// ─── A finalized revert is the ONE case that frees the money ───────────────

{
  const w = reserve("500000");
  const script = fresh({ pendingNonce: 70 });
  await payoutWorkerTick(depsFor(script));
  at += 60_000;
  script.receipt = { ...good(), success: false, matchedTransfer: false };
  const tick = await payoutWorkerTick(depsFor(script));
  assert.ok(tick.failed >= 1);
  assert.equal(providerWithdrawalsRepo.byId(db, w.id)?.state, "failed");
}

// ─── No gas, no signing ────────────────────────────────────────────────────

{
  const w = reserve("600000");
  at += 60_000;
  const script = fresh({ gasWei: 1n, pendingNonce: 80 });
  const tick = await payoutWorkerTick(depsFor(script));
  assert.equal(script.signed.length, 0, "nothing is signed when gas is below the floor");
  assert.equal(providerWithdrawalsRepo.byId(db, w.id)?.state, "reserved");
  assert.ok(tick.deferred >= 1);
}

// ─── A sold agent is not a funded wallet ───────────────────────────────────
//
// Sales settle into Circle Gateway's batched credit, which is not spendable
// ERC-20. Signing against a balance that is not there would produce a
// transaction that reverts, burning gas and a nonce.

{
  const w = reserve("700000");
  at += 60_000;
  const script = fresh({ tokenBalance: 1n, pendingNonce: 90 });
  await payoutWorkerTick(depsFor(script));
  assert.equal(script.signed.length, 0, "the float is checked before the nonce is spent");
  const row = providerWithdrawalsRepo.byId(db, w.id);
  assert.equal(row?.state, "reserved");
  assert.ok(row?.last_error?.includes("insufficient liquid balance"));
}

// ─── "nonce too low" is not proof we landed ────────────────────────────────
//
// Some other transaction from the payout wallet took the nonce. Our bytes may
// never mine. Marking this submitted would poll a dead hash forever while the
// funds stay reserved; the honest state is review, with the funds still held.

{
  const w = reserve("800000");
  at += 60_000;
  const script = fresh({ pendingNonce: 100, broadcastThrows: "nonce too low" });
  const tick = await payoutWorkerTick(depsFor(script));
  assert.ok(tick.needsReview >= 1);
  const row = providerWithdrawalsRepo.byId(db, w.id);
  assert.equal(row?.state, "needs_review");
  assert.ok(row?.last_error?.includes("Another writer"), "and it names the cause");
  assert.equal(row?.payout_id, null);
}

// ─── A row this adapter does not own is never signed by it ─────────────────

{
  const foreign = providerWithdrawalsRepo.reserve(db, {
    producer_agent_id: agentId,
    client_request_id: "req-foreign",
    chain_id: CHAIN_ID,
    token_address: "0xusdc",
    currency: "USDC",
    amount_atoms: "900000",
    destination_address: DEST,
    sender_address: "0x9999999999999999999999999999999999999999", // a previous seller
    created_at: new Date(at).toISOString(),
  });
  at += 60_000;
  const script = fresh({ pendingNonce: 110 });
  await payoutWorkerTick(depsFor(script));
  assert.equal(script.signed.length, 0, "a cutover row is parked, not paid from the new wallet");
  assert.equal(providerWithdrawalsRepo.byId(db, foreign.id)?.state, "needs_review");
}

db.close();
rmSync(tmp, { recursive: true, force: true });
process.stdout.write("OK provider payout worker smoke\n");
