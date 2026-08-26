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
//   · a page's cursor must not skip or repeat a row
//   · the LOCKED snapshot on a sealed call and the seller's CURRENT standing
//     listing are different numbers, and repricing must move only the second

import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDb } from "./db.js";
import { agentMarketRegistrationsRepo } from "./repos/agent-market-registrations-repo.js";
import { agentProviderTermsRepo } from "./repos/agent-provider-terms-repo.js";
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

const SERIES_BTC = "polymarket:btc-up-or-down-5m";
const SERIES_ETH = "polymarket:eth-up-or-down-5m";

const AGENTS = [
  { id: "agent-1", slug: "oracle-one", name: "Oracle One" },
  { id: "agent-2", slug: "Oracle-Two", name: "Oracle Two" },
] as const;

interface SeedCall {
  key: string;
  /** Absolute submission close; the sale closes SAFETY_SEC before it. */
  submissionCloseAtMs: number;
  agentId?: string;
  /** The venue series the call's MARKET belongs to; null leaves it unlinked. */
  venueSeriesId?: string | null;
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
  for (const agent of AGENTS) {
    db.prepare(
      `INSERT INTO agents (agent_id, display_slug, kind, display_name, created_at)
       VALUES (@agent_id, @slug, 'agent', @name, @now)`,
    ).run({ agent_id: agent.id, slug: agent.slug, name: agent.name, now: iso });
  }
  // The venue's durable series identity (migration 075). The storefront reads
  // it only through markets.venue_series_id; the CATALOG side is seeded too so
  // the standing-listing-vs-snapshot divergence can be driven for real.
  for (const [seriesId, slug, title] of [
    [SERIES_BTC, "btc-up-or-down-5m", "BTC Up or Down 5m"],
    [SERIES_ETH, "eth-up-or-down-5m", "ETH Up or Down 5m"],
  ] as Array<[string, string, string]>) {
    db.prepare(
      `INSERT INTO venue_market_series (venue_series_id, venue, series_slug,
         series_title, venue_category, source_adapter_id, created_at, updated_at)
       VALUES (@id, 'polymarket', @slug, @title, 'Crypto', 'polymarket-gamma',
         @now, @now)`,
    ).run({ id: seriesId, slug, title, now: iso });
  }

  calls.forEach((call, index) => {
    const marketId = `market-${call.key}`;
    const seriesId = `series-${call.key}`;
    const callId = `call-${call.key}`;
    const close = call.submissionCloseAtMs;
    db.prepare(
      `INSERT INTO markets (market_id, asset_id, horizon_seconds, primary_oracle_id,
         primary_max_staleness_sec, t0_grace_seconds, t0_extended_grace_seconds,
         void_band, created_at, venue_series_id)
       VALUES (@market_id, 'asset-1', 300, 'oracle-1', 60, 30, 60, '0', @now,
         @venue_series_id)`,
    ).run({
      market_id: marketId,
      now: iso,
      venue_series_id: call.venueSeriesId === undefined ? SERIES_BTC : call.venueSeriesId,
    });
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
    const agentId = call.agentId ?? "agent-1";
    db.prepare(
      `INSERT INTO submissions (call_id, agent_id, client_order_id, horizon_seconds,
         submitted_at, accepted_at, status, schema_version, scoring_version,
         dedup_key, market_id)
       VALUES (@call_id, @agent_id, @call_id, 300, @now, @now, 'accepted', 1, 1,
         @call_id, @market_id)`,
    ).run({ call_id: callId, agent_id: agentId, market_id: marketId, now: iso });
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
        producerAgentId: agentId,
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
  {
    // (8) A second seller, in a second series. Its LOCKED snapshot is 10000
    //     while the same seller's standing listing for the series is 50000 —
    //     the two prices this surface must never conflate.
    key: "open-eth",
    submissionCloseAtMs: NOW_MS + 1_200_000,
    agentId: "agent-2",
    venueSeriesId: SERIES_ETH,
    price: { atoms: "10000", currency: "USDC", version: "v2" },
    providerMaxSubscribers: 3,
  },
];

/** The seller's STANDING listing — deliberately a different number. */
function seedStandingListing(db: ReturnType<typeof openDb>, priceAtoms: string): void {
  agentMarketRegistrationsRepo.register(db, {
    agentId: "agent-2",
    venueSeriesId: SERIES_ETH,
    now: NOW.toISOString(),
  });
  agentProviderTermsRepo.upsert(db, {
    agent_id: "agent-2",
    venue_series_id: SERIES_ETH,
    price_atoms: priceAtoms,
    currency: "USDC",
    pricing_version: "v9",
    max_subscribers_per_call: null,
    now: NOW.toISOString(),
  });
}

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
  next_cursor: string | null;
  page: { limit: number; returned: number };
  chain_id: number;
  contract_address: string;
}

function list(
  db: ReturnType<typeof openDb>,
  opts: {
    legacyTerms: CallTerms | null;
    purchaseAvailable?: boolean;
    limit?: number;
    cursor?: string | null;
    venueSeriesIds?: readonly string[];
    agentSlug?: string | null;
  },
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
    {
      limit: opts.limit,
      cursor: opts.cursor ?? null,
      venueSeriesIds: opts.venueSeriesIds ?? [],
      agentSlug: opts.agentSlug ?? null,
    },
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
    ["market-open", "market-sold-out", "market-legacy", "market-open-eth"],
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
  assert.equal(body.page.returned, 4);
  assert.equal(body.next_cursor, null, "a page shorter than the limit is the last one");

  db.close();
  rmSync(tmp, { recursive: true, force: true });
}

// ── Without deployment terms: legacy rows excluded, and SAID so ──────────────
{
  const { db, tmp } = newDb();
  const body = list(db, { legacyTerms: null });
  assert.deepEqual(
    body.calls.map((c) => c.market.market_id),
    ["market-open", "market-sold-out", "market-open-eth"],
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

// ── The two prices: a locked snapshot and a standing listing ────────────────
//
// The single most expensive bug this surface can have is quoting the seller's
// CURRENT price for a call already sealed. Here the seller's standing listing
// is 50000 while the sealed call's snapshot is 10000, and a repricing moves
// only the first.
{
  const { db, tmp } = newDb();
  seedStandingListing(db, "50000");

  const before = list(db, { legacyTerms: LEGACY_TERMS, venueSeriesIds: [SERIES_ETH] });
  const call = before.calls[0]!;
  assert.equal(call.market.market_id, "market-open-eth");
  assert.equal(
    call.locked_terms.price_atoms,
    "10000",
    "a buyer pays the snapshot frozen when the call was sealed",
  );
  assert.equal(call.locked_terms.pricing_version, "v2");
  assert.notEqual(
    call.locked_terms.price_atoms,
    "50000",
    "the seller's standing listing is a DIFFERENT number and must not leak in",
  );
  assert.equal(call.price_atoms, call.locked_terms.price_atoms, "flat alias mirrors it");
  assert.equal(call.currency, call.locked_terms.currency);
  assert.equal(call.pricing_version, call.locked_terms.pricing_version);

  // Reprice the standing listing. The already-sealed call must not move.
  seedStandingListing(db, "99999");
  const after = list(db, { legacyTerms: LEGACY_TERMS, venueSeriesIds: [SERIES_ETH] });
  assert.equal(
    after.calls[0]!.locked_terms.price_atoms,
    "10000",
    "repricing changes what the NEXT call costs, never a call already on offer",
  );

  db.close();
  rmSync(tmp, { recursive: true, force: true });
}

// ── Series and agent filters ────────────────────────────────────────────────
{
  const { db, tmp } = newDb();

  const eth = list(db, { legacyTerms: LEGACY_TERMS, venueSeriesIds: [SERIES_ETH] });
  assert.deepEqual(
    eth.calls.map((c) => c.market.market_id),
    ["market-open-eth"],
    "a series filter returns only calls whose market belongs to it",
  );
  assert.equal(eth.calls[0]!.venue_series_id, SERIES_ETH, "the series id is on the row");
  assert.equal(eth.calls[0]!.agent_id, "agent-2", "so is the seller's durable id");

  const btc = list(db, { legacyTerms: LEGACY_TERMS, venueSeriesIds: [SERIES_BTC] });
  assert.deepEqual(
    btc.calls.map((c) => c.market.market_id),
    ["market-open", "market-sold-out", "market-legacy"],
  );

  const both = list(db, {
    legacyTerms: LEGACY_TERMS,
    venueSeriesIds: [SERIES_BTC, SERIES_ETH],
  });
  assert.equal(both.calls.length, 4, "series= is repeatable and OR-ed");

  const unknownSeries = list(db, {
    legacyTerms: LEGACY_TERMS,
    venueSeriesIds: ["polymarket:nope"],
  });
  assert.deepEqual(unknownSeries.calls, [], "an unknown series matches nothing, not everything");

  // The seed slug is "Oracle-Two"; the query uses lowercase. Slugs are
  // canonically lowercase but URLs are not, so the match is NOCASE.
  const byAgent = list(db, { legacyTerms: LEGACY_TERMS, agentSlug: "oracle-two" });
  assert.deepEqual(
    byAgent.calls.map((c) => c.market.market_id),
    ["market-open-eth"],
    "an agent filter matches the slug case-insensitively",
  );
  const byOtherAgent = list(db, { legacyTerms: LEGACY_TERMS, agentSlug: "ORACLE-ONE" });
  assert.deepEqual(
    byOtherAgent.calls.map((c) => c.market.market_id),
    ["market-open", "market-sold-out", "market-legacy"],
  );

  const combined = list(db, {
    legacyTerms: LEGACY_TERMS,
    venueSeriesIds: [SERIES_BTC],
    agentSlug: "oracle-two",
  });
  assert.deepEqual(combined.calls, [], "filters AND together");

  // The unpriced-legacy COUNT is scoped by the same filters, so it describes
  // the slice it annotates. Without it, a caller narrowed to one series would
  // be told about exclusions in another.
  const btcNoTerms = list(db, { legacyTerms: null, venueSeriesIds: [SERIES_BTC] });
  assert.equal(btcNoTerms.excluded_legacy_unpriced, 1, "the legacy row is a BTC row");
  const ethNoTerms = list(db, { legacyTerms: null, venueSeriesIds: [SERIES_ETH] });
  assert.equal(
    ethNoTerms.excluded_legacy_unpriced,
    0,
    "and nothing is excluded from the ETH slice",
  );
  assert.equal(ethNoTerms.note, null);

  db.close();
  rmSync(tmp, { recursive: true, force: true });
}

// ── Keyset paging: no gaps, no duplicates ───────────────────────────────────
{
  const { db, tmp } = newDb();
  const whole = list(db, { legacyTerms: LEGACY_TERMS }).calls.map((c) => c.onchain_call_id);
  assert.equal(whole.length, 4, "precondition: enough rows to page");

  const paged: string[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 10; page += 1) {
    const body: ListingBody = list(db, { legacyTerms: LEGACY_TERMS, limit: 2, cursor });
    paged.push(...body.calls.map((c) => c.onchain_call_id));
    cursor = body.next_cursor;
    if (!cursor) break;
  }
  assert.equal(cursor, null, "paging terminates");
  assert.deepEqual(paged, whole, "the pages reassemble the full list in order");
  assert.equal(new Set(paged).size, paged.length, "and no row is served twice");

  const firstPage = list(db, { legacyTerms: LEGACY_TERMS, limit: 2 });
  assert.ok(firstPage.next_cursor, "a full page offers a cursor");
  const secondPage = list(db, {
    legacyTerms: LEGACY_TERMS,
    limit: 2,
    cursor: firstPage.next_cursor,
  });
  assert.equal(
    secondPage.calls.some((c) => firstPage.calls.some((f) => f.onchain_call_id === c.onchain_call_id)),
    false,
    "the second page shares no row with the first",
  );

  // The cursor is opaque, and one this endpoint never issued is an error
  // rather than a silent restart from the top.
  const bad = listSellableCallsResponse(
    {
      db,
      chain: { chainId: CHAIN_ID, sealedVerdictsAddress: CONTRACT },
      legacyTerms: LEGACY_TERMS,
      salesSafetySeconds: SAFETY_SEC,
      purchaseAvailable: true,
      now: () => NOW,
    },
    { cursor: "not-a-cursor" },
  );
  assert.equal(bad.status, 400);
  assert.equal((bad.body as { error: string }).error, "BadCursor");

  db.close();
  rmSync(tmp, { recursive: true, force: true });
}

// ── Inventory status and seats ──────────────────────────────────────────────
{
  const { db, tmp } = newDb();
  const body = list(db, { legacyTerms: LEGACY_TERMS });
  const byMarket = new Map(body.calls.map((c) => [c.market.market_id, c]));

  const open = byMarket.get("market-open")!;
  assert.equal(open.seats_cap, 5);
  assert.equal(open.seats_reserved, 2);
  assert.equal(open.seats_remaining, 3);
  assert.equal(open.inventory_status, "available");

  const soldOut = byMarket.get("market-sold-out")!;
  assert.equal(soldOut.seats_remaining, 0);
  assert.equal(
    soldOut.inventory_status,
    "full",
    "a fully reserved cohort reads full — it is listed, but nothing is left to sell",
  );

  assert.ok(
    !byMarket.has("market-not-selling"),
    "snapshot taken with no price means NOT FOR SALE, at any price",
  );
  assert.ok(!byMarket.has("market-closed"), "a window inside the safety margin is closed");
  assert.ok(!byMarket.has("market-wrong-contract"), "another deployment's rows never appear");
  assert.ok(!byMarket.has("market-late"), "a LateUnsellable class can never be granted");

  // Every row is informational when this daemon has no checkout at all. That
  // dominates `full`: the reason a buyer cannot buy is the missing checkout.
  const noCheckout = list(db, { legacyTerms: LEGACY_TERMS, purchaseAvailable: false });
  assert.ok(noCheckout.calls.length > 0, "rows are still listed — they are real offers");
  assert.deepEqual(
    [...new Set(noCheckout.calls.map((c) => c.inventory_status))],
    ["checkout_unavailable"],
    "with no checkout mounted, every row says so",
  );
  assert.equal(
    noCheckout.calls.find((c) => c.market.market_id === "market-open")!.seats_remaining,
    3,
    "and the seat counts stay factual",
  );

  db.close();
  rmSync(tmp, { recursive: true, force: true });
}

// ── The reservation count is one grouped read, and still per call ───────────
{
  const { db, tmp } = newDb();
  const counts = entitlementsRepo.countActiveForCalls(db, {
    chainId: CHAIN_ID,
    contractAddress: CONTRACT,
    onchainCallIds: [onchainCallId(1), onchainCallId(5), onchainCallId(6)],
  });
  assert.equal(counts.get(onchainCallId(1)), 2, "the open call's two reservations");
  assert.equal(counts.get(onchainCallId(5)), 1, "the sold-out call's one");
  assert.equal(
    counts.get(onchainCallId(6)),
    undefined,
    "a call nobody bought is ABSENT, which callers must read as zero",
  );
  assert.equal(
    counts.get(onchainCallId(1)),
    entitlementsRepo.countActiveForCall(db, {
      chainId: CHAIN_ID,
      contractAddress: CONTRACT,
      onchainCallId: onchainCallId(1),
    }),
    "batched and single-call counts agree",
  );
  db.close();
  rmSync(tmp, { recursive: true, force: true });
}

process.stdout.write("OK gateway sellable surface smoke\n");
