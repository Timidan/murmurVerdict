// Rich, internally consistent fixture data for ?mock=1 demo mode.
//
// Internal consistency rules:
//   - Every call_id references a real agent.slug and market.market_id
//   - Leaderboard scores derive from the agent's win/loss/void counts
//   - Today feed slices are derived from the call list, not invented
//   - Markets cover the same horizons/assets referenced by calls
//
// Determinism: a single seeded RNG drives every random choice. The same
// fixture set paints on every reload until this file or seed.ts changes.

import type {
  AccountAgent,
  AgentCallRow,
  AgentFamilyRow,
  AgentGridSummary,
  AgentKind,
  AgentMarketRow,
  AgentProfile,
  ApiKeyRow,
  FullCall,
  LeaderboardRow,
  MarketRow,
  MarketTaxonomyResponse,
  MetaResponse,
  TodayFeed,
  TodayFeedRow,
  TodayMover,
} from "../api.js";
import {
  hash32,
  hexId,
  intRange,
  isoOffset,
  makeRng,
  pick,
  range,
  walletFromSlug,
} from "./seed.js";

const SEED = 0x4d754d72; // "MuMr"
const NOW_MS = Date.UTC(2026, 4, 16, 14, 30, 0); // 2026-05-16T14:30:00Z, matches MEMORY.md currentDate

const rng = makeRng(SEED);

/* ── Agents ─────────────────────────────────────────────────────────── */

interface MockAgent {
  agent_id: string;
  slug: string;
  display_name: string;
  kind: AgentKind;
  tier: "main" | "provisional";
  wallet: string;
  chain_id: string;
  created_at: string;
  bio?: string;
  // Score model
  wins: number;
  losses: number;
  voids: number;
  pending: number;
  verdict_score: number | null;
  verdict_score_lb: number | null;
  win_rate: number | null;
  resolved_calls: number;
  rank: number | null;
  last_resolved_at: string | null;
  streak: number;
}

const AGENT_SLUGS: ReadonlyArray<readonly [string, string, AgentKind, string?]> = [
  // [slug, display_name, kind, bio?]
  ["murmur-alpha", "Murmur Alpha", "agent", "Long-only ETH momentum on Base. 1h horizon, Chainlink-anchored."],
  ["oracle-prime", "Oracle Prime", "agent", "Pyth × Chainlink confidence-weighted dispatcher."],
  ["vega-002", "Vega 002", "agent", "Vol-spike scalper. Routes BTC + SOL on 1h direction."],
  ["nimble-rho", "Nimble Rho", "agent", "Mid-horizon rotation across L2 majors."],
  ["pyrite-7", "Pyrite Seven", "agent", "Counter-trend on OP and ARB. 4h horizon."],
  ["tessera", "Tessera", "agent", "Crossbasket BTC/ETH spread agent."],
  ["signal-witch", "Signal Witch", "agent", "Mean-reversion under regime classifier."],
  ["falcon-eye", "Falcon Eye", "agent", "Directional ETH 4h with funding-rate filter."],
  ["argent-2", "Argent II", "agent", "Long-tail SOL momentum."],
  ["nyx-noir", "Nyx Noir", "agent", "Bearish-bias OP / ARB option-implied flow."],
  ["scarab-9", "Scarab Nine", "agent", "Range-bound BTC seller. Highest resolved count."],
  ["sable-001", "Sable 001", "agent", "Stable-quote ETH carry. Low signed return."],
  ["luminol", "Luminol", "agent", "ETH 1d trend follower. Mid wr."],
  ["onyx-lite", "Onyx Lite", "agent", "BTC 4h direction · slim provisional."],
  ["pavo", "Pavo", "agent", "SOL 1h burst detector."],
  ["bismuth-x", "Bismuth X", "agent", "ARB / OP correlation pair trader."],
  ["camber", "Camber", "agent", "Cross-asset basket reweighter."],
  ["dander-3", "Dander Three", "agent", "ETH 1h reactive."],
  ["ember-q", "Ember Q", "agent", "Volatility crush exploiter."],
  ["fennec", "Fennec", "agent", "SOL counter-trend."],
  ["gorse", "Gorse", "agent", "BTC long-horizon mean reverter."],
  ["heron-2", "Heron II", "agent", "ETH macro-news fader."],
  ["isodel", "Isodel", "agent", "Categorical event binary specialist."],
  ["jagger", "Jagger", "agent", "Funding-rate directional."],
  ["kestrel", "Kestrel", "agent", "L2 onchain-flow tilt."],
  ["loom-7", "Loom 7", "agent", "Stable carry with vol overlay."],
  ["mantle-a", "Mantle A", "agent", "BTC/ETH ratio agent."],
  ["nori", "Nori", "agent", "Macro-event holder."],
  ["obsidian", "Obsidian", "agent", "Provisional shorter."],
  ["paragon-x", "Paragon X", "agent", "Volume-weighted directional."],
  ["quartz-3", "Quartz Three", "agent", "Burst momentum 1h."],
  ["ravel", "Ravel", "agent", "Mid-horizon dispersion."],
  ["sloth-9", "Sloth Nine", "agent", "Slow trend follower."],
  ["tundra", "Tundra", "agent", "Range fader."],
  ["umber-1", "Umber 1", "agent", "Cross-family qualifier."],
  ["vesper", "Vesper", "agent", "Twilight session trader."],
  // benchmarks
  ["bm-coin-flip", "Benchmark · Coin Flip", "benchmark", "50/50 reference agent — system-curated."],
  ["bm-buyhold-eth", "Benchmark · Buy-and-Hold ETH", "benchmark", "Always long ETH at horizon."],
  ["bm-trend-ema", "Benchmark · EMA Trend", "benchmark", "Naive EMA(12/26) crossover."],
  // attested
  ["sentinel-prime", "Sentinel Prime", "attested", "Olas Service Registry bond · Safe multisig controller."],
  ["aegis-001", "Aegis 001", "attested", "Attested · multisig-controlled."],
  // internal_test (operator-only, so dim)
  ["op-internal-1", "Operator Internal 1", "internal_test", "Operator-side regression agent."],
  // sparse / no-data agents
  ["new-arrival", "New Arrival", "agent", "Joined yesterday. No resolved calls yet."],
  ["dormant-2", "Dormant 2", "agent", "Long-idle agent."],
  ["echo-7", "Echo Seven", "agent", "Provisional · still warming up."],
];

function buildAgent(slug: string, display: string, kind: AgentKind, bio: string | undefined, idx: number): MockAgent {
  const localRng = makeRng(hash32(slug));
  const isSparse = slug === "new-arrival" || slug === "dormant-2" || slug === "echo-7";
  const isBench = kind === "benchmark";
  const isAttested = kind === "attested";

  let wins = 0;
  let losses = 0;
  let voids = 0;
  let pending = 0;
  let verdict: number | null = null;
  let winRate: number | null = null;
  let streak = 0;
  let lastResolvedAt: string | null = null;

  if (isSparse) {
    pending = intRange(localRng, 0, 3);
    verdict = null;
    winRate = null;
    if (pending > 0) {
      lastResolvedAt = null;
    }
  } else {
    // Generate a target win-rate band, then size resolution count.
    const wrBase = isBench
      ? 0.5 + (localRng() - 0.5) * 0.06
      : isAttested
        ? 0.58 + localRng() * 0.18
        : 0.4 + localRng() * 0.45;
    const total = intRange(localRng, 18, 220);
    wins = Math.round(total * wrBase);
    losses = Math.round(total * (1 - wrBase) * (0.85 + localRng() * 0.2));
    voids = Math.max(0, total - wins - losses);
    pending = intRange(localRng, 0, 9);
    if (wins + losses === 0) {
      winRate = null;
    } else {
      winRate = wins / (wins + losses);
    }
    // Map win-rate to a verdict score in [-0.4, +0.8], biased so high-wr
    // gives a non-zero positive number. Bench agents hover near zero.
    if (isBench) {
      verdict = (localRng() - 0.5) * 0.08;
    } else {
      const offset = (winRate ?? 0.5) - 0.5;
      verdict = offset * 1.4 + (localRng() - 0.5) * 0.06;
      // Snap a few outliers high/low.
      if (idx % 11 === 0) verdict = Math.min(0.82, (verdict ?? 0) + 0.18);
      if (idx % 13 === 0) verdict = Math.max(-0.34, (verdict ?? 0) - 0.22);
    }
    streak = wins > losses ? intRange(localRng, 1, 7) : 0;
    const minutesAgo = intRange(localRng, 5, 60 * 24 * 4);
    lastResolvedAt = isoOffset(NOW_MS, -minutesAgo * 60_000);
  }

  const verdictLb = verdict === null ? null : Math.max(-0.5, verdict - 0.04 - localRng() * 0.05);
  const createdMinutes = intRange(localRng, 60 * 24 * 7, 60 * 24 * 60);
  const createdAt = isoOffset(NOW_MS, -createdMinutes * 60_000);

  return {
    agent_id: `ag_${hexId(`agent:${slug}`, 16)}`,
    slug,
    display_name: display,
    kind,
    tier: !isSparse && wins + losses + voids >= 20 ? "main" : "provisional",
    wallet: walletFromSlug(slug),
    chain_id: "eip155:8453",
    created_at: createdAt,
    bio,
    wins,
    losses,
    voids,
    pending,
    verdict_score: verdict,
    verdict_score_lb: verdictLb,
    win_rate: winRate,
    resolved_calls: wins + losses + voids,
    rank: null, // assigned after sort
    last_resolved_at: lastResolvedAt,
    streak,
  };
}

export const AGENTS: MockAgent[] = AGENT_SLUGS.map(([slug, name, kind, bio], idx) =>
  buildAgent(slug, name, kind, bio, idx),
);

// Assign rank by verdict_score desc, main tier only ranks. Provisional / sparse stay null.
{
  const ranked = AGENTS.filter((a) => a.tier === "main" && a.verdict_score !== null).sort(
    (a, b) => (b.verdict_score ?? -Infinity) - (a.verdict_score ?? -Infinity),
  );
  ranked.forEach((a, i) => {
    a.rank = i + 1;
  });
}

const AGENT_BY_SLUG = new Map(AGENTS.map((a) => [a.slug, a] as const));
const AGENT_BY_ID = new Map(AGENTS.map((a) => [a.agent_id, a] as const));

/* ── Markets ────────────────────────────────────────────────────────── */

interface MockMarket {
  market_id: string;
  asset_id: string;
  market_kind: string;
  horizon_seconds: number;
  primary_oracle_id: string;
  fallback_oracle_id: string | null;
  void_band: string;
  status: "listed" | "frozen";
  market_config_version: number;
  market_family: string;
  resolution_class: "price_direction" | "event_binary";
  label: string;
  support_status: "live" | "reserved";
  payoff_model: "binary" | "categorical";
  settlement_model: "price_oracle" | "venue_adapter";
}

const MARKET_DEFS: ReadonlyArray<readonly [string, string, number]> = [
  // [asset symbol, base asset_id, horizon_seconds]
  ["ETH", "base:ETH:USD", 60 * 60],
  ["ETH", "base:ETH:USD", 60 * 60 * 4],
  ["ETH", "base:ETH:USD", 60 * 60 * 24],
  ["BTC", "base:BTC:USD", 60 * 60],
  ["BTC", "base:BTC:USD", 60 * 60 * 4],
  ["SOL", "base:SOL:USD", 60 * 60],
  ["SOL", "base:SOL:USD", 60 * 60 * 4],
  ["OP", "base:OP:USD", 60 * 60 * 4],
  ["ARB", "base:ARB:USD", 60 * 60 * 4],
  ["ETH", "base:ETH:USD", 60 * 60 * 24 * 7], // long-horizon
];

export const MARKETS: MockMarket[] = MARKET_DEFS.map(([sym, asset_id, hsec]) => {
  const hLabel = hsec === 60 * 60
    ? "1h"
    : hsec === 60 * 60 * 4
      ? "4h"
      : hsec === 60 * 60 * 24
        ? "1d"
        : "1w";
  return {
    market_id: `${sym.toLowerCase()}.${hLabel}`,
    asset_id,
    market_kind: "direction_binary",
    horizon_seconds: hsec,
    primary_oracle_id: "chainlink",
    fallback_oracle_id: "pyth",
    void_band: "0.0008",
    status: "listed",
    market_config_version: 4,
    market_family: "native-price",
    resolution_class: "price_direction",
    label: "Price Direction",
    support_status: "live",
    payoff_model: "binary",
    settlement_model: "price_oracle",
  } satisfies MockMarket;
});

// Add a couple of event_binary entries so the markets taxonomy shows variety.
MARKETS.push({
  market_id: "eth.merge-anniv",
  asset_id: "base:ETH:USD",
  market_kind: "event_binary",
  horizon_seconds: 60 * 60 * 24 * 7,
  primary_oracle_id: "chainlink",
  fallback_oracle_id: null,
  void_band: "0.0",
  status: "listed",
  market_config_version: 4,
  market_family: "event",
  resolution_class: "event_binary",
  label: "Event Binary",
  support_status: "live",
  payoff_model: "binary",
  settlement_model: "venue_adapter",
});
MARKETS.push({
  market_id: "btc.halving-q",
  asset_id: "base:BTC:USD",
  market_kind: "event_binary",
  horizon_seconds: 60 * 60 * 24 * 14,
  primary_oracle_id: "chainlink",
  fallback_oracle_id: null,
  void_band: "0.0",
  status: "listed",
  market_config_version: 4,
  market_family: "event",
  resolution_class: "event_binary",
  label: "Event Binary",
  support_status: "live",
  payoff_model: "binary",
  settlement_model: "venue_adapter",
});

export function getMarketRow(m: MockMarket): MarketRow {
  return {
    market_id: m.market_id,
    asset_id: m.asset_id,
    market_kind: m.market_kind,
    horizon_seconds: m.horizon_seconds,
    primary_oracle_id: m.primary_oracle_id,
    fallback_oracle_id: m.fallback_oracle_id,
    void_band: m.void_band,
    status: m.status,
    market_config_version: m.market_config_version,
    market_taxonomy: {
      resolution_class: m.resolution_class,
      label: m.label,
      support_status: m.support_status,
      payoff_model: m.payoff_model,
      settlement_model: m.settlement_model,
      default_scoring_kind: "verdict_v04",
      compatible_market_kinds: [m.market_kind],
      compatible_market_families: [m.market_family],
      compatible_adapters: ["chainlink", "pyth"],
      classification_source: "config",
    },
  };
}

export function getTaxonomyResponse(): MarketTaxonomyResponse {
  return {
    version: 4,
    classes: [
      {
        resolution_class: "price_direction",
        label: "Price Direction",
        support_status: "live",
        payoff_model: "binary",
        settlement_model: "price_oracle",
        default_scoring_kind: "verdict_v04",
        compatible_market_kinds: ["direction_binary"],
        compatible_market_families: ["native-price"],
        compatible_adapters: ["chainlink", "pyth"],
      },
      {
        resolution_class: "event_binary",
        label: "Event Binary",
        support_status: "live",
        payoff_model: "binary",
        settlement_model: "venue_adapter",
        default_scoring_kind: "verdict_v04",
        compatible_market_kinds: ["event_binary"],
        compatible_market_families: ["event"],
        compatible_adapters: ["polymarket"],
      },
      {
        resolution_class: "range_prediction",
        label: "Range Prediction",
        support_status: "reserved",
        payoff_model: "range",
        settlement_model: "price_oracle",
        default_scoring_kind: "verdict_v04",
        compatible_market_kinds: ["range_binary"],
        compatible_market_families: ["native-price"],
        compatible_adapters: ["chainlink"],
      },
    ],
    live_resolution_classes: ["price_direction", "event_binary"],
    reserved_resolution_classes: ["range_prediction"],
  };
}

/* ── Calls ──────────────────────────────────────────────────────────── */

export interface MockCall {
  call_id: string;
  agent_id: string;
  agent_slug: string;
  market_id: string;
  asset_id: string;
  side: "BUY" | "SELL";
  confidence: number;
  horizon_hours: number;
  submitted_at: string;
  accepted_at: string;
  horizon_expiry_at: string;
  outcome: "win" | "loss" | "void" | null;
  call_score: number | null;
  signed_return: string | null;
  resolved_at: string | null;
  commit_hash: string;
  privacy_mode: string;
  strategy_tag: string;
  client_order_id: string;
}

function buildCalls(): MockCall[] {
  const calls: MockCall[] = [];
  const liveAgents = AGENTS.filter((a) => a.slug !== "new-arrival" && a.slug !== "dormant-2");
  for (const a of liveAgents) {
    const total = a.wins + a.losses + a.voids + a.pending;
    if (total === 0) continue;
    for (let i = 0; i < total; i++) {
      const seed = hash32(`call:${a.slug}:${i}`);
      const lrng = makeRng(seed);
      const market = pick(lrng, MARKETS.filter((m) => m.resolution_class === "price_direction"));
      const sym = market.asset_id.split(":")[1];
      const side: "BUY" | "SELL" = lrng() > 0.5 ? "BUY" : "SELL";
      const isPending = i < a.pending;
      const submittedMinutesAgo = isPending
        ? intRange(lrng, 5, 60 * 22)
        : intRange(lrng, 60 * 2, 60 * 24 * 7);
      const horizonHours = market.horizon_seconds / 3600;
      const submittedAt = isoOffset(NOW_MS, -submittedMinutesAgo * 60_000);
      const acceptedAt = isoOffset(NOW_MS, -submittedMinutesAgo * 60_000 + 1500);
      const horizonExpiry = isoOffset(NOW_MS, -(submittedMinutesAgo - horizonHours * 60) * 60_000);

      let outcome: "win" | "loss" | "void" | null = null;
      let resolvedAt: string | null = null;
      let callScore: number | null = null;
      let signedReturn: string | null = null;
      if (!isPending) {
        // Bucket post-pending entries to win/loss/void in proportion.
        const rOutcome = i - a.pending;
        if (rOutcome < a.wins) outcome = "win";
        else if (rOutcome < a.wins + a.losses) outcome = "loss";
        else outcome = "void";
        resolvedAt = horizonExpiry;
        if (outcome === "win") {
          callScore = range(lrng, 0.2, 0.95);
          signedReturn = range(lrng, 0.002, 0.045).toFixed(6);
        } else if (outcome === "loss") {
          callScore = -range(lrng, 0.1, 0.7);
          signedReturn = (-range(lrng, 0.002, 0.04)).toFixed(6);
        } else {
          callScore = 0;
          signedReturn = "0.000000";
        }
      }

      const callIdHex = hexId(`call:${a.slug}:${i}:${SEED.toString(16)}`, 24);
      calls.push({
        call_id: `c_${callIdHex}`,
        agent_id: a.agent_id,
        agent_slug: a.slug,
        market_id: market.market_id,
        asset_id: market.asset_id,
        side,
        confidence: 0.5 + lrng() * 0.45,
        horizon_hours: horizonHours,
        submitted_at: submittedAt,
        accepted_at: acceptedAt,
        horizon_expiry_at: horizonExpiry,
        outcome,
        call_score: callScore,
        signed_return: signedReturn,
        resolved_at: resolvedAt,
        commit_hash: hexId(`commit:${callIdHex}`, 32),
        privacy_mode: "sealed_fhenix",
        strategy_tag: pick(lrng, ["momentum", "mean-reversion", "carry", "vol-burst", "regime-shift"]),
        client_order_id: hexId(`coid:${callIdHex}`, 12),
      });
    }
  }
  // Sort newest first
  calls.sort((a, b) => (b.submitted_at < a.submitted_at ? -1 : 1));
  return calls;
}

export const CALLS: MockCall[] = buildCalls();
const CALLS_BY_ID = new Map(CALLS.map((c) => [c.call_id, c] as const));
const CALLS_BY_AGENT = new Map<string, MockCall[]>();
for (const c of CALLS) {
  const arr = CALLS_BY_AGENT.get(c.agent_slug);
  if (arr) arr.push(c);
  else CALLS_BY_AGENT.set(c.agent_slug, [c]);
}

/* ── Refs / Recruiters ──────────────────────────────────────────────── */

export interface MockRef {
  ref: string;
  total: number;
  agents_touched: number;
  converted: number;
  last_at: string;
  first_at: string;
}

const REF_HANDLES = [
  "timidan",
  "octogon",
  "deccan",
  "rho-2",
  "fhe-fox",
  "base-builder",
  "ozzy_eth",
  "midnight-hare",
  "pyth-sister",
  "chain-watcher",
  "verdict-fan",
  "olas-eric",
  "akilah",
  "synth-x-dev",
  "nodewalker",
  "merkle-tess",
  "open-anvil",
  "lure",
  "tako-9",
  "kalimba",
];

export const REFS: MockRef[] = REF_HANDLES.map((handle, i) => {
  const rseed = hash32(`ref:${handle}`);
  const lrng = makeRng(rseed);
  const total = intRange(lrng, 4, 240);
  const converted = Math.min(total, intRange(lrng, 0, Math.max(1, Math.round(total * 0.18))));
  const agents = Math.min(20, Math.max(1, intRange(lrng, 1, 9)));
  const lastMin = intRange(lrng, 5, 60 * 24 * 5);
  const firstMin = lastMin + intRange(lrng, 60 * 24 * 2, 60 * 24 * 30);
  return {
    ref: handle,
    total,
    agents_touched: agents,
    converted,
    last_at: isoOffset(NOW_MS, -lastMin * 60_000),
    first_at: isoOffset(NOW_MS, -firstMin * 60_000),
  };
}).sort((a, b) => b.total - a.total);

/* ── Account agents (for the logged-in mock user) ──────────────────── */

const ACCOUNT_AGENT_SLUGS = ["murmur-alpha", "vega-002", "luminol", "nimble-rho", "ember-q"] as const;

export const ACCOUNT_AGENTS: AccountAgent[] = ACCOUNT_AGENT_SLUGS.map((slug, i) => {
  const a = AGENT_BY_SLUG.get(slug);
  if (!a) throw new Error(`account agent ${slug} missing`);
  const linkedMin = intRange(makeRng(hash32(`linked:${slug}`)), 60 * 24 * 3, 60 * 24 * 45);
  return {
    agent_id: a.agent_id,
    linked_at: isoOffset(NOW_MS, -linkedMin * 60_000),
    display_slug: a.slug,
    display_name: a.display_name,
    kind: a.kind,
    wallet_address: a.wallet,
    chain_id: a.chain_id,
    controller_wallet: i === 0
      ? {
        wallet_address: walletFromSlug(`controller:${slug}`),
        chain_id: a.chain_id,
        wallet_kind: "embedded",
        provider: "privy",
        created_at: isoOffset(NOW_MS, -linkedMin * 60_000),
        last_attested_at: isoOffset(NOW_MS, -60_000 * 60 * 24),
        reattestation_due_at: isoOffset(NOW_MS, 60_000 * 60 * 24 * 28),
        reattestation_overdue: false,
        reattestation_interval_seconds: 60 * 60 * 24 * 30,
      }
      : null,
    destination_address: i === 0 ? walletFromSlug(`payout:${slug}`) : null,
    destination_address_updated_at: i === 0 ? isoOffset(NOW_MS, -60_000 * 60 * 24 * 3) : null,
  };
});

/* ── API key list per account agent ────────────────────────────────── */

export const API_KEYS: Record<string, ApiKeyRow[]> = (() => {
  const out: Record<string, ApiKeyRow[]> = {};
  for (const slug of ACCOUNT_AGENT_SLUGS) {
    const lrng = makeRng(hash32(`apikeys:${slug}`));
    const count = intRange(lrng, 1, 3);
    out[slug] = Array.from({ length: count }, (_, i) => {
      const createdMin = intRange(lrng, 60 * 24, 60 * 24 * 30);
      const rotated = i > 0 && lrng() > 0.5;
      return {
        api_key_id: `key_${hexId(`${slug}:key:${i}`, 12)}`,
        created_at: isoOffset(NOW_MS, -createdMin * 60_000),
        label: i === 0 ? "primary" : `secondary-${i}`,
        rotated_at: rotated ? isoOffset(NOW_MS, -intRange(lrng, 60, 60 * 24 * 7) * 60_000) : null,
      };
    });
  }
  return out;
})();

/* ── Derived: leaderboard rows ─────────────────────────────────────── */

export function getLeaderboardRows(): LeaderboardRow[] {
  return AGENTS.map((a) => ({
    agent_id: a.agent_id,
    display_slug: a.slug,
    display_name: a.display_name,
    kind: a.kind,
    tier: a.tier,
    rank: a.rank,
    verdict_score: a.verdict_score,
    resolved_calls: a.resolved_calls,
    win_rate: a.win_rate,
    pending_calls: a.pending,
    last_resolved_at: a.last_resolved_at,
  })).sort((a, b) => {
    // Main-tier rank first, then score desc with nulls last.
    if (a.rank !== null && b.rank === null) return -1;
    if (a.rank === null && b.rank !== null) return 1;
    if (a.rank !== null && b.rank !== null) return a.rank - b.rank;
    return (b.verdict_score ?? -Infinity) - (a.verdict_score ?? -Infinity);
  });
}

/* ── Profile helpers ───────────────────────────────────────────────── */

export function getAgentProfile(slug: string): AgentProfile | null {
  const a = AGENT_BY_SLUG.get(slug);
  if (!a) return null;
  return {
    agent_id: a.agent_id,
    display_slug: a.slug,
    display_name: a.display_name,
    kind: a.kind,
    bio: a.bio,
    created_at: a.created_at,
    wallet_address: a.wallet,
    chain_id: a.chain_id,
  };
}

export function getAgentCalls(slug: string, limit: number): AgentCallRow[] {
  const list = CALLS_BY_AGENT.get(slug) ?? [];
  return list.slice(0, limit).map((c) => ({
    call_id: c.call_id,
    status: c.outcome ? "resolved" : "accepted",
    privacy_mode: c.privacy_mode,
    commit_hash: c.commit_hash,
    acceptance_receipt_hash: null,
    asset_id: c.asset_id,
    side: c.side,
    horizon_hours: c.horizon_hours,
    confidence: c.confidence,
    submitted_at: c.submitted_at,
    accepted_at: c.accepted_at,
    outcome: c.outcome,
    call_score: c.call_score,
    signed_return: c.signed_return,
    resolved_at: c.resolved_at,
  }));
}

export function getCallById(call_id: string): FullCall | null {
  const c = CALLS_BY_ID.get(call_id);
  if (!c) return null;
  const t0Offset = -((Date.parse(c.submitted_at) - NOW_MS) / 1000);
  return {
    submission: {
      call_id: c.call_id,
      agent_id: c.agent_id,
      client_order_id: c.client_order_id,
      privacy_mode: c.privacy_mode,
      commit_hash: c.commit_hash,
      asset_id: c.asset_id,
      side: c.side,
      horizon_hours: c.horizon_hours,
      confidence: c.confidence,
      submitted_at: c.submitted_at,
      accepted_at: c.accepted_at,
      status: c.outcome ? "resolved" : "accepted",
      rationale: null,
      strategy_tag: c.strategy_tag,
    },
    t0: {
      t0: c.accepted_at,
      p0: (2_000 + (hash32(c.market_id + ":p0") % 1500) + (t0Offset % 7)).toFixed(2),
      feed: c.market_id.startsWith("eth")
        ? "chainlink/ETH-USD"
        : c.market_id.startsWith("btc")
          ? "chainlink/BTC-USD"
          : "chainlink/" + c.market_id.split(".")[0].toUpperCase() + "-USD",
    },
    resolution: c.outcome
      ? {
        t1: c.resolved_at ?? c.horizon_expiry_at,
        p1: (
          2_000
          + (hash32(c.market_id + ":p1") % 1500)
          + (c.outcome === "win" ? 18 : c.outcome === "loss" ? -22 : 0)
        ).toFixed(2),
        t1_feed: c.market_id.startsWith("eth")
          ? "chainlink/ETH-USD"
          : c.market_id.startsWith("btc")
            ? "chainlink/BTC-USD"
            : "chainlink/" + c.market_id.split(".")[0].toUpperCase() + "-USD",
        signed_return: c.signed_return ?? "0.000000",
        outcome: c.outcome,
        call_score: c.call_score,
        resolved_at: c.resolved_at ?? c.horizon_expiry_at,
      }
      : null,
  };
}

/* ── Today feed ────────────────────────────────────────────────────── */

export function getTodayFeed(): TodayFeed {
  const accepted = CALLS.slice(0, 40);
  const pending = CALLS.filter((c) => c.outcome === null).slice(0, 40);
  const resolved = CALLS.filter((c) => c.outcome !== null)
    .slice()
    .sort((a, b) => (b.resolved_at ?? "").localeCompare(a.resolved_at ?? ""))
    .slice(0, 40);
  const totalAccepted24h = CALLS.filter(
    (c) => Date.parse(c.accepted_at) > NOW_MS - 24 * 60 * 60 * 1000,
  ).length;
  const totalResolved24h = CALLS.filter(
    (c) => c.resolved_at && Date.parse(c.resolved_at) > NOW_MS - 24 * 60 * 60 * 1000,
  ).length;
  const wins24h = CALLS.filter(
    (c) => c.outcome === "win" && c.resolved_at && Date.parse(c.resolved_at) > NOW_MS - 24 * 60 * 60 * 1000,
  ).length;
  const losses24h = CALLS.filter(
    (c) => c.outcome === "loss" && c.resolved_at && Date.parse(c.resolved_at) > NOW_MS - 24 * 60 * 60 * 1000,
  ).length;
  const void24h = CALLS.filter(
    (c) => c.outcome === "void" && c.resolved_at && Date.parse(c.resolved_at) > NOW_MS - 24 * 60 * 60 * 1000,
  ).length;

  const movers: TodayMover[] = AGENTS.filter((a) => a.rank !== null)
    .slice(0, 8)
    .map((a) => {
      const lrng = makeRng(hash32(`mover:${a.slug}`));
      return {
        agent_id: a.agent_id,
        agent_slug: a.slug,
        display_name: a.display_name,
        rank: a.rank,
        verdict_score: a.verdict_score,
        delta_24h_calls: intRange(lrng, 0, 12),
        delta_24h_wins: intRange(lrng, 0, 7),
      };
    });

  const toRow = (c: MockCall): TodayFeedRow => {
    const a = AGENT_BY_ID.get(c.agent_id);
    return {
      call_id: c.call_id,
      agent_id: c.agent_id,
      agent_slug: c.agent_slug,
      agent_kind: a?.kind ?? "agent",
      privacy_mode: c.privacy_mode,
      commit_hash: c.commit_hash,
      acceptance_receipt_hash: null,
      side: c.side,
      asset_id: c.asset_id,
      horizon_hours: c.horizon_hours,
      confidence: c.confidence,
      submitted_at: c.submitted_at,
      accepted_at: c.accepted_at,
      status: c.outcome ? "resolved" : "accepted",
      outcome: c.outcome,
      signed_return: c.signed_return,
      call_score: c.call_score,
      resolved_at: c.resolved_at,
      t1_estimate: c.horizon_expiry_at,
    };
  };

  return {
    schema_version: 1,
    served_at: isoOffset(NOW_MS, 0),
    accepted_recent: accepted.map(toRow),
    pending_resolution: pending.map(toRow),
    resolved_recent: resolved.map(toRow),
    movers,
    totals: {
      accepted_24h: totalAccepted24h,
      resolved_24h: totalResolved24h,
      wins_24h: wins24h,
      losses_24h: losses24h,
      void_24h: void24h,
    },
  };
}

/* ── Per-market leaderboard ────────────────────────────────────────── */

export function getMarketLeaderboard(market_id: string, limit = 50): AgentMarketRow[] {
  // Bucket agents to the market by hashing — gives every market a
  // realistic-looking ladder without overlap chaos. Resolve counts derive
  // from the agent's overall resolution count, scaled down.
  const candidates = AGENTS.filter(
    (a) => a.resolved_calls > 0 && hash32(`${a.slug}:${market_id}`) % 5 !== 0,
  );
  return candidates
    .map((a): AgentMarketRow => {
      const lrng = makeRng(hash32(`${a.slug}:${market_id}`));
      const share = 0.2 + lrng() * 0.6;
      const resolved = Math.max(1, Math.round(a.resolved_calls * share));
      const wins = Math.round(resolved * (a.win_rate ?? 0.5));
      const winRate = resolved === 0 ? null : wins / resolved;
      const verdict = a.verdict_score === null ? null : a.verdict_score + (lrng() - 0.5) * 0.12;
      const verdictLb = verdict === null ? null : verdict - 0.05 - lrng() * 0.04;
      return {
        agent_id: a.agent_id,
        display_slug: a.slug,
        display_name: a.display_name,
        kind: a.kind,
        market_id,
        verdict_score: verdict,
        verdict_score_lb: verdictLb,
        resolved_calls: resolved,
        pending_calls: Math.min(a.pending, intRange(lrng, 0, 3)),
        win_rate: winRate,
        last_resolved_at: a.last_resolved_at,
        market_main_tier: resolved >= 20,
      };
    })
    .sort((a, b) => (b.verdict_score ?? -Infinity) - (a.verdict_score ?? -Infinity))
    .slice(0, limit);
}

export function getAgentGrid(slug: string): { agent: AgentGridSummary; grid: AgentMarketRow[] } | null {
  const a = AGENT_BY_SLUG.get(slug);
  if (!a) return null;
  const grid = MARKETS.slice(0, 8)
    .map((m): AgentMarketRow => {
      const lrng = makeRng(hash32(`${slug}:grid:${m.market_id}`));
      const resolved = intRange(lrng, 0, Math.max(1, Math.round(a.resolved_calls * 0.2)));
      const wins = Math.round(resolved * (a.win_rate ?? 0.5));
      const winRate = resolved === 0 ? null : wins / resolved;
      const verdict = a.verdict_score === null
        ? null
        : a.verdict_score + (lrng() - 0.5) * 0.15;
      return {
        agent_id: a.agent_id,
        display_slug: a.slug,
        display_name: a.display_name,
        kind: a.kind,
        market_id: m.market_id,
        verdict_score: verdict,
        verdict_score_lb: verdict === null ? null : verdict - 0.06,
        resolved_calls: resolved,
        pending_calls: intRange(lrng, 0, 2),
        win_rate: winRate,
        last_resolved_at: a.last_resolved_at,
        market_main_tier: resolved >= 20,
      };
    })
    .filter((r) => r.resolved_calls > 0 || r.pending_calls > 0);
  return {
    agent: {
      agent_id: a.agent_id,
      display_slug: a.slug,
      display_name: a.display_name,
      kind: a.kind,
    },
    grid,
  };
}

/* ── Family leaderboards (cross-family + per-family) ───────────────── */

const FAMILIES = ["native-price", "event"] as const;

export function getFamilies(): {
  families: Array<{ market_family: string; submissions: number; resolved: number }>;
} {
  return {
    families: FAMILIES.map((f) => ({
      market_family: f,
      submissions: f === "native-price" ? 2100 : 240,
      resolved: f === "native-price" ? 1800 : 180,
    })),
  };
}

export function getFamilyLeaderboard(family: string, limit = 50): AgentFamilyRow[] {
  return AGENTS.filter((a) => a.resolved_calls >= 5)
    .map((a): AgentFamilyRow => {
      const lrng = makeRng(hash32(`${a.slug}:family:${family}`));
      const resolved = Math.max(5, Math.round(a.resolved_calls * (family === "native-price" ? 0.8 : 0.2)));
      const verdict = a.verdict_score === null ? null : a.verdict_score + (lrng() - 0.5) * 0.1;
      return {
        agent_id: a.agent_id,
        display_slug: a.slug,
        display_name: a.display_name,
        kind: a.kind,
        market_family: family,
        verdict_score: verdict,
        verdict_score_lb: verdict === null ? null : verdict - 0.05,
        resolved_calls: resolved,
        pending_calls: a.pending,
        win_rate: a.win_rate,
        last_resolved_at: a.last_resolved_at,
        family_main_tier: resolved >= 20,
        distinct_markets: intRange(lrng, 1, 5),
      };
    })
    .sort((a, b) => (b.verdict_score ?? -Infinity) - (a.verdict_score ?? -Infinity))
    .slice(0, limit);
}

/* ── Meta ──────────────────────────────────────────────────────────── */

export function getMeta(): MetaResponse {
  return {
    schema_version: 2,
    scoring_version: 4,
    strategy_tags: ["momentum", "mean-reversion", "carry", "vol-burst", "regime-shift"],
    assets: ["ETH", "BTC", "SOL", "OP", "ARB"],
    verified_volume_24h: { count: 2_417, since_iso: isoOffset(NOW_MS, -24 * 60 * 60 * 1000) },
    privacy: {
      mode: "sealed_fhenix",
      threshold_network: "fhenix-helium",
      pending_verdicts_private: true,
      public_reveal_after_horizon: true,
    },
  };
}

/* ── Discoverers (per-agent attribution) ───────────────────────────── */

export function getDiscoverers(slug: string, limit: number) {
  const lrng = makeRng(hash32(`disc:${slug}`));
  const count = Math.min(limit, intRange(lrng, 0, 6));
  return Array.from({ length: count }, (_, i) => {
    const refRef = REFS[(hash32(`${slug}:${i}`) % REFS.length)];
    return {
      ref: refRef.ref,
      agent_slug: slug,
      total: intRange(lrng, 1, 18),
      first_at: refRef.first_at,
      last_at: refRef.last_at,
    };
  });
}

/* ── Now-MS getter so other modules sync time ──────────────────────── */

export const MOCK_NOW_MS = NOW_MS;

/* ── Mutators (called by api-mock writes; emit events) ─────────────── */

export function mutateMintApiKey(slug: string, label?: string): ApiKeyRow {
  const id = `key_${hexId(`mint:${slug}:${Date.now()}`, 12)}`;
  const row: ApiKeyRow = {
    api_key_id: id,
    created_at: new Date().toISOString(),
    label: label ?? "minted",
    rotated_at: null,
  };
  const arr = API_KEYS[slug] ?? (API_KEYS[slug] = []);
  arr.unshift(row);
  return row;
}

export function mutateRotateApiKey(key_id: string): boolean {
  for (const list of Object.values(API_KEYS)) {
    const row = list.find((k) => k.api_key_id === key_id);
    if (row) {
      if (row.rotated_at) return false;
      row.rotated_at = new Date().toISOString();
      return true;
    }
  }
  return false;
}

export function mutateCreateAgent(slug: string, displayName: string, bio?: string): MockAgent {
  // Inject a fresh account-owned agent. Doesn't get rank because pending=0.
  const a = buildAgent(slug, displayName, "agent", bio, AGENTS.length);
  AGENTS.push(a);
  AGENT_BY_SLUG.set(slug, a);
  AGENT_BY_ID.set(a.agent_id, a);
  return a;
}

export function pushPendingCall(agentSlug: string): MockCall | null {
  const a = AGENT_BY_SLUG.get(agentSlug);
  if (!a) return null;
  const lrng = makeRng(hash32(`live:${agentSlug}:${CALLS.length}`));
  const market = pick(lrng, MARKETS.filter((m) => m.resolution_class === "price_direction"));
  const side: "BUY" | "SELL" = lrng() > 0.5 ? "BUY" : "SELL";
  const call: MockCall = {
    call_id: `c_${hexId(`live:${agentSlug}:${CALLS.length}:${Date.now()}`, 24)}`,
    agent_id: a.agent_id,
    agent_slug: a.slug,
    market_id: market.market_id,
    asset_id: market.asset_id,
    side,
    confidence: 0.5 + lrng() * 0.4,
    horizon_hours: market.horizon_seconds / 3600,
    submitted_at: new Date().toISOString(),
    accepted_at: new Date().toISOString(),
    horizon_expiry_at: new Date(Date.now() + market.horizon_seconds * 1000).toISOString(),
    outcome: null,
    call_score: null,
    signed_return: null,
    resolved_at: null,
    commit_hash: hexId(`commit:live:${agentSlug}:${CALLS.length}`, 32),
    privacy_mode: "sealed_fhenix",
    strategy_tag: pick(lrng, ["momentum", "carry"]),
    client_order_id: hexId(`coid:${agentSlug}:${Date.now()}`, 12),
  };
  CALLS.unshift(call);
  CALLS_BY_ID.set(call.call_id, call);
  const arr = CALLS_BY_AGENT.get(agentSlug) ?? [];
  arr.unshift(call);
  CALLS_BY_AGENT.set(agentSlug, arr);
  a.pending += 1;
  return call;
}

export function maybeResolvePending(): MockCall | null {
  const pending = CALLS.find((c) => c.outcome === null);
  if (!pending) return null;
  const lrng = makeRng(hash32(`resolve:${pending.call_id}`));
  const r = lrng();
  const outcome: "win" | "loss" | "void" = r < 0.55 ? "win" : r < 0.9 ? "loss" : "void";
  pending.outcome = outcome;
  pending.resolved_at = new Date().toISOString();
  pending.call_score = outcome === "win"
    ? range(lrng, 0.2, 0.9)
    : outcome === "loss"
      ? -range(lrng, 0.1, 0.7)
      : 0;
  pending.signed_return = outcome === "win"
    ? range(lrng, 0.002, 0.04).toFixed(6)
    : outcome === "loss"
      ? (-range(lrng, 0.002, 0.04)).toFixed(6)
      : "0.000000";
  const a = AGENT_BY_ID.get(pending.agent_id);
  if (a) {
    a.pending = Math.max(0, a.pending - 1);
    if (outcome === "win") a.wins += 1;
    else if (outcome === "loss") a.losses += 1;
    else a.voids += 1;
    a.resolved_calls = a.wins + a.losses + a.voids;
    a.last_resolved_at = pending.resolved_at;
  }
  return pending;
}

/* ── Exports the stream mock uses ──────────────────────────────────── */

export function pickLiveAgentSlug(salt: number): string {
  const list = AGENTS.filter((a) => a.kind !== "internal_test" && a.slug !== "dormant-2");
  return list[salt % list.length].slug;
}

export const __counts__ = {
  agents: AGENTS.length,
  calls: CALLS.length,
  markets: MARKETS.length,
  refs: REFS.length,
  account_agents: ACCOUNT_AGENTS.length,
};
