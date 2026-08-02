import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDb } from "../verdict/db.js";
import type { EntitlementAccessDeps } from "../verdict/entitlement-access.js";
import { entitlementsRepo } from "../verdict/repos/entitlements-repo.js";
import type {
  GrantChainAdapter,
  GrantChainReceipt,
  GrantDecryptAccessView,
} from "./fhenix-grant-env.js";
import { FhenixGrantReconciler } from "./fhenix-grant-reconciler.js";

process.stdout.write("murmur fhenix grant reconciler smoke\n");

const CHAIN_ID = 84532;
const CONTRACT = "0x1B74A4bAb1E06Ed107780a245c85337AB9dEcD1A";
const SUB = "0xCAFEbabeCAFEbabeCAFEbabeCAFEbabeCAFEbabe";

// A mutable clock so tests can advance past the re-broadcast grace window.
function clock(startIso = "2026-07-20T00:00:00.000Z") {
  let t = new Date(startIso).getTime();
  return {
    now: () => new Date(t),
    advance(seconds: number) {
      t += seconds * 1000;
    },
  };
}

function chain(opts: {
  sendGrant?: () => Promise<string>;
  receipt?: GrantChainReceipt | null;
  readView?: GrantDecryptAccessView | null;
  onGrant?: (i: number) => void;
}): GrantChainAdapter & { grantCount: () => number } {
  let grants = 0;
  return {
    grantCount: () => grants,
    chainId: CHAIN_ID,
    contractAddress: CONTRACT,
    grantorAddress: "0xabc",
    async sendGrant() {
      grants += 1;
      opts.onGrant?.(grants);
      if (opts.sendGrant) return opts.sendGrant();
      return `0xGRANT${grants}`;
    },
    async getReceipt() {
      return opts.receipt ?? null;
    },
    async readDecryptAccess() {
      return opts.readView ?? null;
    },
    async getBalanceWei() {
      return 1n;
    },
  };
}

function accessDeps(
  db: ReturnType<typeof openDb>,
  c: GrantChainAdapter,
  now: () => Date,
  extra: Partial<EntitlementAccessDeps> = {},
): EntitlementAccessDeps {
  return { db, grantChain: c, salesSafetySeconds: 180, now, ...extra };
}

function seed(
  db: ReturnType<typeof openDb>,
  onchainCallId: string,
  status: Parameters<typeof entitlementsRepo.transition>[2][number],
  nowIso: string,
): number {
  const id = entitlementsRepo.reserve(db, {
    chainId: CHAIN_ID,
    contractAddress: CONTRACT,
    onchainCallId,
    subscriberAddress: SUB,
    callId: null,
    producerAgentId: null,
    amount: "1000",
    currency: "USDC",
    now: nowIso,
  });
  if (status !== "payment_settling") {
    entitlementsRepo.transition(db, id, ["payment_settling"], {
      status: "grant_queued",
      nanopayReceiptId: "tx",
      now: nowIso,
    });
  }
  return id;
}

function newDb() {
  const tmp = mkdtempSync(join(tmpdir(), "grant-recon-"));
  return { db: openDb({ path: join(tmp, `${randomUUID()}.db`) }), tmp };
}

const grantedView: GrantDecryptAccessView = {
  state: 1,
  revealOpenAt: 0,
  binaryIndexCtHash: "0x01",
  confidenceCtHash: "0x02",
  alreadyGranted: true,
};

// grant_queued → broadcast + confirm → granted across ticks. The broadcast row
// carries a re-broadcast grace, so advance the clock before the confirm tick.
{
  const { db, tmp } = newDb();
  const clk = clock();
  const id = seed(db, "0x" + "a1".repeat(32), "grant_queued", clk.now().toISOString());
  const c = chain({ receipt: { blockNumber: 7, success: true, confirmations: 2 } });
  const recon = new FhenixGrantReconciler({ db, access: accessDeps(db, c, clk.now) });

  const t1 = await recon.tick();
  assert.equal(t1.processed, 1);
  assert.equal(entitlementsRepo.byId(db, id)?.status, "grant_broadcast");

  clk.advance(60);
  const t2 = await recon.tick();
  assert.equal(t2.granted, 1);
  assert.equal(entitlementsRepo.byId(db, id)?.status, "granted");
  assert.equal(entitlementsRepo.byId(db, id)?.grant_block_number, 7);

  const t3 = await recon.tick();
  assert.equal(t3.processed, 0, "granted row is terminal, not re-processed");

  db.close();
  rmSync(tmp, { recursive: true, force: true });
}

// grant_queued whose grant reverts (and the subscriber does NOT already hold
// access) → refund_due (settled money owed back).
{
  const { db, tmp } = newDb();
  const clk = clock();
  const id = seed(db, "0x" + "b2".repeat(32), "grant_queued", clk.now().toISOString());
  const c = chain({
    sendGrant: async () => {
      throw new Error("execution reverted: DecryptGrantWindowClosed");
    },
    readView: { ...grantedView, alreadyGranted: false },
  });
  const recon = new FhenixGrantReconciler({ db, access: accessDeps(db, c, clk.now) });
  const t = await recon.tick();
  assert.equal(t.refund_due, 1);
  const row = entitlementsRepo.byId(db, id);
  assert.equal(row?.status, "grant_failed_refund_due");
  assert.equal(row?.refund_status, "refund_due");
  db.close();
  rmSync(tmp, { recursive: true, force: true });
}

// P1: crash-restart re-broadcast after the window closed. The earlier grant tx
// ALREADY landed (getDecryptAccess.alreadyGranted=true), so the window-closed
// revert on retry must NOT refund an already-granted subscriber — mark granted.
{
  const { db, tmp } = newDb();
  const clk = clock();
  const id = seed(db, "0x" + "d4".repeat(32), "grant_queued", clk.now().toISOString());
  const c = chain({
    sendGrant: async () => {
      throw new Error("execution reverted: DecryptGrantWindowClosed");
    },
    readView: grantedView, // subscriber already holds on-chain access
  });
  const recon = new FhenixGrantReconciler({ db, access: accessDeps(db, c, clk.now) });
  const t = await recon.tick();
  assert.equal(t.granted, 1, "already-granted subscriber is reconciled to granted, not refunded");
  const row = entitlementsRepo.byId(db, id);
  assert.equal(row?.status, "granted");
  assert.equal(row?.refund_status ?? null, null, "no refund owed on an already-granted subscriber");
  db.close();
  rmSync(tmp, { recursive: true, force: true });
}

// P0: a broadcast grant tx that never mines (getReceipt null forever) must not
// strand the settled payment. The reconciler re-broadcasts within the grace
// budget, then marks refund_due once attempts are exhausted.
{
  const { db, tmp } = newDb();
  const clk = clock();
  const id = seed(db, "0x" + "e5".repeat(32), "grant_queued", clk.now().toISOString());
  const c = chain({ receipt: null, readView: { ...grantedView, alreadyGranted: false } });
  const recon = new FhenixGrantReconciler({
    db,
    access: accessDeps(db, c, clk.now, { maxGrantAttempts: 3 }),
  });

  let refunded = false;
  for (let i = 0; i < 20 && !refunded; i += 1) {
    await recon.tick();
    clk.advance(60); // past the re-broadcast grace each round
    refunded = entitlementsRepo.byId(db, id)?.status === "grant_failed_refund_due";
  }
  const row = entitlementsRepo.byId(db, id);
  assert.equal(row?.status, "grant_failed_refund_due", "dropped grant tx heals to refund_due");
  assert.equal(row?.refund_status, "refund_due");
  assert.ok(c.grantCount() > 1, "the dropped grant tx was actually re-broadcast");
  db.close();
  rmSync(tmp, { recursive: true, force: true });
}

// A dropped tx whose on-chain grant actually DID land (getReceipt null but
// getDecryptAccess.alreadyGranted=true) reconciles to granted, not refund.
{
  const { db, tmp } = newDb();
  const clk = clock();
  const id = seed(db, "0x" + "f6".repeat(32), "grant_queued", clk.now().toISOString());
  const c = chain({ receipt: null, readView: grantedView });
  const recon = new FhenixGrantReconciler({ db, access: accessDeps(db, c, clk.now) });

  await recon.tick(); // grant_queued → grant_broadcast
  clk.advance(60);
  await recon.tick(); // null receipt, grace elapsed → on-chain says granted
  assert.equal(entitlementsRepo.byId(db, id)?.status, "granted");
  db.close();
  rmSync(tmp, { recursive: true, force: true });
}

// payment_settling that never settled → settlement_unknown (recovered), then
// conservatively → refund_due after the resolution budget (never stranded).
{
  const { db, tmp } = newDb();
  const clk = clock();
  const id = seed(db, "0x" + "c3".repeat(32), "payment_settling", clk.now().toISOString());
  const c = chain({});
  const recon = new FhenixGrantReconciler({
    db,
    access: accessDeps(db, c, clk.now, { settlementUnknownMaxAttempts: 3 }),
  });
  await recon.tick();
  assert.equal(entitlementsRepo.byId(db, id)?.status, "settlement_unknown");

  let refunded = false;
  for (let i = 0; i < 20 && !refunded; i += 1) {
    clk.advance(60);
    await recon.tick();
    refunded = entitlementsRepo.byId(db, id)?.status === "grant_failed_refund_due";
  }
  const row = entitlementsRepo.byId(db, id);
  assert.equal(row?.status, "grant_failed_refund_due", "settlement_unknown resolves to refund_due");
  assert.equal(row?.refund_status, "refund_due");
  db.close();
  rmSync(tmp, { recursive: true, force: true });
}

process.stdout.write("OK fhenix grant reconciler smoke\n");
