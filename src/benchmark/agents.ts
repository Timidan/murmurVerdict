import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import {
  agentsRepo,
  buildDedupKey,
  submissionsRepo,
} from "../verdict/db.js";
import type { MarketContext } from "../verdict/risk.js";
import { submitCall } from "../verdict/submissions.js";
import type { SubmissionContext } from "../verdict/submissions.js";
import {
  CONFIDENCE_MAX,
  CONFIDENCE_MIN,
  HorizonHours,
  REGISTERED_STRATEGY_TAGS,
  Side,
  StrategyTag,
  SubmittedCall,
  SCHEMA_VERSION,
  VerdictError,
  ERROR_CODES,
} from "../verdict/schema.js";

// ─── Baseline agent definitions ──────────────────────────────────────────────
// Three deterministic baselines. They are NOT pretending to be independent
// market participants — they are clearly labeled benchmark agents (see
// `agent_kind = "benchmark"`). Their purpose is to make the leaderboard legible
// and set the bar for human-claimed agents.

export interface BaselineDef {
  display_slug: string;
  display_name: string;
  bio: string;
  strategy_tag: StrategyTag;
  /**
   * Decide whether to emit a call given the current market view. Returns null
   * when the baseline has no opinion this tick — letting it stay quiet beats
   * spamming weak calls.
   */
  evaluate: (market: MarketContext, now: Date) => BaselineDecision | null;
}

export interface BaselineDecision {
  side: Side;
  horizon_hours: HorizonHours;
  confidence: number;
  rationale: string;
}

// ── Murmur Momentum ──
// Submits when composite_score and current regime align with the same
// directional bias. Confidence scales with |composite_score|. Horizon = 4h.
export const MOMENTUM: BaselineDef = {
  display_slug: "murmur-momentum",
  display_name: "Murmur Momentum",
  bio: "Deterministic momentum baseline (4h). Aligns side with composite score and regime; confidence scales with score magnitude.",
  strategy_tag: "momentum",
  evaluate(market) {
    if (Math.abs(market.composite_score) < 0.15) return null;
    const side: Side = market.composite_score > 0 ? "BUY" : "SELL";
    const aligned =
      (side === "BUY" && market.regime !== "bearish") ||
      (side === "SELL" && market.regime !== "bullish");
    if (!aligned) return null;
    const confidence = clamp(
      0.55 + Math.min(0.4, Math.abs(market.composite_score) * 0.4),
      CONFIDENCE_MIN,
      CONFIDENCE_MAX,
    );
    return {
      side,
      horizon_hours: 4,
      confidence,
      rationale: `momentum: composite=${market.composite_score.toFixed(2)} aligned with regime=${market.regime}`,
    };
  },
};

// ── Murmur Contrarian ──
// Submits when the top playbook is "euphoria_fade" with composite > 0.25 (i.e.
// crowd is bullish-and-stretched). Direction = SELL. Horizon = 24h to give the
// fade room to play out.
export const CONTRARIAN: BaselineDef = {
  display_slug: "murmur-contrarian",
  display_name: "Murmur Contrarian",
  bio: "Euphoria-fade baseline (24h). SELL when crowd-stretched on a Murmur euphoria_fade signature.",
  strategy_tag: "fade",
  evaluate(market) {
    if (market.top_playbook !== "euphoria_fade") return null;
    if (market.composite_score < 0.25) return null;
    const confidence = clamp(
      0.6 + Math.min(0.3, (market.composite_score - 0.25) * 0.4),
      CONFIDENCE_MIN,
      CONFIDENCE_MAX,
    );
    return {
      side: "SELL",
      horizon_hours: 24,
      confidence,
      rationale: `fade: top_playbook=euphoria_fade, composite=${market.composite_score.toFixed(2)}`,
    };
  },
};

// ── Murmur Risk-Off ──
// SELL whenever Murmur's market regime is bearish and either composite is
// negative OR the top playbook is "capitulation_rebound" (a watch signal we
// fade short-term while accumulation thesis matures). Horizon = 4h so the
// risk-off bias doesn't carry into recovery windows.
export const RISK_OFF: BaselineDef = {
  display_slug: "murmur-risk-off",
  display_name: "Murmur Risk-Off",
  bio: "Risk-off baseline (4h). SELL when regime turns bearish and Murmur conviction agrees.",
  strategy_tag: "macro",
  evaluate(market) {
    if (market.regime !== "bearish") return null;
    if (
      market.composite_score >= 0 &&
      market.top_playbook !== "capitulation_rebound"
    ) {
      return null;
    }
    const confidence = clamp(
      0.6 + Math.min(0.3, Math.abs(market.composite_score) * 0.3),
      CONFIDENCE_MIN,
      CONFIDENCE_MAX,
    );
    return {
      side: "SELL",
      horizon_hours: 4,
      confidence,
      rationale: `risk_off: regime=bearish, composite=${market.composite_score.toFixed(2)}`,
    };
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
  ctx: SubmissionContext;
  baselines?: readonly BaselineDef[];
  /** Override for tests; default new Date(). */
  now?: () => Date;
  /** Test injection: if provided, we use this instead of submitCall. */
  submit?: typeof submitCall;
}

export interface BenchmarkRunReport {
  considered: number;
  submitted: number;
  silent: number;
  skipped_dedup: number;
  errors: Array<{ slug: string; reason: string }>;
}

/**
 * Ensure all baselines exist as agents in the DB. Idempotent.
 */
export function registerBaselines(db: Database.Database, baselines: readonly BaselineDef[] = DEFAULT_BASELINES): void {
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
 * Run all baselines once against current market context. Submits to the same
 * pipeline as external agents, including dedup / rate-limit / risk evaluator.
 */
export async function runBaselinesOnce(deps: BenchmarkRunDeps): Promise<BenchmarkRunReport> {
  const baselines = deps.baselines ?? DEFAULT_BASELINES;
  const now = deps.now ?? (() => new Date());
  const submit = deps.submit ?? submitCall;
  const market = await deps.ctx.marketContext("base:ETH:USD");
  const report: BenchmarkRunReport = {
    considered: baselines.length,
    submitted: 0,
    silent: 0,
    skipped_dedup: 0,
    errors: [],
  };
  for (const b of baselines) {
    const agent = agentsRepo.bySlug(deps.db, b.display_slug);
    if (!agent) {
      report.errors.push({ slug: b.display_slug, reason: "not_registered" });
      continue;
    }
    const decision = b.evaluate(market, now());
    if (!decision) {
      report.silent++;
      continue;
    }
    const submitted_at = now().toISOString().replace(/\.\d+Z$/, "Z");
    const dedup_key = buildDedupKey({
      agent_id: agent.agent_id,
      asset_id: market.asset_id,
      side: decision.side,
      horizon_hours: decision.horizon_hours,
      submitted_at_iso: submitted_at,
    });
    if (submissionsRepo.findByDedupKey(deps.db, dedup_key)) {
      report.skipped_dedup++;
      continue;
    }
    const payload: SubmittedCall = {
      schema_version: SCHEMA_VERSION,
      agent_id: agent.agent_id,
      client_order_id: `${b.display_slug}:${submitted_at}`,
      asset_id: market.asset_id,
      side: decision.side,
      horizon_hours: decision.horizon_hours,
      confidence: decision.confidence,
      submitted_at,
      strategy_tag: b.strategy_tag,
      rationale: decision.rationale,
    };
    try {
      await submit({
        db: deps.db,
        ctx: { ...deps.ctx, now },
        identity: { agent_id: agent.agent_id },
        payload,
      });
      report.submitted++;
    } catch (err) {
      if (err instanceof VerdictError) {
        if (
          err.code === ERROR_CODES.duplicate ||
          err.code === ERROR_CODES.rate_limited
        ) {
          report.skipped_dedup++;
          continue;
        }
        report.errors.push({ slug: b.display_slug, reason: err.code });
      } else {
        report.errors.push({
          slug: b.display_slug,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
  return report;
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

// Strategy-tag invariant guard so removing a tag from REGISTERED_STRATEGY_TAGS
// breaks compilation here (and prevents silent runtime drift).
const _strategyTagsKnown: Record<string, true> = REGISTERED_STRATEGY_TAGS.reduce(
  (acc, t) => ({ ...acc, [t]: true }),
  {} as Record<string, true>,
);
void _strategyTagsKnown;
