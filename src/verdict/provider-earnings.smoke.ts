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
  reconcileEntitlement,
  type EntitlementAccessDeps,
  type SettleOutcome,
} from "./entitlement-access.js";
import { listRefundDueResponse } from "./entitlement-refunds-surface.js";
import {
  accrueIfEligible,
  grantAndAccrue,
  sweepUnaccruedGrants,
  type ProviderEarningsDeps,
} from "./provider-earnings.js";
import { readProviderEarnings } from "./provider-earnings-surface.js";
import { setProviderTerms } from "./provider-terms-surface.js";
import {
  parseProtocolFeeBps,
  ProtocolFeeConfigError,
  requireProtocolFeeBps,
  splitFeeAtoms,
} from "./protocol-fee.js";
import { agentMarketRegistrationsRepo } from "./repos/agent-market-registrations-repo.js";
import { entitlementsRepo } from "./repos/entitlements-repo.js";
import { providerEarningsRepo } from "./repos/provider-earnings-repo.js";
import { venueMarketSeriesRepo } from "./repos/venue-market-series-repo.js";
import { SCHEMA_VERSION } from "./schema.js";

// ─── The provider revenue split ────────────────────────────────────────────
//
// Invariant: a paid, granted entitlement has exactly one provider_earnings row (never two, never zero).
process.stdout.write("murmur provider earnings smoke\n");

const CHAIN_ID = 84532;
const CONTRACT = "0x1B74A4bAb1E06Ed107780a245c85337AB9dEcD1A";
const PAYER = "0xCAFEbabeCAFEbabeCAFEbabeCAFEbabeCAFEbabe";
const NOW = new Date("2026-08-10T00:00:00.000Z");
const NOW_SEC = Math.floor(NOW.getTime() / 1000);
const NOW_ISO = NOW.toISOString();

const openView: GrantDecryptAccessView = {
  state: 1,
  grantCloseAt: NOW_SEC + 3600,
  binaryIndexCtHash: "0x01",
  confidenceCtHash: "0x02",
  alreadyGranted: false,
};

type Db = ReturnType<typeof openDb>;

interface Harness {
  db: Db;
  tmp: string;
  agentId: string;
  accountId: string;
  slug: string;
  warnings: string[];
}

function newHarness(): Harness {
  const tmp = mkdtempSync(join(tmpdir(), "provider-earnings-"));
  const db = openDb({ path: join(tmp, `${randomUUID()}.db`) });
  const agentId = randomUUID();
  const accountId = randomUUID();
  const slug = `earner-${agentId.slice(0, 8)}`;
  db.prepare(
    `INSERT INTO agents (agent_id, display_slug, kind, display_name, bio, created_at)
     VALUES (?, ?, 'agent', 'Earning Agent', NULL, ?)`,
  ).run(agentId, slug, NOW_ISO);
  db.prepare(
    `INSERT INTO accounts (account_id, privy_user_id, created_at, last_seen_at)
     VALUES (?, ?, ?, ?)`,
  ).run(accountId, `privy-${accountId}`, NOW_ISO, NOW_ISO);
  db.prepare(
    `INSERT INTO account_agents (account_id, agent_id, created_at) VALUES (?, ?, ?)`,
  ).run(accountId, agentId, NOW_ISO);
  return { db, tmp, agentId, accountId, slug, warnings: [] };
}

function close(h: Harness): void {
  h.db.close();
  rmSync(h.tmp, { recursive: true, force: true });
}

/** A sellable sealed call owned by the harness agent; `feeBps` null models a call with no fee snapshot. */
function seedCall(
  h: Harness,
  onchainCallId: string,
  feeBps: number | null,
  opts: { agentId?: string } = {},
): string {
  const callId = randomUUID();
  h.db
    .prepare(
      `INSERT INTO submissions
         (call_id, agent_id, client_order_id, submitted_at, accepted_at,
          schema_version, scoring_version, dedup_key, status, horizon_seconds)
       VALUES (?, ?, ?, ?, ?, 1, 1, ?, 'pending_t1', 3600)`,
    )
    .run(
      callId,
      opts.agentId ?? h.agentId,
      `order-${callId}`,
      NOW_ISO,
      NOW_ISO,
      `dedup-${callId}`,
    );
  h.db
    .prepare(
      `INSERT INTO fhenix_sealed_calls
         (call_id, chain_id, contract_address, onchain_call_id, submit_tx_hash,
          submit_log_index, binary_index_ct_hash, confidence_ct_hash,
          reveal_open_at, submission_class, created_at,
          provider_price_atoms, provider_currency, provider_pricing_version,
          provider_max_subscribers, provider_terms_snapshotted, provider_fee_bps)
       VALUES (?, ?, ?, ?, ?, 0, '0x01', '0x02', ?, 1, ?,
               '1000000', 'USDC', 'v1', NULL, 1, ?)`,
    )
    .run(
      callId,
      CHAIN_ID,
      CONTRACT.toLowerCase(),
      onchainCallId.toLowerCase(),
      `0x${callId.replace(/-/g, "").padEnd(64, "0").slice(0, 64)}`,
      "2027-01-01T00:00:00.000Z",
      NOW_ISO,
      feeBps,
    );
  return callId;
}

interface FakeChainOpts {
  view?: GrantDecryptAccessView | null;
  viewAfterGrant?: GrantDecryptAccessView | null;
  sendGrant?: () => Promise<string>;
  receipt?: GrantChainReceipt | null;
}

function fakeChain(opts: FakeChainOpts = {}): GrantChainAdapter {
  const grants: string[] = [];
  return {
    chainId: CHAIN_ID,
    contractAddress: CONTRACT,
    grantorAddress: "0xgrantor",
    async sendGrant(callId, subscriber) {
      grants.push(`${callId}:${subscriber}`);
      if (opts.sendGrant) return opts.sendGrant();
      return "0xGRANTTX";
    },
    async getReceipt() {
      return opts.receipt ?? null;
    },
    async readDecryptAccess() {
      if (opts.viewAfterGrant && grants.length > 0) return opts.viewAfterGrant;
      return opts.view === undefined ? openView : opts.view;
    },
    async getBalanceWei() {
      return 1n;
    },
    async hasGrantorRole() {
      return true;
    },
  };
}

function accessDeps(
  h: Harness,
  chain: GrantChainAdapter,
  protocolFeeBps = 1_000,
): EntitlementAccessDeps {
  return {
    db: h.db,
    grantChain: chain,
    salesSafetySeconds: 180,
    protocolFeeBps,
    now: () => NOW,
    logger: { warn: (...args: unknown[]) => h.warnings.push(args.join(" ")) },
    resolveProducerAgentId: () => h.agentId,
  };
}

function earningsDeps(h: Harness, protocolFeeBps = 1_000): ProviderEarningsDeps {
  return {
    db: h.db,
    protocolFeeBps,
    now: () => NOW,
    logger: { warn: (...args: unknown[]) => h.warnings.push(args.join(" ")) },
  };
}

function settledFor(amount: string, currency = "USDC"): SettleOutcome {
  return {
    kind: "settled",
    transaction: `circle-${randomUUID()}`,
    payer: PAYER,
    amount,
    currency,
  };
}

/** Buy a call end-to-end through the real orchestrator. */
async function buy(
  h: Harness,
  onchainCallId: string,
  amount: string,
  opts: { currency?: string; protocolFeeBps?: number; payer?: string } = {},
): Promise<number> {
  const chain = fakeChain({
    receipt: { blockNumber: 100, success: true, confirmations: 3 },
  });
  const result = await purchaseEntitlementAccess(
    accessDeps(h, chain, opts.protocolFeeBps ?? 1_000),
    {
      onchainCallId,
      verifiedPayer: opts.payer ?? PAYER,
      settlement: { settle: async () => settledFor(amount, opts.currency) },
    },
  );
  assert.equal(result.kind, "granted", `purchase of ${onchainCallId} should grant`);
  assert.equal(result.kind === "granted" && result.row.status, "granted");
  return result.kind === "granted" ? result.row.id : -1;
}

// ── 1. A sale accrues once, with the split frozen at the SALE ──────────────
{
  const h = newHarness();
  seedCall(h, "0xCALL1", 1_000);
  const id = await buy(h, "0xCALL1", "1000000");

  const row = entitlementsRepo.byId(h.db, id)!;
  assert.equal(row.fee_bps_at_sale, 1_000, "the reservation stamped the call's split");
  assert.equal(row.producer_agent_id, h.agentId, "and who produced it");

  const earning = providerEarningsRepo.byEntitlement(h.db, id);
  assert.ok(earning, "a paid, granted sale accrues");
  assert.equal(earning.producer_agent_id, h.agentId);
  assert.equal(earning.gross_atoms, "1000000");
  assert.equal(earning.fee_atoms, "100000", "murmur keeps 10%");
  assert.equal(earning.net_atoms, "900000", "the provider gets the rest");
  assert.equal(earning.fee_bps, 1_000);
  assert.equal(earning.currency, "USDC");
  assert.equal(earning.accrual_source, "sale_snapshot");
  assert.equal(earning.chain_id, CHAIN_ID);
  assert.equal(earning.onchain_call_id, "0xcall1");
  assert.equal(
    BigInt(earning.fee_atoms) + BigInt(earning.net_atoms),
    BigInt(earning.gross_atoms),
    "gross = fee + net, always",
  );

  // A later protocol fee change can't re-cut a sale already made.
  accrueIfEligible(earningsDeps(h, 5_000), id);
  assert.equal(providerEarningsRepo.byEntitlement(h.db, id)!.fee_bps, 1_000);
  assert.equal(countEarnings(h), 1, "still exactly one row");
  close(h);
}

// ── 2. Idempotent at every site that can grant ─────────────────────────────
{
  // (a) the receipt path, fired twice.
  const h = newHarness();
  seedCall(h, "0xCALL2A", 1_000);
  const id = await buy(h, "0xCALL2A", "1000000");
  grantAndAccrue(earningsDeps(h), id, ["granted"], {
    status: "granted",
    grantedAt: NOW_ISO,
    now: NOW_ISO,
  });
  accrueIfEligible(earningsDeps(h), id);
  assert.equal(countEarnings(h), 1, "double-firing the granted CAS accrues once");

  // (b) the "grace elapsed, the chain says they already hold it" path.
  seedCall(h, "0xCALL2B", 2_500);
  const broadcastId = entitlementsRepo.reserve(h.db, {
    chainId: CHAIN_ID,
    contractAddress: CONTRACT,
    onchainCallId: "0xCALL2B",
    subscriberAddress: PAYER,
    callId: null,
    producerAgentId: h.agentId,
    amount: null,
    currency: null,
    feeBpsAtSale: 2_500,
    now: NOW_ISO,
  });
  entitlementsRepo.transition(h.db, broadcastId, ["payment_settling"], {
    status: "grant_broadcast",
    nanopayReceiptId: "circle-b",
    amount: "400",
    currency: "USDC",
    grantTxHash: "0xUNMINED",
    // Grace already elapsed, so the reconciler consults the chain.
    nextAttemptAt: "2026-08-09T00:00:00.000Z",
    now: NOW_ISO,
  });
  const grantedChain = fakeChain({
    view: { ...openView, alreadyGranted: true },
    receipt: null,
  });
  for (let i = 0; i < 2; i += 1) {
    const row = entitlementsRepo.byId(h.db, broadcastId)!;
    await reconcileEntitlement(accessDeps(h, grantedChain), row);
  }
  assert.equal(entitlementsRepo.byId(h.db, broadcastId)!.status, "granted");
  const b = providerEarningsRepo.byEntitlement(h.db, broadcastId)!;
  assert.equal(b.fee_bps, 2_500, "that site accrues at the SALE's split too");
  assert.equal(b.fee_atoms, "100");
  assert.equal(b.net_atoms, "300");

  // (c) finalizeGrantFailure: the broadcast reverts, but the subscriber already
  // holds access from an earlier attempt. Granted, and it accrues.
  seedCall(h, "0xCALL2C", 1_000);
  const revertId = entitlementsRepo.reserve(h.db, {
    chainId: CHAIN_ID,
    contractAddress: CONTRACT,
    onchainCallId: "0xCALL2C",
    subscriberAddress: PAYER,
    callId: null,
    producerAgentId: h.agentId,
    amount: null,
    currency: null,
    feeBpsAtSale: 1_000,
    now: NOW_ISO,
  });
  entitlementsRepo.transition(h.db, revertId, ["payment_settling"], {
    status: "grant_queued",
    nanopayReceiptId: "circle-c",
    amount: "999",
    currency: "USDC",
    now: NOW_ISO,
  });
  const revertChain = fakeChain({
    view: { ...openView, alreadyGranted: true },
    sendGrant: async () => {
      throw new Error("execution reverted: DecryptGrantWindowClosed");
    },
  });
  await reconcileEntitlement(
    accessDeps(h, revertChain),
    entitlementsRepo.byId(h.db, revertId)!,
  );
  assert.equal(entitlementsRepo.byId(h.db, revertId)!.status, "granted");
  const c = providerEarningsRepo.byEntitlement(h.db, revertId)!;
  assert.equal(c.gross_atoms, "999");
  assert.equal(c.fee_atoms, "99", "10% of 999 floors to 99");
  assert.equal(c.net_atoms, "900", "and the provider takes the remainder");
  assert.equal(countEarnings(h), 3);
  close(h);
}

// ── 3. Money owed BACK never books as revenue ──────────────────────────────
{
  const h = newHarness();
  for (const [call, status, refund] of [
    ["0xREFUND1", "grant_failed_refund_due", "refund_due"],
    ["0xREFUND2", "refunded", "refunded"],
  ] as const) {
    seedCall(h, call, 1_000);
    const id = entitlementsRepo.reserve(h.db, {
      chainId: CHAIN_ID,
      contractAddress: CONTRACT,
      onchainCallId: call,
      subscriberAddress: PAYER,
      callId: null,
      producerAgentId: h.agentId,
      amount: null,
      currency: null,
      feeBpsAtSale: 1_000,
      now: NOW_ISO,
    });
    entitlementsRepo.transition(h.db, id, ["payment_settling"], {
      status,
      refundStatus: refund,
      nanopayReceiptId: `circle-${call}`,
      amount: "500000",
      currency: "USDC",
      now: NOW_ISO,
    });
    const outcome = accrueIfEligible(earningsDeps(h), id);
    assert.equal(outcome.kind, "not_eligible", `${status} must not accrue`);
  }
  assert.equal(countEarnings(h), 0, "a refund is not revenue");
  assert.equal(
    sweepUnaccruedGrants(earningsDeps(h)).accrued,
    0,
    "and the sweep does not pick them up either",
  );

  // The admin refund queue shows them, with the hazard stated in the payload.
  const refunds = listRefundDueResponse(h.db) as {
    status: number;
    body: {
      schema_version: number;
      refunds: Array<{ entitlement_id: number; nanopay_receipt_id: string | null }>;
      warning: { code: string; message: string };
    };
  };
  assert.equal(refunds.status, 200);
  assert.equal(refunds.body.schema_version, SCHEMA_VERSION);
  assert.equal(refunds.body.refunds.length, 1, "only the refund_due row is queued");
  assert.ok(refunds.body.refunds[0]!.nanopay_receipt_id);
  assert.match(refunds.body.warning.message, /re-read each entitlement/i);
  assert.match(refunds.body.warning.message, /non-null nanopay_receipt_id/i);
  assert.match(refunds.body.warning.message, /can appear here and then legitimately vanish/i);
  close(h);
}

// ── 4. An adopted on-chain grant is not a sale ─────────────────────────────
{
  const h = newHarness();
  seedCall(h, "0xADOPT", 1_000);
  const adopted = entitlementsRepo.adoptOnchainGrant(h.db, {
    chainId: CHAIN_ID,
    contractAddress: CONTRACT,
    onchainCallId: "0xADOPT",
    subscriberAddress: PAYER,
    producerAgentId: h.agentId,
    now: NOW_ISO,
  })!;
  assert.equal(adopted.status, "granted");
  assert.equal(adopted.nanopay_receipt_id, null, "nobody paid for it");
  const outcome = accrueIfEligible(earningsDeps(h), adopted.id);
  assert.equal(outcome.kind, "not_eligible");
  assert.equal(countEarnings(h), 0, "granting access murmur was not paid for earns nothing");
  assert.equal(sweepUnaccruedGrants(earningsDeps(h)).scanned, 0, "and it never enters the sweep");
  close(h);
}

// ── 5. The crash gap: granted, paid, and never accrued ─────────────────────
{
  const h = newHarness();
  seedCall(h, "0xCRASH", 1_000);
  const id = entitlementsRepo.reserve(h.db, {
    chainId: CHAIN_ID,
    contractAddress: CONTRACT,
    onchainCallId: "0xCRASH",
    subscriberAddress: PAYER,
    callId: null,
    producerAgentId: h.agentId,
    amount: null,
    currency: null,
    feeBpsAtSale: 1_000,
    now: NOW_ISO,
  });
  // The granted CAS alone, with no accrual.
  entitlementsRepo.transition(h.db, id, ["payment_settling"], {
    status: "granted",
    nanopayReceiptId: "circle-crash",
    amount: "1234567",
    currency: "USDC",
    grantedAt: NOW_ISO,
    now: NOW_ISO,
  });
  assert.equal(providerEarningsRepo.byEntitlement(h.db, id), null, "the gap exists");
  assert.equal(
    entitlementsRepo.listDue(h.db, { now: NOW_ISO, limit: 10 }).length,
    0,
    "and nothing in the ordinary due queue would ever revisit it — `granted` is terminal",
  );

  const sweep = sweepUnaccruedGrants(earningsDeps(h));
  assert.equal(sweep.scanned, 1);
  assert.equal(sweep.accrued, 1, "the audit sweep repairs it");
  const repaired = providerEarningsRepo.byEntitlement(h.db, id)!;
  assert.equal(repaired.gross_atoms, "1234567");
  assert.equal(repaired.fee_atoms, "123456", "10% of 1234567 floors");
  assert.equal(repaired.net_atoms, "1111111");
  assert.equal(repaired.accrual_source, "sale_snapshot", "the sale's own split, not today's");
  assert.ok(
    h.warnings.some((w) => /REPAIRED/.test(w)),
    "a silent self-heal would hide the writer that dropped it",
  );
  assert.equal(sweepUnaccruedGrants(earningsDeps(h)).scanned, 0, "and the gap is gone");
  close(h);
}

// ── 6. Legacy rows: no sale-time split, so today's fee, and SAID so ────────
{
  const h = newHarness();
  seedCall(h, "0xLEGACY", null);
  const id = entitlementsRepo.reserve(h.db, {
    chainId: CHAIN_ID,
    contractAddress: CONTRACT,
    onchainCallId: "0xLEGACY",
    subscriberAddress: PAYER,
    callId: null,
    producerAgentId: h.agentId,
    amount: null,
    currency: null,
    // No feeBpsAtSale: a legacy row.
    now: NOW_ISO,
  });
  assert.equal(entitlementsRepo.byId(h.db, id)!.fee_bps_at_sale, null);
  entitlementsRepo.transition(h.db, id, ["payment_settling"], {
    status: "granted",
    nanopayReceiptId: "circle-legacy",
    amount: "1000",
    currency: "USDC",
    grantedAt: NOW_ISO,
    now: NOW_ISO,
  });
  accrueIfEligible(earningsDeps(h, 300), id);
  const legacy = providerEarningsRepo.byEntitlement(h.db, id)!;
  assert.equal(legacy.fee_bps, 300, "falls back to the fee as it stands now");
  assert.equal(legacy.fee_atoms, "30");
  assert.equal(legacy.net_atoms, "970");
  assert.equal(
    legacy.accrual_source,
    "legacy_fallback",
    "and labels itself, so nobody reads it as terms the sale actually froze",
  );

  // A NEW sale of that same legacy call stamps the current fee at RESERVATION,
  // which is a sale-time decision — so it is a snapshot, not a fallback.
  const fresh = await buy(h, "0xLEGACY", "1000", {
    protocolFeeBps: 300,
    payer: "0xDeaDBeefdeadBEEFdeadbEEFdeadbeEFdeadBEEF",
  });
  const freshRow = providerEarningsRepo.byEntitlement(h.db, fresh)!;
  assert.equal(freshRow.fee_bps, 300);
  assert.equal(freshRow.accrual_source, "sale_snapshot");
  close(h);
}

// ── 7. Fee arithmetic, at the edges ────────────────────────────────────────
{
  const h = newHarness();
  const cases: Array<[string, number, string, string, string]> = [
    // call,        bps,    gross,   fee,     net
    ["0xEDGE0", 0, "1000000", "0", "1000000"],
    ["0xEDGEFULL", 10_000, "1000000", "1000000", "0"],
    ["0xEDGE1", 1_000, "1", "0", "1"],
    ["0xEDGE9999", 9_999, "1", "0", "1"],
  ];
  for (const [call, bps, gross, fee, net] of cases) {
    seedCall(h, call, bps);
    const id = await buy(h, call, gross);
    const row = providerEarningsRepo.byEntitlement(h.db, id)!;
    assert.equal(row.fee_bps, bps, `${call}: bps`);
    assert.equal(row.gross_atoms, gross, `${call}: gross`);
    assert.equal(row.fee_atoms, fee, `${call}: fee`);
    assert.equal(row.net_atoms, net, `${call}: net`);
    assert.equal(
      BigInt(row.fee_atoms) + BigInt(row.net_atoms),
      BigInt(row.gross_atoms),
      `${call}: gross = fee + net`,
    );
  }

  // The floor is the provider's, not murmur's: a sub-atom fee rounds DOWN, so
  // value is never invented to make the split look tidy.
  assert.deepEqual(splitFeeAtoms("1", 1_000), { gross: 1n, fee: 0n, net: 1n });
  assert.deepEqual(splitFeeAtoms("0", 10_000), { gross: 0n, fee: 0n, net: 0n });
  // Beyond 2^53: the reason none of this is done in floats or in SQLite.
  const huge = "90071992547409910000";
  const split = splitFeeAtoms(huge, 1_000);
  assert.equal(split.fee.toString(), "9007199254740991000");
  assert.equal(split.net.toString(), "81064793292668919000");
  assert.equal((split.fee + split.net).toString(), huge);
  assert.throws(() => splitFeeAtoms("-5", 1_000), /non-negative integer/);
  assert.throws(() => splitFeeAtoms("1.5", 1_000), /non-negative integer/);
  assert.throws(() => splitFeeAtoms("100", 10_001), /0\.\.10000/);
  close(h);
}

// ── 8. Currency is normalized, and totals are summed in BigInt ─────────────
{
  const h = newHarness();
  seedCall(h, "0xCASE1", 1_000);
  const lower = await buy(h, "0xCASE1", "1000", { currency: "usdc" });
  assert.equal(
    entitlementsRepo.byId(h.db, lower)!.currency,
    "usdc",
    "the rail reported it lowercase",
  );
  assert.equal(
    providerEarningsRepo.byEntitlement(h.db, lower)!.currency,
    "USDC",
    "the ledger normalizes, so totals cannot split into two buckets",
  );

  // Two more sales, large enough that a float sum would drift.
  seedCall(h, "0xBIG1", 1_000);
  seedCall(h, "0xBIG2", 1_000);
  await buy(h, "0xBIG1", "9007199254740993000");
  await buy(h, "0xBIG2", "9007199254740993000");

  const totals = providerEarningsRepo.totalsForAgent(h.db, h.agentId);
  assert.equal(totals.length, 1, "one currency, not two");
  const usdc = totals[0]!;
  assert.equal(usdc.currency, "USDC");
  assert.equal(usdc.sales, 3);
  assert.equal(usdc.gross_atoms, "18014398509481987000");
  assert.equal(usdc.fee_atoms, "1801439850948198700");
  assert.equal(usdc.net_atoms, "16212958658533788300");
  assert.equal(
    BigInt(usdc.fee_atoms) + BigInt(usdc.net_atoms),
    BigInt(usdc.gross_atoms),
    "the invariant survives summation",
  );

  // ── the owner's read surface ────────────────────────────────────────────
  const view = readProviderEarnings({
    db: h.db,
    accountId: h.accountId,
    slug: h.slug,
  }) as {
    status: number;
    body: {
      schema_version: number;
      sales: Array<{ entitlement_id: number; net_atoms: string; accrual_source: string }>;
      totals: Array<{
        currency: string;
        lifetime_accrued_gross: string;
        lifetime_accrued_fee: string;
        lifetime_accrued_net: string;
      }>;
      payouts: { automated: boolean };
    };
  };
  assert.equal(view.status, 200);
  assert.equal(view.body.schema_version, SCHEMA_VERSION, "schema_version, like its siblings");
  assert.equal(view.body.sales.length, 3);
  assert.equal(view.body.totals[0]!.currency, "USDC");
  assert.equal(view.body.totals[0]!.lifetime_accrued_net, "16212958658533788300");
  assert.equal(
    view.body.totals[0]!.lifetime_accrued_gross,
    "18014398509481987000",
  );
  assert.equal(
    view.body.payouts.automated,
    false,
    "nothing here has been paid, and the payload says so",
  );
  // No payouts yet: the whole accrual is owed, and overpaid_atoms is "0", not absent.
  {
    const usdcTotal = view.body.totals[0] as unknown as {
      owed_atoms: string;
      overpaid_atoms: string;
      balance_atoms: string;
      lifetime_paid_net: string;
    };
    assert.equal(usdcTotal.lifetime_paid_net, "0");
    assert.equal(usdcTotal.balance_atoms, "16212958658533788300");
    assert.equal(usdcTotal.owed_atoms, "16212958658533788300");
    assert.equal(usdcTotal.overpaid_atoms, "0");
  }

  // Another account cannot read it.
  assert.throws(
    () => readProviderEarnings({ db: h.db, accountId: randomUUID(), slug: h.slug }),
    /not owned by this account/i,
  );
  close(h);
}

// ── 9. A sale nobody can be paid for is loud, not silent ───────────────────
{
  const h = newHarness();
  const orphan = randomUUID();
  // A submission whose agent does not exist. FKs off for the seed only: the
  // point is to reach accrual with attribution that cannot be honoured.
  h.db.pragma("foreign_keys = OFF");
  seedCall(h, "0xORPHAN", 1_000, { agentId: orphan });
  h.db.pragma("foreign_keys = ON");
  const id = entitlementsRepo.reserve(h.db, {
    chainId: CHAIN_ID,
    contractAddress: CONTRACT,
    onchainCallId: "0xORPHAN",
    subscriberAddress: PAYER,
    callId: null,
    producerAgentId: orphan,
    amount: null,
    currency: null,
    feeBpsAtSale: 1_000,
    now: NOW_ISO,
  });
  entitlementsRepo.transition(h.db, id, ["payment_settling"], {
    status: "granted",
    nanopayReceiptId: "circle-orphan",
    amount: "1000",
    currency: "USDC",
    grantedAt: NOW_ISO,
    now: NOW_ISO,
  });
  const outcome = accrueIfEligible(earningsDeps(h), id);
  assert.equal(outcome.kind, "unattributed");
  assert.equal(countEarnings(h), 0, "never a row naming an owner who does not exist");
  assert.ok(
    h.warnings.some((w) => /UNATTRIBUTED SALE/.test(w)),
    "the operator has to be told",
  );
  const sweep = sweepUnaccruedGrants(earningsDeps(h));
  assert.equal(sweep.unattributed, 1, "and it stays visible in the sweep, tick after tick");
  close(h);
}

// ── 10. Attribution survives a NULL producer column ────────────────────────
{
  const h = newHarness();
  seedCall(h, "0xNOPRODUCER", 1_000);
  const id = entitlementsRepo.reserve(h.db, {
    chainId: CHAIN_ID,
    contractAddress: CONTRACT,
    onchainCallId: "0xNOPRODUCER",
    subscriberAddress: PAYER,
    callId: null,
    // NULL producer column; accrual must re-derive it.
    producerAgentId: null,
    amount: null,
    currency: null,
    feeBpsAtSale: 1_000,
    now: NOW_ISO,
  });
  entitlementsRepo.transition(h.db, id, ["payment_settling"], {
    status: "granted",
    nanopayReceiptId: "circle-noproducer",
    amount: "1000",
    currency: "USDC",
    grantedAt: NOW_ISO,
    now: NOW_ISO,
  });
  accrueIfEligible(earningsDeps(h), id);
  assert.equal(
    providerEarningsRepo.byEntitlement(h.db, id)!.producer_agent_id,
    h.agentId,
    "re-derived from the sealed call's submission",
  );
  close(h);
}

// ── 11. The fee itself: parsed strictly, never defaulted ───────────────────
{
  assert.equal(parseProtocolFeeBps({}), null, "unset is not zero");
  assert.equal(parseProtocolFeeBps({ MURMUR_PROTOCOL_FEE_BPS: "  " }), null);
  assert.equal(parseProtocolFeeBps({ MURMUR_PROTOCOL_FEE_BPS: "0" }), 0);
  assert.equal(parseProtocolFeeBps({ MURMUR_PROTOCOL_FEE_BPS: "10000" }), 10_000);
  assert.equal(parseProtocolFeeBps({ MURMUR_PROTOCOL_FEE_BPS: " 1000 " }), 1_000);
  for (const bad of ["10001", "-1", "1.5", "1e3", "0x64", "ten"]) {
    assert.throws(
      () => parseProtocolFeeBps({ MURMUR_PROTOCOL_FEE_BPS: bad }),
      (err: unknown) => err instanceof ProtocolFeeConfigError,
      `"${bad}" must not parse as a fee`,
    );
  }
  assert.throws(
    () => requireProtocolFeeBps({}),
    (err: unknown) =>
      err instanceof ProtocolFeeConfigError &&
      /MURMUR_PROTOCOL_FEE_BPS/.test(err.message) &&
      /no.*default/i.test(err.message),
    "and an absent fee names itself in the failure",
  );
}

// ── 12. Pricing a signal is refused while the split cannot be recorded ─────
{
  const h = newHarness();
  // Terms are per-series: register the agent for a series before pricing it.
  const series = venueMarketSeriesRepo.upsert(h.db, {
    venue: "polymarket",
    series_slug: "eth-up-or-down-5m",
    series_title: "ETH Up or Down 5m",
    venue_category: null,
    source_adapter_id: "polymarket-gamma",
    now: NOW_ISO,
  });
  agentMarketRegistrationsRepo.register(h.db, {
    agentId: h.agentId,
    venueSeriesId: series.venue_series_id,
    now: NOW_ISO,
  });
  const body = {
    price_atoms: "1000000",
    currency: "USDC",
    pricing_version: "v1",
    max_subscribers_per_call: 25,
  };
  const blocked = setProviderTerms({
    db: h.db,
    accountId: h.accountId,
    slug: h.slug,
    venueSeriesId: series.venue_series_id,
    deliverableCap: 25,
    protocolFeeBps: null,
    now: () => NOW,
    body,
  }) as { status: number; body: { code: string; message: string } };
  assert.equal(blocked.status, 503, "an owner learns at PRICING time, not at sale time");
  assert.equal(blocked.body.code, "protocol_fee_unconfigured");
  assert.match(blocked.body.message, /MURMUR_PROTOCOL_FEE_BPS/);

  const allowed = setProviderTerms({
    db: h.db,
    accountId: h.accountId,
    slug: h.slug,
    venueSeriesId: series.venue_series_id,
    deliverableCap: 25,
    protocolFeeBps: 1_000,
    now: () => NOW,
    body,
  }) as { status: number; body: { selling: boolean } };
  assert.equal(allowed.status, 200);
  assert.equal(allowed.body.selling, true);
  close(h);
}

function countEarnings(h: Harness): number {
  return (h.db.prepare("SELECT count(*) c FROM provider_earnings").get() as { c: number }).c;
}

process.stdout.write("OK provider earnings smoke\n");
