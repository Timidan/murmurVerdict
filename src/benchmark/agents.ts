import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { agentsRepo } from "../verdict/db.js";
import { submitCall } from "../verdict/submissions.js";
import {
  AssetId,
  HorizonHours,
  REGISTERED_STRATEGY_TAGS,
  SCHEMA_VERSION,
  Side,
  StrategyTag,
  SubmittedCall,
} from "../verdict/schema.js";
import type { OracleClient, OracleObservation } from "../integrations/oracle.js";
import type { OracleFeed } from "../verdict/schema.js";
import {
  PriceHistory,
  pctChange,
  realizedVol,
  type PriceLookup,
} from "./price-history.js";

// ─── Baseline agent definitions ──────────────────────────────────────────────
//
// Wave 4c-A — re-armed after the Wave 4b-2 dormant interlude. Each baseline
// derives its decision from the same Chainlink/Pyth ETH-USD feeds the
// resolver consumes, so there's no parallel oracle path to keep in sync.
// The signal logic intentionally stays simple (a few percent-change /
// stdev checks) — the leaderboard's job is to show how well agents beat
// dumb baselines, not to make the baselines hard to beat.

export interface BaselineDef {
  display_slug: string;
  display_name: string;
  bio: string;
  strategy_tag: StrategyTag;
  /** Signal evaluator. Returns null when the signal is silent this tick. */
  evaluate: (input: SignalInput) => SignalDecision | null;
  /** Horizon used for both the submission and dedup-bucket math. */
  horizon_hours: Extract<HorizonHours, 1 | 4 | 24 | 168>;
}

export interface SignalInput {
  asset_id: AssetId;
  /** The price observation captured this tick (already recorded into history). */
  current: OracleObservation;
  history: PriceHistory;
  now: Date;
}

export interface SignalDecision {
  side: Side;
  /** Pre-clamp confidence. Caller clamps into [0.51, 0.95] before submit. */
  confidence: number;
}

const MOMENTUM: BaselineDef = {
  display_slug: "murmur-momentum",
  display_name: "Murmur Momentum",
  bio: "Deterministic momentum baseline. Compares the live ETH-USD price to a sample taken ~4h ago and BUYs the trend / SELLs the fade when the move clears a 0.1% noise band. Source feeds match the resolver (Chainlink primary, Pyth fallback).",
  strategy_tag: "momentum",
  horizon_hours: 4,
  evaluate: ({ asset_id, current, history, now }) => {
    const ref = bestRef(history, asset_id, current.feed_timestamp, 4, 1.5, now);
    if (!ref) return null;
    const change = pctChange(ref.sample.price, current.price);
    if (change === null) return null;
    if (Math.abs(change) < 0.001) return null; // 0.1% noise band
    return {
      side: change > 0 ? "BUY" : "SELL",
      confidence: Math.abs(change) * 50,
    };
  },
};

const CONTRARIAN: BaselineDef = {
  display_slug: "murmur-contrarian",
  display_name: "Murmur Contrarian",
  bio: "Deterministic euphoria-fade baseline. Compares the live ETH-USD price to a sample taken ~24h ago and fades any move beyond 0.5%: BUY into a sustained drop, SELL into a sustained rip. Source feeds match the resolver.",
  strategy_tag: "fade",
  horizon_hours: 24,
  evaluate: ({ asset_id, current, history, now }) => {
    const ref = bestRef(history, asset_id, current.feed_timestamp, 24, 4, now);
    if (!ref) return null;
    const change = pctChange(ref.sample.price, current.price);
    if (change === null) return null;
    if (Math.abs(change) < 0.005) return null; // 0.5% fade threshold
    return {
      // Fade the move: drop → BUY, rip → SELL
      side: change < 0 ? "BUY" : "SELL",
      confidence: Math.abs(change) * 30,
    };
  },
};

// Per-tick stdev threshold for the Risk-Off baseline. At a 10-minute
// cadence this maps to a per-tick log-return stdev — 0.3% per 10min is
// roughly a 1.6% hourly vol, a sensible "things are choppy" line for ETH.
const RISK_OFF_VOL_THRESHOLD = 0.003;

const RISK_OFF: BaselineDef = {
  display_slug: "murmur-risk-off",
  display_name: "Murmur Risk-Off",
  bio: "Deterministic risk-off baseline. Computes realized volatility from the trailing ~4h of ETH-USD samples; SELLs (de-risks) when per-tick stdev clears 0.3%, BUYs (low conviction) when realized vol is benign. Skips ticks until the in-process buffer warms up.",
  strategy_tag: "macro",
  horizon_hours: 4,
  evaluate: ({ asset_id, history, now }) => {
    const samples = history.samples(asset_id);
    const vol = realizedVol(samples, 4, 6, now);
    if (vol === null) return null; // cold start — skip until buffer warms
    if (vol >= RISK_OFF_VOL_THRESHOLD) {
      // Confidence scales with how far above the threshold we are; capped
      // by the [0.51, 0.95] clamp downstream.
      const ratio = vol / RISK_OFF_VOL_THRESHOLD;
      return { side: "SELL", confidence: 0.5 + (ratio - 1) * 0.5 };
    }
    // Vol below threshold → mild risk-on bias.
    return { side: "BUY", confidence: 0.55 };
  },
};

export const DEFAULT_BASELINES: readonly BaselineDef[] = [
  MOMENTUM,
  CONTRARIAN,
  RISK_OFF,
] as const;

// ─── Driver ──────────────────────────────────────────────────────────────────

export interface BenchmarkRunDeps {
  db: Database.Database;
  baselines?: readonly BaselineDef[];
  /** Override for tests; default new Date(). */
  now?: () => Date;
  /** Test injection: if provided, we use this instead of submitCall. */
  submit?: typeof submitCall;
  /**
   * Wave 4c-A — OracleClient carrying the live price feeds. Daemon passes
   * its existing instance (the same one the resolver uses), so baselines
   * never construct a parallel HTTP/RPC pool. When undefined (e.g. local
   * dev with BASE_MAINNET_RPC_URL unset), the run no-ops gracefully.
   */
  oracle?: OracleClient;
  /**
   * Override the in-process price-history ring buffer (for tests). The
   * daemon shares ONE instance across ticks via module-scoped state below.
   */
  history?: PriceHistory;
  /**
   * Assets the baselines act on. Defaults to ['base:ETH:USD'] — the only
   * pair with a registered legacy market AND oracle policy today. Extending
   * to BTC/SOL/BNB requires nothing here beyond appending entries.
   */
  assets?: readonly AssetId[];
}

export interface BenchmarkRunReport {
  considered: number;
  submitted: number;
  silent: number;
  skipped_dedup: number;
  errors: Array<{ slug: string; reason: string }>;
}

const DEFAULT_ASSETS: readonly AssetId[] = ["base:ETH:USD"] as const;
const ASSET_FEED_PRIMARY: Record<AssetId, OracleFeed | undefined> = {
  "base:ETH:USD": "chainlink:base:ETH-USD",
  "base:BTC:USD": "chainlink:base:BTC-USD",
  "base:SOL:USD": "chainlink:base:SOL-USD",
  "base:BNB:USD": undefined, // no Chainlink feed registered; Pyth-only
};
const ASSET_FEED_FALLBACK: Record<AssetId, OracleFeed | undefined> = {
  "base:ETH:USD": "pyth:base:ETH-USD",
  "base:BTC:USD": "pyth:base:BTC-USD",
  "base:SOL:USD": "pyth:base:SOL-USD",
  "base:BNB:USD": "pyth:base:BNB-USD",
};

// Module-scoped buffer so consecutive ticks accumulate samples across the
// lifetime of the daemon process. Cleared automatically on restart — that's
// the documented baseline behavior (cold-start until the next 24h of ticks).
const SHARED_HISTORY = new PriceHistory();

/**
 * Ensure all baselines exist as agents in the DB. Idempotent.
 */
export function registerBaselines(
  db: Database.Database,
  baselines: readonly BaselineDef[] = DEFAULT_BASELINES,
): void {
  for (const b of baselines) {
    if (agentsRepo.bySlug(db, b.display_slug)) continue;
    agentsRepo.insert(db, {
      agent_id: randomUUID(),
      display_slug: b.display_slug,
      kind: "benchmark",
      display_name: b.display_name,
      bio: b.bio,
      verified_identities: [],
      created_at: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
    });
  }
}

/**
 * Wave 4c-A — live decision logic. Per supported asset:
 *   1. Fetch latest price (Chainlink primary, Pyth fallback).
 *   2. Append to the shared ring buffer.
 *   3. For each baseline, evaluate its rule and (maybe) submit a call.
 * Each baseline emits at most one call per asset per horizon-bucket via
 * submitCall's existing client_order_id idempotency.
 */
export async function runBaselinesOnce(
  deps: BenchmarkRunDeps,
): Promise<BenchmarkRunReport> {
  const baselines = deps.baselines ?? DEFAULT_BASELINES;
  const assets = deps.assets ?? DEFAULT_ASSETS;
  const submit = deps.submit ?? submitCall;
  const history = deps.history ?? SHARED_HISTORY;
  const now = deps.now ?? (() => new Date());

  const report: BenchmarkRunReport = {
    considered: 0,
    submitted: 0,
    silent: 0,
    skipped_dedup: 0,
    errors: [],
  };

  if (!deps.oracle) {
    // No oracle wired — daemon dev mode (BASE_MAINNET_RPC_URL unset).
    // Stay silent rather than crash; the resolver behaves identically.
    return report;
  }

  for (const asset_id of assets) {
    let observation: OracleObservation;
    try {
      observation = await fetchPriceWithFallback(deps.oracle, asset_id);
    } catch (err) {
      report.errors.push({
        slug: `oracle:${asset_id}`,
        reason: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    history.record(asset_id, observation.price, observation.feed_timestamp);

    for (const baseline of baselines) {
      report.considered++;
      const agent = agentsRepo.bySlug(deps.db, baseline.display_slug);
      if (!agent) {
        report.errors.push({
          slug: baseline.display_slug,
          reason: "agent row missing — registerBaselines was not called",
        });
        continue;
      }
      let decision: SignalDecision | null;
      try {
        decision = baseline.evaluate({
          asset_id,
          current: observation,
          history,
          now: now(),
        });
      } catch (err) {
        report.errors.push({
          slug: baseline.display_slug,
          reason: `evaluate threw: ${err instanceof Error ? err.message : String(err)}`,
        });
        continue;
      }
      if (!decision) {
        report.silent++;
        continue;
      }
      const confidence = clampConfidence(decision.confidence);
      const tickBucket = horizonBucket(now(), baseline.horizon_hours);
      const client_order_id = `${baseline.display_slug}-${asset_id}-${tickBucket}`.slice(
        0,
        128,
      );
      const payload: SubmittedCall = {
        schema_version: SCHEMA_VERSION,
        agent_id: agent.agent_id,
        client_order_id,
        asset_id,
        side: decision.side,
        horizon_hours: baseline.horizon_hours,
        confidence,
        submitted_at: now().toISOString().replace(/\.\d+Z$/, "Z"),
        strategy_tag: baseline.strategy_tag,
      };
      try {
        const result = await submit({
          db: deps.db,
          ctx: { now },
          identity: { agent_id: agent.agent_id },
          payload,
        });
        if (result.idempotent_hit) {
          report.skipped_dedup++;
        } else {
          report.submitted++;
        }
      } catch (err) {
        report.errors.push({
          slug: baseline.display_slug,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  return report;
}

// ─── helpers ─────────────────────────────────────────────────────────────────

/**
 * Look up the closest reference sample to `target_age_hours` ago, anchored
 * on the CURRENT observation's feed_timestamp rather than wall-clock now.
 * Anchoring on the oracle clock keeps the signal stable when the daemon
 * tick lags briefly. The freshest sample (just-recorded `current`) sits at
 * age ≈ 0h and is naturally excluded by the [target − tol, target + tol]
 * window — `target_age_hours` is the lookback distance, not an offset.
 */
function bestRef(
  history: PriceHistory,
  asset_id: AssetId,
  current_ts: string,
  target_age_hours: number,
  tolerance_hours: number,
  now: Date,
): PriceLookup | null {
  void now; // oracle clock is authoritative; wall-clock fallback unused
  const oracleNow = new Date(Date.parse(current_ts));
  return history.lookup(asset_id, target_age_hours, tolerance_hours, oracleNow);
}

async function fetchPriceWithFallback(
  oracle: OracleClient,
  asset_id: AssetId,
): Promise<OracleObservation> {
  const primary = ASSET_FEED_PRIMARY[asset_id];
  const fallback = ASSET_FEED_FALLBACK[asset_id];
  if (primary) {
    try {
      return await oracle.getLatestPrice(primary);
    } catch (primaryErr) {
      if (!fallback) throw primaryErr;
      try {
        return await oracle.getLatestPrice(fallback);
      } catch (fallbackErr) {
        const primaryMsg =
          primaryErr instanceof Error ? primaryErr.message : String(primaryErr);
        const fallbackMsg =
          fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
        throw new Error(
          `both feeds failed for ${asset_id}: primary=${primaryMsg}; fallback=${fallbackMsg}`,
        );
      }
    }
  }
  if (fallback) return oracle.getLatestPrice(fallback);
  throw new Error(`no oracle feed registered for ${asset_id}`);
}

function clampConfidence(raw: number): number {
  if (!Number.isFinite(raw)) return 0.51;
  return Math.min(0.95, Math.max(0.51, raw));
}

/**
 * Bucket index for `now` against `horizon_hours`. The same bucket value
 * within the same horizon window forces submitCall's idempotency path, so
 * baseline retries inside the horizon return the prior accepted call
 * rather than spawning duplicates.
 */
function horizonBucket(now: Date, horizon_hours: number): number {
  const bucketMs = horizon_hours * 3_600_000;
  return Math.floor(now.getTime() / bucketMs);
}

// Strategy-tag invariant guard so removing a tag from REGISTERED_STRATEGY_TAGS
// breaks compilation here (and prevents silent runtime drift).
const _strategyTagsKnown: Record<string, true> = REGISTERED_STRATEGY_TAGS.reduce(
  (acc, t) => ({ ...acc, [t]: true }),
  {} as Record<string, true>,
);
void _strategyTagsKnown;
