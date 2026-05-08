import { fetchUniverse } from "../scout/index.js";
import { normalizeUniverse, scoreUniverse } from "../analyst/index.js";
import type { ScoredAsset } from "../types/index.js";
import type { MarketContext } from "../verdict/risk.js";
import type { AssetId, MarketRegime } from "../verdict/schema.js";

// ─── Asset mapping ────────────────────────────────────────────────────────────
//
// Verdict's asset_id is a chain:asset:quote triple. The legacy analyst still
// keys off Santiment slugs. We map between them in exactly one place.

// P3 Phase 1.5: AssetIdSchema now covers ETH/BTC/SOL/BNB but only ETH has
// an analyst pipeline today. Partial map keeps the type honest — iterating
// Object.keys gives us only the assets we actually fetch context for. The
// value type stays narrow so fetchUniverse's `assets: <slug-union>[]`
// signature still typechecks.
const VERDICT_TO_SANTIMENT: Partial<Record<AssetId, "ethereum">> = {
  "base:ETH:USD": "ethereum",
};

// ─── Provider ────────────────────────────────────────────────────────────────

export interface MarketContextProviderOpts {
  santimentApiKey?: string;
  /** Refresh interval in ms. Default 5 min. */
  refreshIntervalMs?: number;
  /** Window size for analyst normalization. Default 30 days. */
  windowDays?: number;
  now?: () => Date;
}

export class MarketContextProvider {
  private readonly santimentApiKey: string | undefined;
  private readonly refreshMs: number;
  private readonly windowDays: number;
  private readonly now: () => Date;
  private cache = new Map<AssetId, { ctx: MarketContext; refreshedAt: Date }>();
  private inflight: Promise<void> | null = null;

  constructor(opts: MarketContextProviderOpts = {}) {
    this.santimentApiKey =
      opts.santimentApiKey ?? process.env.SANTIMENT_API_KEY?.trim();
    this.refreshMs = opts.refreshIntervalMs ?? 5 * 60 * 1000;
    this.windowDays = opts.windowDays ?? 30;
    this.now = opts.now ?? (() => new Date());
  }

  /** Returns a context, refreshing if cache is stale or empty. */
  async get(asset_id: AssetId): Promise<MarketContext> {
    const cached = this.cache.get(asset_id);
    const stale =
      !cached || this.now().getTime() - cached.refreshedAt.getTime() > this.refreshMs;
    if (stale) await this.refresh();
    const after = this.cache.get(asset_id);
    if (after) return after.ctx;
    return this.fallback(asset_id);
  }

  /** Force an immediate refresh; safe to call from cron. Single-flighted. */
  async refresh(): Promise<void> {
    if (this.inflight) return this.inflight;
    this.inflight = this.refreshOnce()
      .catch((err) => {
        console.warn("[market-context] refresh failed:", errorMessage(err));
      })
      .finally(() => {
        this.inflight = null;
      });
    return this.inflight;
  }

  private async refreshOnce(): Promise<void> {
    if (!this.santimentApiKey) {
      // No API key → seed neutral fallback so daemon stays alive in dev.
      for (const id of Object.keys(VERDICT_TO_SANTIMENT) as AssetId[]) {
        this.cache.set(id, { ctx: this.fallback(id), refreshedAt: this.now() });
      }
      return;
    }
    const slugs = Object.values(VERDICT_TO_SANTIMENT);
    const raw = await fetchUniverse({
      apiKey: this.santimentApiKey,
      windowDays: this.windowDays,
      assets: slugs,
    });
    const normalized = normalizeUniverse(raw);
    const scored = scoreUniverse(normalized);
    const at = this.now();
    for (const [verdictId, slug] of Object.entries(VERDICT_TO_SANTIMENT) as [
      AssetId,
      "ethereum",
    ][]) {
      const asset = scored.find((s) => s.slug === slug);
      const fetchedAt = raw.get(slug)?.fetchedAt;
      const freshnessSec =
        fetchedAt
          ? Math.max(0, Math.floor((at.getTime() - Date.parse(fetchedAt)) / 1000))
          : Math.floor(this.refreshMs / 1000);
      this.cache.set(verdictId, {
        ctx: this.contextFromScored(verdictId, asset, freshnessSec),
        refreshedAt: at,
      });
    }
  }

  private contextFromScored(
    asset_id: AssetId,
    asset: ScoredAsset | undefined,
    data_freshness_seconds: number,
  ): MarketContext {
    if (!asset) return this.fallback(asset_id, data_freshness_seconds);
    const composite = clamp(asset.compositeScore, -1, 1);
    return {
      asset_id,
      composite_score: composite,
      top_playbook: asset.topPlaybook,
      playbook_scores: asset.playbookScores.map((p) => ({
        playbook: p.playbook,
        score: p.score,
        confidence: p.confidence,
      })),
      regime: regimeFromComposite(composite),
      data_freshness_seconds,
    };
  }

  private fallback(asset_id: AssetId, freshness = 9999): MarketContext {
    return {
      asset_id,
      composite_score: 0,
      top_playbook: "early_narrative_breakout",
      playbook_scores: [],
      regime: "neutral",
      data_freshness_seconds: freshness,
    };
  }
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function regimeFromComposite(composite: number): MarketRegime {
  if (composite >= 0.2) return "bullish";
  if (composite <= -0.2) return "bearish";
  return "neutral";
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
