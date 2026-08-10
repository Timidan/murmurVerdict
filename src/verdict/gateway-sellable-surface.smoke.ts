// ─── Public sellable-calls listing smoke ────────────────────────────────────
//
// Pins the storefront's inclusion rules, because every one of them is a way to
// mis-sell:
//
//   · a call whose owner stopped selling must not be listed at any price
//   · a call whose sale window has closed must not be listed
//   · another deployment's rows must never appear
//   · a sold-out call IS listed, with its seats, so the UI can say "full"
//   · a legacy (pre-070) call is priced from the deployment terms when this
//     daemon has them, and EXCLUDED with a response note when it does not
//   · purchase_available tracks whether the checkout is mounted here

import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDb } from "./db.js";
import { entitlementsRepo } from "./repos/entitlements-repo.js";
import {
  listSellableCallsResponse,
  type SellableCallRow,
} from "./gateway-sellable-surface.js";
import type { CallTerms } from "./call-sale-terms.js";

process.stdout.write("murmur gateway sellable surface smoke\n");

const CHAIN_ID = 84532;
const CONTRACT = "0x1B74A4bAb1E06Ed107780a245c85337AB9dEcD1A";
const OTHER_CONTRACT = "0x00000000000000000000000000000000000000ff";
const NOW = new Date("2026-08-10T12:00:00.000Z");
const NOW_MS = NOW.getTime();
const SAFETY_SEC = 180;
const LEGACY_TERMS: CallTerms = {
  priceAtoms: "1000",
  currency: "USDC",
  pricingVersion: "v1",
};

interface SeedCall {
  key: string;
  /** Absolute submission close; the sale closes SAFETY_SEC before it. */
  submissionCloseAtMs: number;
  contract?: string;
  submissionClass?: number;
  revealStatus?: "pending" | "revealed";
  price?: { atoms: string; currency: string; version: string } | null;
  termsSnapshotted?: 0 | 1;
  providerMaxSubscribers?: number | null;
  seriesCap?: number;
  question?: string | null;
  reservations?: number;
}

function onchainCallId(index: number): string {
  return `0x${index.toString(16).padStart(64, "0")}`;
}

function seed(db: ReturnType<typeof openDb>, calls: SeedCall[]): void {
  // FK relaxation for the seed only: building assets → oracles → markets in
  // full would be scaffolding for columns this listing never reads.
  db.pragma("foreign_keys = OFF");
  const iso = NOW.toISOString();
  db.prepare(
    `INSERT INTO agents (agent_id, display_slug, kind, display_name, created_at)
     VALUES ('agent-1', 'oracle-one', 'agent', 'Oracle One', @now)`,
  ).run({ now: iso });

  calls.forEach((call, index) => {
    const marketId = `market-${call.key}`;
    const seriesId = `series-${call.key}`;
    const callId = `call-${call.key}`;
    const close = call.submissionCloseAtMs;
    db.prepare(
      `INSERT INTO markets (market_id, asset_id, horizon_seconds, primary_oracle_id,
         primary_max_staleness_sec, t0_grace_seconds, t0_extended_grace_seconds,
         void_band, created_at)
       VALUES (@market_id, 'asset-1', 300, 'oracle-1', 60, 30, 60, '0', @now)`,
    ).run({ market_id: marketId, now: iso });
    db.prepare(
      `INSERT INTO market_series (series_id, venue, display_name, window_seconds,
         submission_open_lead_sec, commit_margin_sec, delivery_budget_sec,
         embargo_sec, max_armed_per_call, created_at, updated_at)
       VALUES (@series_id, 'polymarket', 'Up/Down 5m', 300,
         600, 60, 120, 300, @cap, @now, @now)`,
    ).run({ series_id: seriesId, cap: call.seriesCap ?? 25, now: iso });
    db.prepare(
      `INSERT INTO market_clocks (market_id, series_id, arm_close_at_ms,
         submission_open_at_ms, early_access_cutoff_at_ms, submission_close_at_ms,
         resolution_at_ms, public_reveal_at_ms, derived_from_end_date_ms, created_at)
       VALUES (@market_id, @series_id, @arm, @open, @cutoff, @close, @resolution,
         @reveal, @derived, @now)`,
    ).run({
      market_id: marketId,
      series_id: seriesId,
      arm: close - 500_000,
      open: close - 400_000,
      cutoff: close - 300_000,
      close,
      resolution: close + 300_000,
      reveal: close + 600_000,
      derived: close + 300_000,
      now: iso,
    });
    if (call.question !== undefined && call.question !== null) {
      db.prepare(
        `INSERT INTO polymarket_discovery_state (condition_id, question, end_date_epoch_s,
           status, created_at, updated_at)
         VALUES (@market_id, @question, @end_s, 'listed', @now, @now)`,
      ).run({
        market_id: marketId,
        question: call.question,
        end_s: Math.floor(close / 1000),
        now: iso,
      });
    }
    db.prepare(
      `INSERT INTO submissions (call_id, agent_id, client_order_id, horizon_seconds,
         submitted_at, accepted_at, status, schema_version, scoring_version,
         dedup_key, market_id)
       VALUES (@call_id, 'agent-1', @call_id, 300, @now, @now, 'accepted', 1, 1,
         @call_id, @market_id)`,
    ).run({ call_id: callId, market_id: marketId, now: iso });
    db.prepare(
      `INSERT INTO fhenix_sealed_calls (call_id, chain_id, contract_address,
         onchain_call_id, submit_tx_hash, submit_log_index, binary_index_ct_hash,
         confidence_ct_hash, reveal_open_at, created_at, submission_class,
         reveal_status, provider_price_atoms, provider_currency,
         provider_pricing_version, provider_max_subscribers,
         provider_terms_snapshotted)
       VALUES (@call_id, @chain_id, @contract, @onchain_call_id, @tx, 0,
         '0x01', '0x02', @reveal_open_at, @now, @class, @reveal_status,
         @price, @currency, @version, @max_subs, @snapshotted)`,
    ).run({
      call_id: callId,
      chain_id: CHAIN_ID,
      contract: (call.contract ?? CONTRACT).toLowerCase(),
      onchain_call_id: onchainCallId(index + 1),
      tx: `0x${(index + 1).toString(16).padStart(64, "a")}`,
      reveal_open_at: new Date(close + 600_000).toISOString(),
      now: iso,
      class: call.submissionClass ?? 1,
      reveal_status: call.revealStatus ?? "pending",
      price: call.price?.atoms ?? null,
      currency: call.price?.currency ?? null,
      version: call.price?.version ?? null,
      max_subs: call.providerMaxSubscribers ?? null,
      snapshotted: call.termsSnapshotted ?? 1,
    });
    for (let i = 0; i < (call.reservations ?? 0); i += 1) {
      entitlementsRepo.reserve(db, {
        chainId: CHAIN_ID,
        contractAddress: call.contract ?? CONTRACT,
        onchainCallId: onchainCallId(index + 1),
        subscriberAddress: `0x${(i + 1).toString(16).padStart(40, "b")}`,
        callId,
        producerAgentId: "agent-1",
        amount: "1000",
        currency: "USDC",
        now: iso,
      });
    }
  });
  db.pragma("foreign_keys = ON");
}

const SEEDS: SeedCall[] = [
  {
    // (1) The happy path: open window, owner-priced, partly reserved.
    key: "open",
    submissionCloseAtMs: NOW_MS + 600_000,
    price: { atoms: "2500", currency: "USDC", version: "v2" },
    providerMaxSubscribers: 5,
    seriesCap: 25,
    question: "Will BTC be up at 12:10?",
    reservations: 2,
  },
  {
    // (2) Owner is not selling: snapshot taken, no price.
    key: "not-selling",
    submissionCloseAtMs: NOW_MS + 700_000,
    price: null,
    termsSnapshotted: 1,
  },
  {
    // (3) Window already inside the safety margin.
    key: "closed",
    submissionCloseAtMs: NOW_MS + 60_000,
    price: { atoms: "2500", currency: "USDC", version: "v2" },
  },
  {
    // (4) Another deployment's row.
    key: "wrong-contract",
    submissionCloseAtMs: NOW_MS + 800_000,
    contract: OTHER_CONTRACT,
    price: { atoms: "2500", currency: "USDC", version: "v2" },
  },
  {
    // (5) Sold out: cap 1, one seat reserved. Still listed.
    key: "sold-out",
    submissionCloseAtMs: NOW_MS + 900_000,
    price: { atoms: "4000", currency: "USDC", version: "v2" },
    providerMaxSubscribers: 1,
    reservations: 1,
  },
  {
    // (6) Legacy pre-070 row: no snapshot at all.
    key: "legacy",
    submissionCloseAtMs: NOW_MS + 1_000_000,
    price: null,
    termsSnapshotted: 0,
  },
  {
    // (7) Late/unsellable submission class — the contract refuses to grant it.
    key: "late",
    submissionCloseAtMs: NOW_MS + 1_100_000,
    submissionClass: 2,
    price: { atoms: "2500", currency: "USDC", version: "v2" },
  },
];

function newDb() {
  const tmp = mkdtempSync(join(tmpdir(), "sellable-surface-"));
  const db = openDb({ path: join(tmp, "test.db") });
  seed(db, SEEDS);
  return { db, tmp };
}

interface ListingBody {
  purchase_available: boolean;
  legacy_terms_available: boolean;
  excluded_legacy_unpriced: number;
  note: string | null;
  calls: SellableCallRow[];
  page: { limit: number; returned: number };
  chain_id: number;
  contract_address: string;
}

function list(
  db: ReturnType<typeof openDb>,
  opts: { legacyTerms: CallTerms | null; purchaseAvailable?: boolean; limit?: number },
): ListingBody {
  const res = listSellableCallsResponse(
    {
      db,
      chain: { chainId: CHAIN_ID, sealedVerdictsAddress: CONTRACT },
      legacyTerms: opts.legacyTerms,
      salesSafetySeconds: SAFETY_SEC,
      purchaseAvailable: opts.purchaseAvailable ?? true,
      now: () => NOW,
    },
    { limit: opts.limit },
  );
  assert.equal(res.status, 200);
  return res.body as ListingBody;
}

// ── With deployment terms configured ─────────────────────────────────────────
{
  const { db, tmp } = newDb();
  const body = list(db, { legacyTerms: LEGACY_TERMS });
  const keys = body.calls.map((c) => c.market.market_id);

  assert.deepEqual(
    keys,
    ["market-open", "market-sold-out", "market-legacy"],
    "only open, sellable rows of THIS deployment are listed, sale_closes_at asc",
  );

  const open = body.calls[0]!;
  assert.equal(open.price_atoms, "2500");
  assert.equal(open.currency, "USDC");
  assert.equal(open.pricing_version, "v2");
  assert.equal(open.seats_cap, 5, "owner max wins under the larger series cap");
  assert.equal(open.seats_reserved, 2, "in-flight reservations hold seats");
  assert.equal(open.agent.slug, "oracle-one");
  assert.equal(open.agent.display_name, "Oracle One");
  assert.equal(open.market.question, "Will BTC be up at 12:10?");
  assert.equal(
    open.sale_closes_at,
    new Date(NOW_MS + 600_000 - SAFETY_SEC * 1000).toISOString(),
    "sale closes a safety margin before submission close",
  );
  assert.equal(open.reveal_open_at, new Date(NOW_MS + 600_000 + 600_000).toISOString());

  const soldOut = body.calls[1]!;
  assert.equal(soldOut.seats_cap, 1);
  assert.equal(soldOut.seats_reserved, 1, "sold-out rows stay listed with their seats");
  assert.equal(soldOut.market.question, null, "non-discovery markets have no question");

  const legacy = body.calls[2]!;
  assert.equal(legacy.price_atoms, LEGACY_TERMS.priceAtoms, "legacy row priced from deployment terms");
  assert.equal(legacy.pricing_version, LEGACY_TERMS.pricingVersion);
  assert.equal(legacy.seats_cap, 25, "no owner max → the series cap applies");

  assert.equal(body.legacy_terms_available, true);
  assert.equal(body.excluded_legacy_unpriced, 0);
  assert.equal(body.note, null);
  assert.equal(body.purchase_available, true);
  assert.equal(body.chain_id, CHAIN_ID);
  assert.equal(body.contract_address, CONTRACT);
  assert.equal(body.page.returned, 3);

  db.close();
  rmSync(tmp, { recursive: true, force: true });
}

// ── Without deployment terms: legacy rows excluded, and SAID so ──────────────
{
  const { db, tmp } = newDb();
  const body = list(db, { legacyTerms: null });
  assert.deepEqual(
    body.calls.map((c) => c.market.market_id),
    ["market-open", "market-sold-out"],
    "a daemon with no configured price must not quote one",
  );
  assert.equal(body.legacy_terms_available, false);
  assert.equal(body.excluded_legacy_unpriced, 1);
  assert.match(String(body.note), /not listed/);
  db.close();
  rmSync(tmp, { recursive: true, force: true });
}

// ── purchase_available follows the checkout mount ────────────────────────────
{
  const { db, tmp } = newDb();
  assert.equal(list(db, { legacyTerms: LEGACY_TERMS, purchaseAvailable: false }).purchase_available, false);
  assert.equal(list(db, { legacyTerms: LEGACY_TERMS, purchaseAvailable: true }).purchase_available, true);
  db.close();
  rmSync(tmp, { recursive: true, force: true });
}

// ── limit clamps, and paging reports what it returned ────────────────────────
{
  const { db, tmp } = newDb();
  const one = list(db, { legacyTerms: LEGACY_TERMS, limit: 1 });
  assert.equal(one.calls.length, 1);
  assert.equal(one.calls[0]!.market.market_id, "market-open", "earliest sale close first");
  assert.equal(one.page.limit, 1);
  const clamped = list(db, { legacyTerms: LEGACY_TERMS, limit: 10_000 });
  assert.equal(clamped.page.limit, 200, "limit is capped at 200");
  db.close();
  rmSync(tmp, { recursive: true, force: true });
}

// ── No configured deployment → fail closed, never list everything ────────────
{
  const { db, tmp } = newDb();
  const res = listSellableCallsResponse({
    db,
    chain: null,
    legacyTerms: LEGACY_TERMS,
    salesSafetySeconds: SAFETY_SEC,
    purchaseAvailable: false,
    now: () => NOW,
  });
  assert.equal(res.status, 503);
  assert.equal((res.body as { error: string }).error, "FhenixDeploymentUnconfigured");
  db.close();
  rmSync(tmp, { recursive: true, force: true });
}

process.stdout.write("OK gateway sellable surface smoke\n");
