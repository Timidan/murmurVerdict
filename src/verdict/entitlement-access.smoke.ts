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
  checkEntitlementEligibility,
  purchaseEntitlementAccess,
  type EntitlementAccessDeps,
  type SettleOutcome,
} from "./entitlement-access.js";
import { entitlementsRepo } from "./repos/entitlements-repo.js";

/** Eligibility fails closed on an unknown submission class, so each sale test seeds the accepted-call row. */
function seedEarlyAccessCall(
  db: ReturnType<typeof openDb>,
  chainId: number,
  contractAddress: string,
  onchainCallId: string,
): void {
  const callId = `seed-${onchainCallId.slice(2, 12)}`;
  // FKs off for the seed: these rows only give eligibility a submission_class to read.
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
  const check = db.prepare(
    "SELECT submission_class FROM fhenix_sealed_calls WHERE lower(onchain_call_id)=lower(?)",
  ).get(onchainCallId) as { submission_class?: number } | undefined;
  if (check?.submission_class !== 1) {
    throw new Error(`seed failed for ${onchainCallId}: ${JSON.stringify(check)}`);
  }
}

process.stdout.write("murmur entitlement access orchestrator smoke\n");

const CHAIN_ID = 84532;
const CONTRACT = "0x1B74A4bAb1E06Ed107780a245c85337AB9dEcD1A";
const PAYER = "0xCAFEbabeCAFEbabeCAFEbabeCAFEbabeCAFEbabe";
const NOW = new Date("2026-07-20T00:00:00.000Z");
const NOW_SEC = Math.floor(NOW.getTime() / 1000);

interface FakeChainOpts {
  view: GrantDecryptAccessView | null;
  /** Returned once a grant has been attempted; see readDecryptAccess below. */
  viewAfterGrant?: GrantDecryptAccessView | null;
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
      // Crash-restart shape: not granted before purchase, granted once a grant was attempted.
      if (opts.viewAfterGrant && grants.length > 0) return opts.viewAfterGrant;
      return opts.view;
    },
    async getBalanceWei() {
      return 1n;
    },
    async hasGrantorRole() {
      return true;
    },
  };
}

function deps(chain: GrantChainAdapter, db: ReturnType<typeof openDb>): EntitlementAccessDeps {
  return {
    db,
    grantChain: chain,
    salesSafetySeconds: 180,
    // Injected so the smoke never reads .env; seeded calls have no fee snapshot, so reservations stamp this.
    protocolFeeBps: 1_000,
    now: () => NOW,
    resolveProducerAgentId: () => "agent-xyz",
    // "agent-xyz" isn't a real agent, so swallow attribution warnings; provider-earnings.smoke.ts covers that.
    logger: { warn: () => undefined },
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

// Sealed with a comfortable window (grantCloseAt far in the future).
const openView: GrantDecryptAccessView = {
  state: 1,
  grantCloseAt: NOW_SEC + 3600,
  binaryIndexCtHash: "0x01",
  confidenceCtHash: "0x02",
  alreadyGranted: false,
};

// 1. Ineligible (sale window closed) → 409, NO reservation, NO settle called.
{
  const { db, tmp } = newDb();
  seedEarlyAccessCall(db, CHAIN_ID, CONTRACT, "0xCALL1");
  seedEarlyAccessCall(db, CHAIN_ID, CONTRACT, "0xCALL2");
  seedEarlyAccessCall(db, CHAIN_ID, CONTRACT, "0xCALL3");
  seedEarlyAccessCall(db, CHAIN_ID, CONTRACT, "0xCALL4");
  seedEarlyAccessCall(db, CHAIN_ID, CONTRACT, "0xCALL5");
  seedEarlyAccessCall(db, CHAIN_ID, CONTRACT, "0xCALL6");
  const chain = fakeChain({
    view: { ...openView, grantCloseAt: NOW_SEC + 60 }, // within 180s safety margin
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
  seedEarlyAccessCall(db, CHAIN_ID, CONTRACT, "0xCALL1");
  seedEarlyAccessCall(db, CHAIN_ID, CONTRACT, "0xCALL2");
  seedEarlyAccessCall(db, CHAIN_ID, CONTRACT, "0xCALL3");
  seedEarlyAccessCall(db, CHAIN_ID, CONTRACT, "0xCALL4");
  seedEarlyAccessCall(db, CHAIN_ID, CONTRACT, "0xCALL5");
  seedEarlyAccessCall(db, CHAIN_ID, CONTRACT, "0xCALL6");
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
  seedEarlyAccessCall(db, CHAIN_ID, CONTRACT, "0xCALL1");
  seedEarlyAccessCall(db, CHAIN_ID, CONTRACT, "0xCALL2");
  seedEarlyAccessCall(db, CHAIN_ID, CONTRACT, "0xCALL3");
  seedEarlyAccessCall(db, CHAIN_ID, CONTRACT, "0xCALL4");
  seedEarlyAccessCall(db, CHAIN_ID, CONTRACT, "0xCALL5");
  seedEarlyAccessCall(db, CHAIN_ID, CONTRACT, "0xCALL6");
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
  seedEarlyAccessCall(db, CHAIN_ID, CONTRACT, "0xCALL1");
  seedEarlyAccessCall(db, CHAIN_ID, CONTRACT, "0xCALL2");
  seedEarlyAccessCall(db, CHAIN_ID, CONTRACT, "0xCALL3");
  seedEarlyAccessCall(db, CHAIN_ID, CONTRACT, "0xCALL4");
  seedEarlyAccessCall(db, CHAIN_ID, CONTRACT, "0xCALL5");
  seedEarlyAccessCall(db, CHAIN_ID, CONTRACT, "0xCALL6");
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
  seedEarlyAccessCall(db, CHAIN_ID, CONTRACT, "0xCALL1");
  seedEarlyAccessCall(db, CHAIN_ID, CONTRACT, "0xCALL2");
  seedEarlyAccessCall(db, CHAIN_ID, CONTRACT, "0xCALL3");
  seedEarlyAccessCall(db, CHAIN_ID, CONTRACT, "0xCALL4");
  seedEarlyAccessCall(db, CHAIN_ID, CONTRACT, "0xCALL5");
  seedEarlyAccessCall(db, CHAIN_ID, CONTRACT, "0xCALL6");
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

// 5b. Payer already holds on-chain access with no local row → already_owned, no charge, no grant.
{
  const { db, tmp } = newDb();
  seedEarlyAccessCall(db, CHAIN_ID, CONTRACT, "0xCALLA");
  const chain = fakeChain({ view: { ...openView, alreadyGranted: true } });
  let settleCalls = 0;
  const result = await purchaseEntitlementAccess(deps(chain, db), {
    onchainCallId: "0xCALLA",
    verifiedPayer: PAYER,
    settlement: {
      settle: async () => {
        settleCalls += 1;
        return settled;
      },
    },
  });
  assert.equal(result.kind, "already_owned", "on-chain access is not re-sold");
  assert.equal(settleCalls, 0, "no payment is settled for access already owned");
  assert.deepEqual(chain.grants, [], "no duplicate grant transaction is sent");
  db.close();
  rmSync(tmp, { recursive: true, force: true });
}

// 6. Grant reverts window-closed BUT the subscriber already holds on-chain
//    access (crash-restart double-broadcast) → granted, NOT refund_due.
{
  const { db, tmp } = newDb();
  seedEarlyAccessCall(db, CHAIN_ID, CONTRACT, "0xCALL1");
  seedEarlyAccessCall(db, CHAIN_ID, CONTRACT, "0xCALL2");
  seedEarlyAccessCall(db, CHAIN_ID, CONTRACT, "0xCALL3");
  seedEarlyAccessCall(db, CHAIN_ID, CONTRACT, "0xCALL4");
  seedEarlyAccessCall(db, CHAIN_ID, CONTRACT, "0xCALL5");
  seedEarlyAccessCall(db, CHAIN_ID, CONTRACT, "0xCALL6");
  const chain = fakeChain({
    view: openView,
    viewAfterGrant: { ...openView, alreadyGranted: true },
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

// ── Cohort cap is enforced BEFORE any charge ───────────────────────────────
{
  const { db, tmp } = newDb();
  seedEarlyAccessCall(db, CHAIN_ID, CONTRACT, "0xCALL1");
  seedEarlyAccessCall(db, CHAIN_ID, CONTRACT, "0xCALL2");
  seedEarlyAccessCall(db, CHAIN_ID, CONTRACT, "0xCALL3");
  seedEarlyAccessCall(db, CHAIN_ID, CONTRACT, "0xCALL4");
  seedEarlyAccessCall(db, CHAIN_ID, CONTRACT, "0xCALL5");
  seedEarlyAccessCall(db, CHAIN_ID, CONTRACT, "0xCALL6");
  const nowIso = "2026-07-20T00:00:00.000Z";
  const call = "0x" + "c0".repeat(32);
  seedEarlyAccessCall(db, CHAIN_ID, CONTRACT, call);
  const chain = {
    chainId: 84532,
    contractAddress: "0x1B74A4bAb1E06Ed107780a245c85337AB9dEcD1A",
    grantorAddress: "0xabc",
    async sendGrant() { return "0xhash"; },
    async getReceipt() { return null; },
    async readDecryptAccess() {
      return {
        state: 1,
        // Far enough ahead that the sale window is open.
        grantCloseAt: Math.floor(Date.parse("2027-01-01T00:00:00Z") / 1000),
        binaryIndexCtHash: "0x01",
        confidenceCtHash: "0x02",
        alreadyGranted: false,
      };
    },
    async getBalanceWei() { return 1n; },
  };

  const deps: EntitlementAccessDeps = {
    db,
    grantChain: chain as never,
    salesSafetySeconds: 180,
    maxArmedPerCall: 2,
    now: () => new Date(nowIso),
  };

  // Two subscribers fill the cohort.
  for (const sub of ["0x" + "a1".repeat(20), "0x" + "a2".repeat(20)]) {
    entitlementsRepo.reserve(db, {
      chainId: chain.chainId,
      contractAddress: chain.contractAddress,
      onchainCallId: call,
      subscriberAddress: sub,
      callId: null,
      producerAgentId: null,
      amount: null,
      currency: null,
      now: nowIso,
    });
  }

  const full = await checkEntitlementEligibility(deps, call);
  assert.equal(full.reason, "cohort_full", "a full cohort refuses the sale");

  // Below the cap it stays open.
  const roomy = await checkEntitlementEligibility(
    { ...deps, maxArmedPerCall: 5 },
    call,
  );
  assert.equal(roomy.reason, "ok", "under the cap the sale is still open");

  db.close();
  rmSync(tmp, { recursive: true, force: true });
}
