// ─── Public marketplace catalog smoke ───────────────────────────────────────
//
//   · registrations without terms, retired sellers, benchmark and internal_test agents are excluded
//   · series metadata is returned once, independent of the cells
//   · the track record is the leaderboard's; a seller with no calls is unscored, not hidden
//   · price filters are BigInt, past Number.MAX_SAFE_INTEGER

import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDb } from "./db.js";
import { getLeaderboard } from "./leaderboard.js";
import {
  NO_MARKETPLACE_FILTERS,
  parseMarketplaceListingFilters,
  type MarketplaceListingFilters,
} from "./marketplace-listings-query.js";
import {
  marketplaceListingsResponse,
  type MarketplaceListingsBody,
} from "./marketplace-listings-surface.js";
import { agentMarketRegistrationsRepo } from "./repos/agent-market-registrations-repo.js";
import { agentProviderTermsRepo } from "./repos/agent-provider-terms-repo.js";
import { agentsRepo } from "./repos/agents-repo.js";
import { resolutionsRepo } from "./repos/resolution-repo.js";
import { submissionsRepo } from "./repos/sealed-call-submissions-repo.js";
import { venueMarketSeriesRepo } from "./repos/venue-market-series-repo.js";
import type { AgentKind } from "./schema.js";

process.stdout.write("murmur marketplace listings surface smoke\n");

const NOW = new Date("2026-08-26T12:00:00.000Z");
const ISO = NOW.toISOString();

// Beyond 2^53. Number("18446744073709551617") rounds to 18446744073709552000,
// so any Number-based comparison would answer the wrong question here.
const HUGE_ATOMS = "18446744073709551617";
const HUGE_MINUS_ONE = "18446744073709551616";
const HUGE_PLUS_ONE = "18446744073709551618";
assert.equal(
  Number(HUGE_ATOMS),
  Number(HUGE_PLUS_ONE),
  "precondition: these atom amounts are indistinguishable as JS numbers",
);

const tmp = mkdtempSync(join(tmpdir(), "marketplace-listings-"));
const db = openDb({ path: join(tmp, "test.db") });

const SERIES_BTC = "polymarket:btc-up-or-down-5m";
const SERIES_ETH = "polymarket:eth-up-or-down-5m";
const SERIES_EMPTY = "polymarket:sol-up-or-down-5m";

for (const [slug, title, category] of [
  ["btc-up-or-down-5m", "BTC Up or Down 5m", "Crypto"],
  ["eth-up-or-down-5m", "ETH Up or Down 5m", null],
  ["sol-up-or-down-5m", "SOL Up or Down 5m", "Crypto"],
] as Array<[string, string, string | null]>) {
  venueMarketSeriesRepo.upsert(db, {
    venue: "polymarket",
    series_slug: slug,
    series_title: title,
    venue_category: category,
    source_adapter_id: "polymarket-gamma",
    now: ISO,
  });
}

function newAgent(input: {
  slug: string;
  name: string;
  kind?: AgentKind;
  retired?: boolean;
}): string {
  const agentId = randomUUID();
  agentsRepo.insert(db, {
    agent_id: agentId,
    display_slug: input.slug,
    kind: input.kind ?? "agent",
    display_name: input.name,
    created_at: ISO,
  });
  if (input.retired) agentsRepo.setRetiredAt(db, agentId, ISO);
  return agentId;
}

function register(agentId: string, seriesId: string): void {
  agentMarketRegistrationsRepo.register(db, {
    agentId,
    venueSeriesId: seriesId,
    now: ISO,
  });
}

function price(
  agentId: string,
  seriesId: string,
  priceAtoms: string,
  maxSubs: number | null = null,
): void {
  register(agentId, seriesId);
  agentProviderTermsRepo.upsert(db, {
    agent_id: agentId,
    venue_series_id: seriesId,
    price_atoms: priceAtoms,
    currency: "USDC",
    pricing_version: "v1",
    max_subscribers_per_call: maxSubs,
    now: ISO,
  });
}

/** One resolved call, so the seller carries a real leaderboard record. */
function resolveCall(agentId: string, slug: string, index: number, score: number): void {
  const callId = randomUUID();
  submissionsRepo.acceptSealedFhenixCall(db, {
    call_id: callId,
    agent_id: agentId,
    client_order_id: `${slug}-order-${index}`,
    horizon_seconds: 300,
    submitted_at: ISO,
    accepted_at: ISO,
    rationale: "private rationale",
    strategy_tag: "private-strategy",
    schema_version: 1,
    scoring_version: 1,
    dedup_key: `dedup-${callId}`,
    commit_hash: "a".repeat(64),
    commit_scheme: "fhenix-sealed-v1",
    market_id: "btc.5m",
    market_config_version: 1,
    adapter_id: "polymarket-gamma",
    market_family: "financial-direction",
  });
  resolutionsRepo.setResolution(db, {
    call_id: callId,
    t1: ISO,
    p1: score >= 0.5 ? "101" : "99",
    t1_feed: "polymarket:btc-up-or-down-5m",
    signed_return: score >= 0.5 ? "0.01" : "-0.01",
    outcome: score >= 0.5 ? "win" : "loss",
    call_score: score,
    resolved_at: ISO,
  });
  submissionsRepo.setStatus(db, callId, "resolved");
}

// ── The cast ────────────────────────────────────────────────────────────────
//
// scored     — sells BTC and ETH, has a real leaderboard record.
// unscored   — sells BTC, has never submitted a call. Listed with nulls.
// registered — registered for BTC, NO terms. Serves it, is not selling it.
// retired    — sells BTC, then retired. Gone.
// benchmark  — murmur's anchor row. Priced, still excluded.
// qa         — internal_test. Priced, still excluded.
// dear       — sells ETH at an amount beyond Number.MAX_SAFE_INTEGER.
const scored = newAgent({ slug: "aa-scored-seller", name: "Scored Seller" });
const unscored = newAgent({ slug: "bb-unscored-seller", name: "Unscored Seller" });
const registeredOnly = newAgent({ slug: "cc-registered-only", name: "Registered Only" });
const retired = newAgent({ slug: "dd-retired-seller", name: "Retired Seller", retired: true });
const benchmark = newAgent({ slug: "ee-benchmark", name: "Benchmark", kind: "benchmark" });
const qa = newAgent({ slug: "ff-qa", name: "QA", kind: "internal_test" });
const dear = newAgent({ slug: "gg-dear-seller", name: "Dear Seller" });

price(scored, SERIES_BTC, "2500", 5);
price(scored, SERIES_ETH, "7500");
price(unscored, SERIES_BTC, "1000");
register(registeredOnly, SERIES_BTC);
price(retired, SERIES_BTC, "9999");
price(benchmark, SERIES_BTC, "1");
price(qa, SERIES_BTC, "2");
price(dear, SERIES_ETH, HUGE_ATOMS);

resolveCall(scored, "aa-scored-seller", 0, 0.9);
resolveCall(scored, "aa-scored-seller", 1, 0.8);
resolveCall(scored, "aa-scored-seller", 2, 0.7);

function list(filters: MarketplaceListingFilters = NO_MARKETPLACE_FILTERS): MarketplaceListingsBody {
  const res = marketplaceListingsResponse({ db, now: () => NOW }, filters);
  assert.equal(res.status, 200);
  return res.body as MarketplaceListingsBody;
}

function withFilters(patch: Partial<MarketplaceListingFilters>): MarketplaceListingFilters {
  return { ...NO_MARKETPLACE_FILTERS, ...patch };
}

// ── 1. Who is listed, and who is not ────────────────────────────────────────
{
  const body = list();
  assert.deepEqual(
    body.agents.map((a) => a.display_slug),
    ["aa-scored-seller", "bb-unscored-seller", "gg-dear-seller"],
    "priced non-retired agents only, ordered by lower(display_slug)",
  );

  const slugs = new Set(body.agents.map((a) => a.display_slug));
  assert.ok(
    !slugs.has("cc-registered-only"),
    "a registration WITHOUT terms serves the series but is not selling it",
  );
  assert.ok(!slugs.has("dd-retired-seller"), "retired sellers are gone from the catalog");
  assert.ok(!slugs.has("ee-benchmark"), "benchmark anchor rows are not marketplace sellers");
  assert.ok(!slugs.has("ff-qa"), "internal_test agents are not marketplace sellers");

  const seller = body.agents[0]!;
  assert.deepEqual(
    seller.listings.map((l) => l.venue_series_id),
    [SERIES_BTC, SERIES_ETH],
    "an agent's listings are its own cells, ordered by venue then series_slug",
  );
  assert.deepEqual(seller.listings[0]!.current_terms, {
    price_atoms: "2500",
    currency: "USDC",
    pricing_version: "v1",
    max_subscribers_per_call: 5,
    updated_at: ISO,
  });
  assert.equal(
    seller.listings[1]!.current_terms.max_subscribers_per_call,
    null,
    "no owner ceiling stays null — not zero, and not the deliverable cap",
  );
  assert.equal(body.served_at, "2026-08-26T12:00:00Z");
}

// ── 2. Series metadata is independent of the cells ──────────────────────────
{
  const body = list();
  assert.deepEqual(
    body.series.map((s) => s.venue_series_id),
    [SERIES_BTC, SERIES_ETH, SERIES_EMPTY],
    "every series is returned, including one nobody sells",
  );
  const sol = body.series.find((s) => s.venue_series_id === SERIES_EMPTY)!;
  assert.equal(sol.series_title, "SOL Up or Down 5m");
  assert.ok(
    !body.agents.some((a) => a.listings.some((l) => l.venue_series_id === SERIES_EMPTY)),
    "an empty aisle has metadata but no cells",
  );
  const eth = body.series.find((s) => s.venue_series_id === SERIES_ETH)!;
  assert.equal(eth.venue_category, null, "an absent venue category is null, not invented");
  assert.equal(eth.venue, "polymarket");
  assert.equal(eth.series_slug, "eth-up-or-down-5m");

  // Nothing anywhere in the payload repeats the series title per listing.
  const anyListing = body.agents[0]!.listings[0]! as unknown as Record<string, unknown>;
  assert.deepEqual(
    Object.keys(anyListing).sort(),
    ["current_terms", "venue_series_id"],
    "a listing carries the series KEY, never a copy of its metadata",
  );
}

// ── 3. The track record is the leaderboard's, field for field ───────────────
{
  const body = list();
  const board = getLeaderboard(db);
  const boardRow = board.find((r) => r.agent_id === scored)!;
  assert.ok(boardRow, "precondition: the scored seller is on the public board");

  const listed = body.agents.find((a) => a.agent_id === scored)!;
  assert.deepEqual(
    listed.track_record,
    {
      tier: boardRow.tier,
      rank: boardRow.rank,
      verdict_score: boardRow.verdict_score,
      verdict_score_lb: boardRow.verdict_score_lb,
      resolved_calls: boardRow.resolved_calls,
      win_rate: boardRow.win_rate,
      marketplace_eligible: boardRow.marketplace_eligible,
    },
    "one scoring path: the catalog reports exactly what getLeaderboard reports",
  );
  assert.equal(listed.track_record.resolved_calls, 3);
  assert.ok(
    listed.track_record.verdict_score_lb !== null,
    "precondition: the scored seller has a lower bound to filter on",
  );
}

// ── 4. An unscored seller gets nulls, NOT exclusion ─────────────────────────
{
  const body = list();
  const listed = body.agents.find((a) => a.agent_id === unscored)!;
  assert.ok(listed, "a seller who has never called is still selling");
  assert.deepEqual(listed.track_record, {
    tier: null,
    rank: null,
    verdict_score: null,
    verdict_score_lb: null,
    resolved_calls: 0,
    win_rate: null,
    marketplace_eligible: false,
  });
  assert.equal(
    getLeaderboard(db).some((r) => r.agent_id === unscored),
    false,
    "and the board genuinely has no row for them — the nulls are not a stand-in",
  );
}

// ── 5. Series filter narrows both the cells and the series dimension ────────
{
  const body = list(withFilters({ series: [SERIES_ETH] }));
  assert.deepEqual(
    body.series.map((s) => s.venue_series_id),
    [SERIES_ETH],
    "a scoped request gets the scoped dimension, not all five aisles",
  );
  assert.deepEqual(
    body.agents.map((a) => a.display_slug),
    ["aa-scored-seller", "gg-dear-seller"],
    "only sellers with a cell in the requested series",
  );
  assert.ok(
    body.agents.every((a) => a.listings.every((l) => l.venue_series_id === SERIES_ETH)),
    "and only their cells IN that series",
  );

  const both = list(withFilters({ series: [SERIES_ETH, SERIES_BTC] }));
  assert.equal(both.agents.length, 3, "series= is repeatable and OR-ed");
}

// ── 6. Price bounds are BigInt, past Number.MAX_SAFE_INTEGER ────────────────
{
  const atFloor = list(withFilters({ minListPriceAtoms: BigInt(HUGE_ATOMS) }));
  assert.deepEqual(
    atFloor.agents.map((a) => a.display_slug),
    ["gg-dear-seller"],
    "an inclusive floor keeps the row sitting exactly on it",
  );

  const justAbove = list(withFilters({ minListPriceAtoms: BigInt(HUGE_PLUS_ONE) }));
  assert.deepEqual(
    justAbove.agents,
    [],
    "one atom above and the row is gone — a Number comparison would keep it",
  );

  const justBelowCeiling = list(withFilters({ maxListPriceAtoms: BigInt(HUGE_MINUS_ONE) }));
  assert.ok(
    !justBelowCeiling.agents.some((a) => a.display_slug === "gg-dear-seller"),
    "one atom below the ceiling and the row is excluded, again past 2^53",
  );

  const band = list(withFilters({
    minListPriceAtoms: 1000n,
    maxListPriceAtoms: 2500n,
  }));
  assert.deepEqual(
    band.agents.map((a) => a.display_slug),
    ["aa-scored-seller", "bb-unscored-seller"],
    "both bounds are inclusive",
  );
  assert.deepEqual(
    band.agents[0]!.listings.map((l) => l.venue_series_id),
    [SERIES_BTC],
    "price bounds drop CELLS, not whole agents: the 7500 ETH listing is out",
  );
}

// ── 7. Track-record floors are per agent ────────────────────────────────────
{
  const resolved = list(withFilters({ minResolvedCalls: 1 }));
  assert.deepEqual(
    resolved.agents.map((a) => a.display_slug),
    ["aa-scored-seller"],
    "min_resolved_calls excludes sellers with no record",
  );

  const floor = list(withFilters({ minScoreFloor: -1000 }));
  assert.deepEqual(
    floor.agents.map((a) => a.display_slug),
    ["aa-scored-seller"],
    "an unscored seller has no lower bound and cannot be shown to clear a floor",
  );

  const impossible = list(withFilters({ minScoreFloor: 1000 }));
  assert.deepEqual(impossible.agents, [], "a floor nobody clears returns nobody");
  assert.equal(
    impossible.series.length,
    3,
    "and the series dimension is unaffected by agent-level floors",
  );
}

// ── 8. Malformed filters are rejected, never silently dropped ───────────────
{
  const ok = parseMarketplaceListingFilters({
    series: [SERIES_BTC, SERIES_BTC, " "],
    min_list_price_atoms: HUGE_ATOMS,
    min_resolved_calls: "3",
    min_score_floor: "-0.5",
  });
  assert.ok(ok.ok);
  assert.deepEqual(ok.filters.series, [SERIES_BTC], "blank and duplicate series collapse");
  assert.equal(ok.filters.minListPriceAtoms, BigInt(HUGE_ATOMS));
  assert.equal(ok.filters.minResolvedCalls, 3);
  assert.equal(ok.filters.minScoreFloor, -0.5);

  for (const [param, value] of [
    ["min_list_price_atoms", "1e9"],
    ["min_list_price_atoms", "-5"],
    ["min_list_price_atoms", "12.5"],
    ["max_list_price_atoms", "0x10"],
    ["min_resolved_calls", "-1"],
    ["min_score_floor", "not-a-number"],
  ] as Array<[string, string]>) {
    const parsed = parseMarketplaceListingFilters({ [param]: value });
    assert.equal(parsed.ok, false, `${param}=${value} must be rejected, not ignored`);
  }

  const inverted = parseMarketplaceListingFilters({
    min_list_price_atoms: "100",
    max_list_price_atoms: "10",
  });
  assert.equal(inverted.ok, false, "a range that can never match is a 400, not an empty page");

  const empty = parseMarketplaceListingFilters(undefined);
  assert.ok(empty.ok);
  assert.deepEqual(empty.filters, NO_MARKETPLACE_FILTERS);
}

// ── 9. Clearing terms delists without dropping the registration ─────────────
{
  agentProviderTermsRepo.clear(db, { agentId: unscored, venueSeriesId: SERIES_BTC });
  const body = list();
  assert.ok(
    !body.agents.some((a) => a.agent_id === unscored),
    "stop selling and the listing is gone the same instant",
  );
  assert.equal(
    agentMarketRegistrationsRepo.isRegistered(db, {
      agentId: unscored,
      venueSeriesId: SERIES_BTC,
    }),
    true,
    "but the agent still serves the series — delisting is not deregistration",
  );
}

db.close();
rmSync(tmp, { recursive: true, force: true });
process.stdout.write("OK marketplace listings surface smoke\n");
