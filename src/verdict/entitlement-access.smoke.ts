import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  GrantChainAdapter,
  GrantChainReceipt,
  GrantDecryptAccessView,
} from "../integrations/fhenix-grant-env.js";
import { openDb } from "./db.js";
import {
  purchaseEntitlementAccess,
  type EntitlementAccessDeps,
  type SettleOutcome,
} from "./entitlement-access.js";
import { entitlementsRepo } from "./repos/entitlements-repo.js";

process.stdout.write("murmur entitlement access orchestrator smoke\n");

const CHAIN_ID = 84532;
const CONTRACT = "0x1B74A4bAb1E06Ed107780a245c85337AB9dEcD1A";
const PAYER = "0xCAFEbabeCAFEbabeCAFEbabeCAFEbabeCAFEbabe";
const NOW = new Date("2026-07-20T00:00:00.000Z");
const NOW_SEC = Math.floor(NOW.getTime() / 1000);

interface FakeChainOpts {
  view: GrantDecryptAccessView | null;
  sendGrant?: () => Promise<string>;
  receipt?: GrantChainReceipt | null;
}

function fakeChain(opts: FakeChainOpts): GrantChainAdapter & { grants: string[] } {
  const grants: string[] = [];
  return {
    grants,
    chainId: CHAIN_ID,
    contractAddress: CONTRACT,
    grantorAddress: "0xabc",
    async sendGrant(callId, subscriber) {
      grants.push(`${callId}:${subscriber}`);
      if (opts.sendGrant) return opts.sendGrant();
      return "0xGRANTTX";
    },
    async getReceipt() {
      return opts.receipt ?? null;
    },
    async readDecryptAccess() {
      return opts.view;
    },
    async getBalanceWei() {
      return 1n;
    },
  };
}

function deps(chain: GrantChainAdapter, db: ReturnType<typeof openDb>): EntitlementAccessDeps {
  return {
    db,
    grantChain: chain,
    salesSafetySeconds: 180,
    now: () => NOW,
    resolveProducerAgentId: () => "agent-xyz",
  };
}

const settled: SettleOutcome = {
  kind: "settled",
  transaction: "circle-tx-1",
  payer: PAYER,
  amount: "1000",
  currency: "USDC",
};

function newDb() {
  const tmp = mkdtempSync(join(tmpdir(), "ent-access-"));
  const db = openDb({ path: join(tmp, `${randomUUID()}.db`) });
  return { db, tmp };
}

// Sealed with a comfortable window (revealOpenAt far in the future).
const openView: GrantDecryptAccessView = {
  state: 1,
  revealOpenAt: NOW_SEC + 3600,
  binaryIndexCtHash: "0x01",
  confidenceCtHash: "0x02",
  alreadyGranted: false,
};

// 1. Ineligible (sale window closed) → 409, NO reservation, NO settle called.
{
  const { db, tmp } = newDb();
  const chain = fakeChain({
    view: { ...openView, revealOpenAt: NOW_SEC + 60 }, // within 180s safety margin
  });
  let settleCalled = false;
  const result = await purchaseEntitlementAccess(deps(chain, db), {
    onchainCallId: "0xCALL1",
    verifiedPayer: PAYER,
    settlement: {
      settle: async () => {
        settleCalled = true;
        return settled;
      },
    },
  });
  assert.equal(result.kind, "error");
  assert.equal(result.kind === "error" && result.status, 409);
  assert.equal(settleCalled, false, "no charge when sale window closed");
  assert.equal(entitlementsRepo.counts(db).payment_settling, 0, "no reservation left behind");
  db.close();
  rmSync(tmp, { recursive: true, force: true });
}

// 2. Happy path → granted, grant broadcast + confirmed inline.
{
  const { db, tmp } = newDb();
  const chain = fakeChain({
    view: openView,
    receipt: { blockNumber: 42, success: true, confirmations: 2 },
  });
  const result = await purchaseEntitlementAccess(deps(chain, db), {
    onchainCallId: "0xCALL2",
    verifiedPayer: PAYER,
    settlement: { settle: async () => settled },
  });
  assert.equal(result.kind, "granted");
  assert.equal(chain.grants.length, 1, "grant broadcast exactly once");
  const row = result.kind === "granted" ? result.row : null;
  assert.equal(row?.status, "granted");
  assert.equal(row?.grant_block_number, 42);
  assert.equal(row?.nanopay_receipt_id, "circle-tx-1");
  assert.equal(row?.amount, "1000");
  assert.equal(row?.producer_agent_id, "agent-xyz");

  // Replay of an owned entitlement → already_owned, no second grant.
  const replay = await purchaseEntitlementAccess(deps(chain, db), {
    onchainCallId: "0xCALL2",
    verifiedPayer: PAYER,
    settlement: { settle: async () => settled },
  });
  assert.equal(replay.kind, "already_owned");
  assert.equal(chain.grants.length, 1, "no re-grant on replay");
  db.close();
  rmSync(tmp, { recursive: true, force: true });
}

// 3. Grant reverts at broadcast (window closed between settle and grant) →
//    refund_due (settled payment NEVER relabeled a plain failure).
{
  const { db, tmp } = newDb();
  const chain = fakeChain({
    view: openView,
    sendGrant: async () => {
      throw new Error("execution reverted: DecryptGrantWindowClosed");
    },
  });
  const result = await purchaseEntitlementAccess(deps(chain, db), {
    onchainCallId: "0xCALL3",
    verifiedPayer: PAYER,
    settlement: { settle: async () => settled },
  });
  assert.equal(result.kind, "refund_due");
  const row = result.kind === "refund_due" ? result.row : null;
  assert.equal(row?.status, "grant_failed_refund_due");
  assert.equal(row?.refund_status, "refund_due");
  db.close();
  rmSync(tmp, { recursive: true, force: true });
}

// 4. Definitive settle rejection → 402, reservation RELEASED (retry allowed).
{
  const { db, tmp } = newDb();
  const chain = fakeChain({ view: openView });
  const result = await purchaseEntitlementAccess(deps(chain, db), {
    onchainCallId: "0xCALL4",
    verifiedPayer: PAYER,
    settlement: {
      settle: async () => ({ kind: "rejected", reason: "Circle rejected" }),
    },
  });
  assert.equal(result.kind, "error");
  assert.equal(result.kind === "error" && result.status, 402);
  assert.equal(chain.grants.length, 0, "no grant when payment rejected");
  assert.equal(
    entitlementsRepo.byReservation(db, {
      chainId: CHAIN_ID,
      contractAddress: CONTRACT,
      onchainCallId: "0xCALL4",
      subscriberAddress: PAYER,
    }),
    null,
    "reservation released after definitive rejection",
  );
  db.close();
  rmSync(tmp, { recursive: true, force: true });
}

// 5. Uncertain settlement (transport error after settle) → processing +
//    settlement_unknown for the reconciler.
{
  const { db, tmp } = newDb();
  const chain = fakeChain({ view: openView });
  const result = await purchaseEntitlementAccess(deps(chain, db), {
    onchainCallId: "0xCALL5",
    verifiedPayer: PAYER,
    settlement: {
      settle: async () => ({ kind: "unknown", reason: "timeout" }),
    },
  });
  assert.equal(result.kind, "processing");
  const row = result.kind === "processing" ? result.row : null;
  assert.equal(row?.status, "settlement_unknown");
  assert.equal(chain.grants.length, 0, "no grant when settlement uncertain");
  db.close();
  rmSync(tmp, { recursive: true, force: true });
}

// 6. Grant reverts window-closed BUT the subscriber already holds on-chain
//    access (crash-restart double-broadcast) → granted, NOT refund_due.
{
  const { db, tmp } = newDb();
  const chain = fakeChain({
    view: { ...openView, alreadyGranted: true },
    sendGrant: async () => {
      throw new Error("execution reverted: DecryptGrantWindowClosed");
    },
  });
  const result = await purchaseEntitlementAccess(deps(chain, db), {
    onchainCallId: "0xCALL6",
    verifiedPayer: PAYER,
    settlement: { settle: async () => settled },
  });
  assert.equal(result.kind, "granted", "already-granted subscriber must not be refunded");
  const row = result.kind === "granted" ? result.row : null;
  assert.equal(row?.status, "granted");
  assert.equal(row?.refund_status ?? null, null);
  db.close();
  rmSync(tmp, { recursive: true, force: true });
}

process.stdout.write("OK entitlement access orchestrator smoke\n");
